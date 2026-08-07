// db.js — camada de banco de dados (SQLite embutido no Node, sem dependencias externas)
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_PATH);
// journal_mode DELETE (padrao) e mais compativel entre sistemas de arquivos do que WAL,
// que exige memoria compartilhada e pode falhar em alguns discos de rede.
db.exec('PRAGMA foreign_keys = ON;');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('socio','advogado','estagiario')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('PF','PJ')),
      since TEXT,
      owner_id INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnj_number TEXT NOT NULL,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      opposing_party TEXT,
      area TEXT,
      phase TEXT,
      next_deadline TEXT,
      status TEXT NOT NULL DEFAULT 'em_andamento',
      responsible_id INTEGER NOT NULL REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      due_date TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL REFERENCES users(id),
      process_id INTEGER REFERENCES processes(id)
    );

    CREATE TABLE IF NOT EXISTS agenda_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      detail TEXT,
      event_date TEXT NOT NULL,
      event_time TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      process_id INTEGER REFERENCES processes(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      amount_cents INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberta'
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      process_id INTEGER REFERENCES processes(id),
      title TEXT NOT NULL,
      fee_type TEXT NOT NULL DEFAULT 'parcelado' CHECK(fee_type IN ('fixo','parcelado','mensal','exito')),
      total_amount_cents INTEGER NOT NULL,
      installments_count INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'ativo' CHECK(status IN ('ativo','quitado','cancelado')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      process_id INTEGER REFERENCES processes(id),
      description TEXT,
      minutes INTEGER NOT NULL,
      entry_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'google',
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER NOT NULL,
      scope TEXT,
      google_email TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      gmail_message_id TEXT,
      subject TEXT,
      snippet TEXT,
      from_addr TEXT,
      to_addr TEXT,
      email_date TEXT,
      direction TEXT,
      synced_by INTEGER REFERENCES users(id),
      UNIQUE(client_id, gmail_message_id)
    );

    CREATE TABLE IF NOT EXISTS drive_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_id INTEGER REFERENCES processes(id) ON DELETE CASCADE,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      google_file_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT,
      link TEXT,
      added_by INTEGER REFERENCES users(id),
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  migrate();

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) seed();
}

// Adiciona colunas novas a bancos ja existentes (SQLite nao suporta
// "ADD COLUMN IF NOT EXISTS", entao checamos o schema antes).
function migrate() {
  const cols = db.prepare(`PRAGMA table_info(clients)`).all().map((c) => c.name);
  if (!cols.includes('email')) db.exec('ALTER TABLE clients ADD COLUMN email TEXT');
  if (!cols.includes('phone')) db.exec('ALTER TABLE clients ADD COLUMN phone TEXT');
  if (!cols.includes('cpf_cnpj')) db.exec('ALTER TABLE clients ADD COLUMN cpf_cnpj TEXT');
  if (!cols.includes('rg')) db.exec('ALTER TABLE clients ADD COLUMN rg TEXT');
  if (!cols.includes('endereco')) db.exec('ALTER TABLE clients ADD COLUMN endereco TEXT');
  if (!cols.includes('estado_civil')) db.exec('ALTER TABLE clients ADD COLUMN estado_civil TEXT');
  if (!cols.includes('profissao')) db.exec('ALTER TABLE clients ADD COLUMN profissao TEXT');
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE clients ADD COLUMN archived_at TEXT');

  // Quadro Kanban de Agenda & Tarefas: tipo (prazo/audiencia/tarefa/reuniao/outro),
  // prioridade, status da coluna, cliente vinculado, local e id do evento espelhado
  // no Google Agenda. Roda uma unica vez (checagem da coluna 'type').
  const agendaCols = db.prepare(`PRAGMA table_info(agenda_events)`).all().map((c) => c.name);
  if (!agendaCols.includes('type')) {
    db.exec(`ALTER TABLE agenda_events ADD COLUMN type TEXT NOT NULL DEFAULT 'tarefa'`);
    db.exec(`ALTER TABLE agenda_events ADD COLUMN priority TEXT NOT NULL DEFAULT 'media'`);
    db.exec(`ALTER TABLE agenda_events ADD COLUMN status TEXT NOT NULL DEFAULT 'a_fazer'`);
    db.exec(`ALTER TABLE agenda_events ADD COLUMN client_id INTEGER REFERENCES clients(id)`);
    db.exec(`ALTER TABLE agenda_events ADD COLUMN location TEXT`);
    db.exec(`ALTER TABLE agenda_events ADD COLUMN google_event_id TEXT`);
    // Compromissos ja existentes tinham data+hora fixas: tratamos como "audiencia" por padrao.
    db.exec(`UPDATE agenda_events SET type = 'audiencia'`);

    // Migra as tarefas simples (tabela legada "tasks") para o quadro unificado,
    // preservando o titulo, prazo e status de conclusao.
    const oldTasks = db.prepare('SELECT * FROM tasks').all();
    const insertMigrated = db.prepare(`
      INSERT INTO agenda_events (title, detail, event_date, event_time, user_id, process_id, type, priority, status)
      VALUES (?, '', ?, '', ?, ?, 'tarefa', 'media', ?)
    `);
    const today = new Date().toISOString().slice(0, 10);
    for (const t of oldTasks) {
      insertMigrated.run(t.title, t.due_date || today, t.user_id, t.process_id, t.done ? 'concluido' : 'a_fazer');
    }
  }

  // Contratos com parcelas: liga cada fatura/parcela ao contrato que a gerou.
  // Faturas antigas (avulsas, sem contrato) continuam funcionando com contract_id nulo.
  const invoiceCols = db.prepare(`PRAGMA table_info(invoices)`).all().map((c) => c.name);
  if (!invoiceCols.includes('contract_id')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN contract_id INTEGER REFERENCES contracts(id)`);
  }
}

function seed() {
  const insertUser = db.prepare(
    `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`
  );
  const seedUsers = [
    ['Douglas Serafim', 'serafimadvogados.bh@gmail.com', 'Trocar@123', 'socio'],
    ['Camila Duarte', 'camila@serafimadvogados.com.br', 'Trocar@123', 'advogado'],
    ['Pedro Alves', 'pedro@serafimadvogados.com.br', 'Trocar@123', 'estagiario'],
  ];
  const ids = {};
  for (const [name, email, pass, role] of seedUsers) {
    const info = insertUser.run(name, email, hashPassword(pass), role);
    ids[email] = Number(info.lastInsertRowid);
  }

  const insertClient = db.prepare(
    `INSERT INTO clients (name, type, since, owner_id) VALUES (?, ?, ?, ?)`
  );
  const socioId = ids['serafimadvogados.bh@gmail.com'];
  const advId = ids['camila@serafimadvogados.com.br'];
  const c1 = Number(insertClient.run('Marta Ind. Ltda.', 'PJ', '2021', socioId).lastInsertRowid);
  const c2 = Number(insertClient.run('Roberto Guimarães', 'PF', '2023', advId).lastInsertRowid);
  const c3 = Number(insertClient.run('Cond. Vista Alegre', 'PJ', '2024', socioId).lastInsertRowid);
  const c4 = Number(insertClient.run('Ana Paula Reis', 'PF', '2025', advId).lastInsertRowid);

  const insertProcess = db.prepare(`
    INSERT INTO processes (cnj_number, client_id, opposing_party, area, phase, next_deadline, status, responsible_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProcess.run('5001234-12.2025.8.13.0024', c1, 'União Federal', 'Tributário', 'Instrução', '2026-08-12', 'prazo_proximo', socioId);
  insertProcess.run('5004521-88.2024.8.13.0024', c2, 'Banco Mineiro S.A.', 'Cível', 'Recursal', '2026-08-20', 'em_andamento', advId);
  insertProcess.run('5009981-40.2025.8.13.0024', c3, 'Construtora Aliança', 'Cível', 'Execução', '2026-08-09', 'urgente', socioId);
  insertProcess.run('5002210-05.2026.8.13.0024', c4, 'Seguradora Ipê', 'Consumidor', 'Conhecimento', '2026-08-28', 'em_andamento', advId);

  // Quadro Kanban de Agenda & Tarefas: dados de exemplo ja inseridos direto no
  // formato novo (type/priority/status/location), sem passar pela tabela legada
  // "tasks" — essa tabela fica apenas para compatibilidade com bancos antigos.
  const insertCard = db.prepare(`
    INSERT INTO agenda_events (title, detail, event_date, event_time, user_id, process_id, type, priority, status, location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCard.run('Audiência de instrução', '', '2026-08-06', '09:00', socioId, 1, 'audiencia', 'alta', 'a_fazer', 'Fórum Lafayette · Sala 4');
  insertCard.run('Reunião com cliente', 'Reunião presencial para alinhar estratégia processual.', '2026-08-06', '11:30', socioId, 3, 'reuniao', 'media', 'a_fazer', 'Cond. Vista Alegre');
  insertCard.run('Protocolo de contestação', 'Prazo final às 23h59.', '2026-08-06', '14:00', advId, 4, 'prazo', 'urgente', 'a_fazer', '');
  insertCard.run('Elaborar contestação — Proc. 5002210-05', '', '2026-08-06', '', advId, 4, 'tarefa', 'alta', 'a_fazer', '');
  insertCard.run('Revisar cálculo de execução — Cond. Vista Alegre', '', '2026-08-07', '', socioId, 3, 'tarefa', 'media', 'a_fazer', '');
  insertCard.run('Enviar procuração para assinatura', '', '2026-08-08', '', advId, null, 'tarefa', 'media', 'a_fazer', '');
  insertCard.run('Protocolar recurso — Roberto Guimarães', '', '2026-08-05', '', advId, 2, 'tarefa', 'baixa', 'concluido', '');

  const insertInvoice = db.prepare(
    `INSERT INTO invoices (client_id, amount_cents, due_date, status) VALUES (?, ?, ?, ?)`
  );
  insertInvoice.run(c1, 650000, '2026-08-15', 'aberta');
  insertInvoice.run(c2, 210000, '2026-08-08', 'aberta');
  insertInvoice.run(c3, 480000, '2026-07-30', 'atrasada');

  const insertTs = db.prepare(`
    INSERT INTO timesheet_entries (user_id, process_id, description, minutes, entry_date)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertTs.run(socioId, 1, 'Elaboração de petição', 80, '2026-08-06');
  insertTs.run(advId, 4, 'Análise de contrato', 45, '2026-08-06');

  console.log('Banco inicializado com dados de exemplo. Troque as senhas padrão apos o primeiro acesso.');
}

module.exports = { db, init };
