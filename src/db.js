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

    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      process_id INTEGER REFERENCES processes(id),
      description TEXT,
      minutes INTEGER NOT NULL,
      entry_date TEXT NOT NULL
    );
  `);

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) seed();
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

  const insertTask = db.prepare(
    `INSERT INTO tasks (title, due_date, done, user_id, process_id) VALUES (?, ?, ?, ?, ?)`
  );
  insertTask.run('Elaborar contestação — Proc. 5002210-05', '2026-08-06', 0, advId, 4);
  insertTask.run('Revisar cálculo de execução — Cond. Vista Alegre', '2026-08-07', 0, socioId, 3);
  insertTask.run('Enviar procuração para assinatura', '2026-08-08', 0, advId, null);
  insertTask.run('Protocolar recurso — Roberto Guimarães', '2026-08-05', 1, advId, 2);

  const insertEvent = db.prepare(`
    INSERT INTO agenda_events (title, detail, event_date, event_time, user_id, process_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertEvent.run('Audiência de instrução', 'Fórum Lafayette · Sala 4', '2026-08-06', '09:00', socioId, 1);
  insertEvent.run('Reunião com cliente', 'Cond. Vista Alegre · presencial', '2026-08-06', '11:30', socioId, 3);
  insertEvent.run('Protocolo de contestação', 'Prazo final às 23h59', '2026-08-06', '14:00', advId, 4);

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
