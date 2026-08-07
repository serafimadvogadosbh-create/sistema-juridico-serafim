// server.js — servidor HTTP puro (sem dependencias externas), pronto para Render.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const url = require('node:url');

const { db, init } = require('./src/db');
const { hashPassword, verifyPassword, newSessionToken } = require('./src/auth');
const perms = require('./src/permissions');
const google = require('./src/google');

init();

// estado CSRF do fluxo OAuth (curta duracao, nao precisa persistir em disco)
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.expires < now) oauthStates.delete(k);
}, 5 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------- helpers ----------
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) { reject(new Error('payload_too_large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function parsed_query(req) {
  return Object.fromEntries(new url.URL(req.url, 'http://localhost').searchParams);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies.sid;
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token, s.expires_at, u.id, u.name, u.email, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  if (!row.active) return null;
  return { token, id: row.id, name: row.name, email: row.email, role: row.role };
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'nao_autenticado' });
    return null;
  }
  return session;
}

// ---------- static files ----------
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- API ----------
async function handleApi(req, res, pathname, method) {
  // LOGIN
  if (pathname === '/api/login' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { email, password } = body || {};
    if (!email || !password) return sendJson(res, 400, { error: 'informe_email_e_senha' });
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email).toLowerCase().trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { error: 'credenciais_invalidas' });
    }
    const token = newSessionToken();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, user.id, Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token);
    return sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  }

  // LOGOUT
  if (pathname === '/api/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    if (cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.sid);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // A partir daqui, todas as rotas exigem sessao valida
  const session = requireAuth(req, res);
  if (!session) return;

  if (pathname === '/api/change-password' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { currentPassword, newPassword } = body || {};
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return sendJson(res, 400, { error: 'senha_invalida' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.id);
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return sendJson(res, 401, { error: 'senha_atual_incorreta' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), session.id);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, {
      user: { id: session.id, name: session.name, email: session.email, role: session.role },
      modules: perms.MODULES_BY_ROLE[session.role] || [],
    });
  }

  if (pathname === '/api/dashboard' && method === 'GET') {
    const all = perms.canSeeAllProcesses(session.role);
    const processesCount = all
      ? db.prepare(`SELECT COUNT(*) c FROM processes WHERE status != 'concluido'`).get().c
      : db.prepare(`SELECT COUNT(*) c FROM processes WHERE status != 'concluido' AND responsible_id = ?`).get(session.id).c;
    const deadlineSoon = all
      ? db.prepare(`SELECT COUNT(*) c FROM processes WHERE next_deadline BETWEEN date('now') AND date('now','+5 day')`).get().c
      : db.prepare(`SELECT COUNT(*) c FROM processes WHERE next_deadline BETWEEN date('now') AND date('now','+5 day') AND responsible_id = ?`).get(session.id).c;
    const tasksToday = db.prepare(`SELECT COUNT(*) c FROM agenda_events WHERE user_id = ? AND type = 'tarefa' AND status != 'concluido'`).get(session.id).c;
    // Faturamento do mes: recebido e a receber do MES CORRENTE apenas (nao o total
    // geral acumulado) — reseta automaticamente a cada novo mes, pois o filtro de
    // data e sempre relativo a data atual.
    let faturamentoMes = null;
    if (perms.canAccessFinanceiro(session.role)) {
      const recebidoMes = db.prepare(`
        SELECT COALESCE(SUM(amount_cents),0) c FROM invoices
        WHERE status = 'paga' AND due_date >= date('now','start of month') AND due_date < date('now','start of month','+1 month')
      `).get().c;
      const aReceberMes = db.prepare(`
        SELECT COALESCE(SUM(amount_cents),0) c FROM invoices
        WHERE status != 'paga' AND due_date >= date('now','start of month') AND due_date < date('now','start of month','+1 month')
      `).get().c;
      faturamentoMes = { recebido: recebidoMes, aReceber: aReceberMes };
    }
    const recentProcesses = db.prepare(`
      SELECT p.cnj_number, c.name as client_name, p.phase, p.next_deadline, p.status
      FROM processes p JOIN clients c ON c.id = p.client_id
      ${all ? '' : 'WHERE p.responsible_id = ?'}
      ORDER BY p.id DESC LIMIT 5
    `).all(...(all ? [] : [session.id]));
    return sendJson(res, 200, { processesCount, deadlineSoon, tasksToday, faturamentoMes, recentProcesses });
  }

  if (pathname === '/api/processos' && method === 'GET') {
    const all = perms.canSeeAllProcesses(session.role);
    const rows = db.prepare(`
      SELECT p.id, p.cnj_number, c.name as client_name, p.opposing_party, p.area, p.phase,
             p.next_deadline, p.status, u.name as responsible_name, p.responsible_id
      FROM processes p
      JOIN clients c ON c.id = p.client_id
      JOIN users u ON u.id = p.responsible_id
      ${all ? '' : 'WHERE p.responsible_id = ?'}
      ORDER BY p.next_deadline ASC
    `).all(...(all ? [] : [session.id]));
    return sendJson(res, 200, { processos: rows });
  }

  if (pathname === '/api/processos' && method === 'POST') {
    if (session.role === 'estagiario') return sendJson(res, 403, { error: 'sem_permissao' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { cnj_number, client_id, opposing_party, area, phase, next_deadline } = body || {};
    if (!cnj_number || !client_id) return sendJson(res, 400, { error: 'campos_obrigatorios' });
    const info = db.prepare(`
      INSERT INTO processes (cnj_number, client_id, opposing_party, area, phase, next_deadline, status, responsible_id)
      VALUES (?, ?, ?, ?, ?, ?, 'em_andamento', ?)
    `).run(cnj_number, client_id, opposing_party || '', area || '', phase || '', next_deadline || null, session.id);
    return sendJson(res, 201, { id: Number(info.lastInsertRowid) });
  }

  if (pathname === '/api/clientes' && method === 'GET') {
    const showArchived = parsed_query(req).arquivados === '1';
    const rows = db.prepare(`
      SELECT id, name, type, since, email, phone, archived_at FROM clients
      WHERE archived_at IS ${showArchived ? 'NOT' : ''} NULL
      ORDER BY name ASC
    `).all();
    return sendJson(res, 200, { clientes: rows });
  }

  if (pathname === '/api/google/documentos/gerar' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { client_id, tipo, objeto, valor_honorarios, forma_pagamento } = body || {};
    if (!client_id || !['procuracao', 'contrato'].includes(tipo)) {
      return sendJson(res, 400, { error: 'campos_obrigatorios' });
    }
    const cliente = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    if (!cliente) return sendJson(res, 404, { error: 'cliente_nao_encontrado' });
    try {
      const doc = await google.generateDocument(session.id, {
        tipo,
        cliente,
        advogadoNome: session.name,
        extra: { objeto, valor_honorarios, forma_pagamento },
      });
      const info = db.prepare(`
        INSERT INTO drive_files (client_id, google_file_id, name, mime_type, link, added_by)
        VALUES (?, ?, ?, 'application/vnd.google-apps.document', ?, ?)
      `).run(client_id, doc.id, doc.name, doc.webViewLink || '', session.id);
      const fileRowId = Number(info.lastInsertRowid);
      return sendJson(res, 201, {
        id: fileRowId,
        google_file_id: doc.id,
        name: doc.name,
        link: doc.webViewLink,
        pdfUrl: `/api/drive/files/${fileRowId}/pdf`,
      });
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes('google_nao_conectado')) return sendJson(res, 409, { error: 'google_nao_conectado' });
      console.error(e);
      return sendJson(res, 500, { error: 'falha_geracao', detail: msg });
    }
  }

  if (pathname === '/api/clientes' && method === 'POST') {
    if (session.role === 'estagiario') return sendJson(res, 403, { error: 'sem_permissao' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { name, type, email, phone } = body || {};
    if (!name || !type) return sendJson(res, 400, { error: 'campos_obrigatorios' });
    const info = db.prepare('INSERT INTO clients (name, type, since, owner_id, email, phone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, type, String(new Date().getFullYear()), session.id, email || null, phone || null);
    return sendJson(res, 201, { id: Number(info.lastInsertRowid) });
  }

  const clienteDetailMatch = pathname.match(/^\/api\/clientes\/(\d+)$/);
  if (clienteDetailMatch && method === 'GET') {
    const id = Number(clienteDetailMatch[1]);
    const cliente = db.prepare(`
      SELECT id, name, type, since, email, phone, cpf_cnpj, rg, endereco, estado_civil, profissao, archived_at
      FROM clients WHERE id = ?
    `).get(id);
    if (!cliente) return sendJson(res, 404, { error: 'nao_encontrado' });
    const processos = db.prepare(`
      SELECT p.id, p.cnj_number, p.phase, p.next_deadline, p.status, u.name as responsible_name
      FROM processes p JOIN users u ON u.id = p.responsible_id
      WHERE p.client_id = ? ORDER BY p.next_deadline ASC
    `).all(id);
    const arquivos = db.prepare(`
      SELECT id, google_file_id, name, mime_type, link, added_at FROM drive_files
      WHERE client_id = ? ORDER BY added_at DESC
    `).all(id);
    return sendJson(res, 200, { cliente, processos, arquivos });
  }

  const clienteUpdateMatch = pathname.match(/^\/api\/clientes\/(\d+)$/);
  if (clienteUpdateMatch && method === 'PATCH') {
    if (session.role === 'estagiario') return sendJson(res, 403, { error: 'sem_permissao' });
    const id = Number(clienteUpdateMatch[1]);
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { email, phone, cpf_cnpj, rg, endereco, estado_civil, profissao } = body || {};
    db.prepare(`
      UPDATE clients SET email = ?, phone = ?, cpf_cnpj = ?, rg = ?, endereco = ?, estado_civil = ?, profissao = ?
      WHERE id = ?
    `).run(email || null, phone || null, cpf_cnpj || null, rg || null, endereco || null, estado_civil || null, profissao || null, id);
    return sendJson(res, 200, { ok: true });
  }

  const clienteArchiveMatch = pathname.match(/^\/api\/clientes\/(\d+)\/arquivar$/);
  if (clienteArchiveMatch && method === 'PATCH') {
    if (session.role === 'estagiario') return sendJson(res, 403, { error: 'sem_permissao' });
    const id = Number(clienteArchiveMatch[1]);
    const cliente = db.prepare('SELECT id FROM clients WHERE id = ?').get(id);
    if (!cliente) return sendJson(res, 404, { error: 'nao_encontrado' });
    db.prepare(`UPDATE clients SET archived_at = datetime('now') WHERE id = ?`).run(id);
    return sendJson(res, 200, { ok: true });
  }

  const clienteRestoreMatch = pathname.match(/^\/api\/clientes\/(\d+)\/restaurar$/);
  if (clienteRestoreMatch && method === 'PATCH') {
    if (session.role === 'estagiario') return sendJson(res, 403, { error: 'sem_permissao' });
    const id = Number(clienteRestoreMatch[1]);
    const cliente = db.prepare('SELECT id FROM clients WHERE id = ?').get(id);
    if (!cliente) return sendJson(res, 404, { error: 'nao_encontrado' });
    db.prepare('UPDATE clients SET archived_at = NULL WHERE id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  const clienteDeleteMatch = pathname.match(/^\/api\/clientes\/(\d+)$/);
  if (clienteDeleteMatch && method === 'DELETE') {
    if (session.role !== 'socio') return sendJson(res, 403, { error: 'sem_permissao' });
    const id = Number(clienteDeleteMatch[1]);
    const cliente = db.prepare('SELECT id FROM clients WHERE id = ?').get(id);
    if (!cliente) return sendJson(res, 404, { error: 'nao_encontrado' });
    const processosCount = db.prepare('SELECT COUNT(*) c FROM processes WHERE client_id = ?').get(id).c;
    const invoicesCount = db.prepare('SELECT COUNT(*) c FROM invoices WHERE client_id = ?').get(id).c;
    if (processosCount > 0 || invoicesCount > 0) {
      return sendJson(res, 409, { error: 'cliente_possui_vinculos', processos: processosCount, faturas: invoicesCount });
    }
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  // ---------- Agenda & Tarefas: quadro Kanban (prazos, audiencias, tarefas, reunioes) ----------
  const AGENDA_TYPES = ['prazo', 'audiencia', 'tarefa', 'reuniao', 'outro'];
  const AGENDA_PRIORITIES = ['baixa', 'media', 'alta', 'urgente'];
  const AGENDA_STATUSES = ['a_fazer', 'em_andamento', 'concluido'];

  // Sincroniza (best-effort) um card do quadro com o Google Agenda do escritorio.
  // Usa sempre a conta Google conectada pelo escritorio (nao a do usuario que
  // criou o card), conforme o modelo de agenda unica adotado. Falhas de sync
  // (Google desconectado, token expirado etc.) nao impedem o card de ser salvo
  // localmente — apenas ficam registradas no log do servidor.
  async function syncAgendaEventToGoogle(row) {
    const googleUserId = google.getPrimaryConnectedUserId();
    if (!googleUserId) return null;
    const payload = {
      title: row.title,
      detail: row.detail,
      date: row.event_date,
      time: row.event_time || null,
      location: row.location,
      allDay: !row.event_time,
    };
    try {
      if (row.google_event_id) {
        await google.updateCalendarEvent(googleUserId, row.google_event_id, payload);
        return row.google_event_id;
      }
      return await google.createCalendarEvent(googleUserId, payload);
    } catch (e) {
      console.error('falha ao sincronizar com Google Agenda:', e.message || e);
      return row.google_event_id || null;
    }
  }

  if (pathname === '/api/agenda' && method === 'GET') {
    const all = session.role === 'socio';
    const rows = db.prepare(`
      SELECT a.id, a.title, a.detail, a.type, a.priority, a.status, a.event_date, a.event_time,
             a.location, a.client_id, cl.name AS client_name, a.process_id, a.google_event_id, a.user_id
      FROM agenda_events a
      LEFT JOIN clients cl ON cl.id = a.client_id
      ${all ? '' : 'WHERE a.user_id = ?'}
      ORDER BY a.event_date ASC, a.event_time ASC
    `).all(...(all ? [] : [session.id]));
    return sendJson(res, 200, { agenda: rows });
  }

  if (pathname === '/api/agenda' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { title, detail, type, priority, event_date, event_time, location, client_id, process_id } = body || {};
    if (!title || !event_date) return sendJson(res, 400, { error: 'campos_obrigatorios' });
    const finalType = AGENDA_TYPES.includes(type) ? type : 'tarefa';
    const finalPriority = AGENDA_PRIORITIES.includes(priority) ? priority : 'media';
    const info = db.prepare(`
      INSERT INTO agenda_events (title, detail, event_date, event_time, user_id, process_id, type, priority, status, client_id, location)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'a_fazer', ?, ?)
    `).run(title, detail || '', event_date, event_time || '', session.id, process_id || null, finalType, finalPriority, client_id || null, location || '');
    const id = Number(info.lastInsertRowid);
    const googleEventId = await syncAgendaEventToGoogle({ title, detail, event_date, event_time, location, google_event_id: null });
    if (googleEventId) db.prepare('UPDATE agenda_events SET google_event_id = ? WHERE id = ?').run(googleEventId, id);
    return sendJson(res, 201, { id, googleSynced: Boolean(googleEventId) });
  }

  const agendaStatusMatch = pathname.match(/^\/api\/agenda\/(\d+)\/status$/);
  if (agendaStatusMatch && method === 'PATCH') {
    const id = Number(agendaStatusMatch[1]);
    const row = db.prepare('SELECT * FROM agenda_events WHERE id = ?').get(id);
    if (!row || (row.user_id !== session.id && session.role !== 'socio')) return sendJson(res, 404, { error: 'nao_encontrado' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { status } = body || {};
    if (!AGENDA_STATUSES.includes(status)) return sendJson(res, 400, { error: 'status_invalido' });
    db.prepare('UPDATE agenda_events SET status = ? WHERE id = ?').run(status, id);
    return sendJson(res, 200, { ok: true });
  }

  const agendaUpdateMatch = pathname.match(/^\/api\/agenda\/(\d+)$/);
  if (agendaUpdateMatch && method === 'PATCH') {
    const id = Number(agendaUpdateMatch[1]);
    const row = db.prepare('SELECT * FROM agenda_events WHERE id = ?').get(id);
    if (!row || (row.user_id !== session.id && session.role !== 'socio')) return sendJson(res, 404, { error: 'nao_encontrado' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { title, detail, type, priority, event_date, event_time, location, client_id, process_id } = body || {};
    if (!title || !event_date) return sendJson(res, 400, { error: 'campos_obrigatorios' });
    const finalType = AGENDA_TYPES.includes(type) ? type : row.type;
    const finalPriority = AGENDA_PRIORITIES.includes(priority) ? priority : row.priority;
    db.prepare(`
      UPDATE agenda_events SET title = ?, detail = ?, event_date = ?, event_time = ?, type = ?, priority = ?, location = ?, client_id = ?, process_id = ?
      WHERE id = ?
    `).run(title, detail || '', event_date, event_time || '', finalType, finalPriority, location || '', client_id || null, process_id || null, id);
    const googleEventId = await syncAgendaEventToGoogle({ title, detail, event_date, event_time, location, google_event_id: row.google_event_id });
    if (googleEventId && googleEventId !== row.google_event_id) {
      db.prepare('UPDATE agenda_events SET google_event_id = ? WHERE id = ?').run(googleEventId, id);
    }
    return sendJson(res, 200, { ok: true });
  }

  const agendaDeleteMatch = pathname.match(/^\/api\/agenda\/(\d+)$/);
  if (agendaDeleteMatch && method === 'DELETE') {
    const id = Number(agendaDeleteMatch[1]);
    const row = db.prepare('SELECT * FROM agenda_events WHERE id = ?').get(id);
    if (!row || (row.user_id !== session.id && session.role !== 'socio')) return sendJson(res, 404, { error: 'nao_encontrado' });
    if (row.google_event_id) {
      const googleUserId = google.getPrimaryConnectedUserId();
      if (googleUserId) {
        try { await google.deleteCalendarEvent(googleUserId, row.google_event_id); }
        catch (e) { console.error('falha ao remover evento do Google Agenda:', e.message || e); }
      }
    }
    db.prepare('DELETE FROM agenda_events WHERE id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  // Faturas/parcelas: status guardado no banco normalmente e 'aberta' ou 'paga'.
  // "Atrasada" e calculado na hora (aberta + vencimento no passado), sem precisar de
  // job agendado — mas tambem aceitamos o literal 'atrasada' gravado por dados antigos.
  const OVERDUE_CASE = `CASE WHEN i.status != 'paga' AND i.due_date < date('now') THEN 'atrasada' WHEN i.status = 'atrasada' THEN 'aberta' ELSE i.status END`;

  if (pathname === '/api/financeiro' && method === 'GET') {
    if (!perms.canAccessFinanceiro(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    // Recebido/A receber dos cards do topo sao sempre do MES CORRENTE (nao o total
    // geral acumulado) — proximo mes esses numeros voltam a zero automaticamente,
    // pois o filtro e relativo a data('now'). "Em atraso" continua valendo para
    // qualquer mes, ja que uma parcela vencida nao deixa de ser urgente so porque
    // o mes virou.
    const recebido = db.prepare(`
      SELECT COALESCE(SUM(amount_cents),0) c FROM invoices
      WHERE status = 'paga' AND due_date >= date('now','start of month') AND due_date < date('now','start of month','+1 month')
    `).get().c;
    const aReceber = db.prepare(`
      SELECT COALESCE(SUM(amount_cents),0) c FROM invoices
      WHERE status != 'paga' AND due_date >= date('now','start of month') AND due_date < date('now','start of month','+1 month')
    `).get().c;
    const atrasado = db.prepare(`
      SELECT COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status != 'paga' AND due_date < date('now')
    `).get().c;
    const faturas = db.prepare(`
      SELECT i.id, c.name as client_name, ct.title as contract_title, i.amount_cents, i.due_date,
             ${OVERDUE_CASE} as status
      FROM invoices i JOIN clients c ON c.id = i.client_id
      LEFT JOIN contracts ct ON ct.id = i.contract_id
      ORDER BY i.due_date ASC
    `).all();
    // Recebido/a receber/em atraso agrupados por mes de vencimento (strftime %Y-%m),
    // para o usuario acompanhar o fluxo mes a mes (agosto, setembro, outubro...).
    // A partir de 01/08/2026 (data de corte combinada) — parcelas anteriores a essa
    // data (dados legados/teste) ficam de fora tanto da tabela mensal quanto do total geral.
    const CUTOFF_DATE = '2026-08-01';
    const porMes = db.prepare(`
      SELECT strftime('%Y-%m', due_date) as mes,
        COALESCE(SUM(CASE WHEN status = 'paga' THEN amount_cents ELSE 0 END), 0) as recebido,
        COALESCE(SUM(CASE WHEN status != 'paga' AND due_date >= date('now') THEN amount_cents ELSE 0 END), 0) as aReceber,
        COALESCE(SUM(CASE WHEN status != 'paga' AND due_date < date('now') THEN amount_cents ELSE 0 END), 0) as atrasado
      FROM invoices
      WHERE due_date IS NOT NULL AND due_date >= ?
      GROUP BY mes
      ORDER BY mes ASC
    `).all(CUTOFF_DATE);
    // Total geral: soma de tudo a partir da data de corte (nao e mais o total
    // acumulado desde sempre, e sim desde 01/08/2026), exibido ao final da tabela.
    const totalGeral = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paga' THEN amount_cents ELSE 0 END), 0) as recebido,
        COALESCE(SUM(CASE WHEN status != 'paga' AND due_date >= date('now') THEN amount_cents ELSE 0 END), 0) as aReceber,
        COALESCE(SUM(CASE WHEN status != 'paga' AND due_date < date('now') THEN amount_cents ELSE 0 END), 0) as atrasado
      FROM invoices
      WHERE due_date IS NOT NULL AND due_date >= ?
    `).get(CUTOFF_DATE);
    return sendJson(res, 200, { recebido, aReceber, atrasado, faturas, porMes, totalGeral, cutoffDate: CUTOFF_DATE });
  }

  // CONTRATOS (honorarios) — cadastro manual, com geracao automatica das parcelas
  if (pathname === '/api/contracts' && method === 'GET') {
    if (!perms.canAccessFinanceiro(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    const rows = db.prepare(`
      SELECT ct.id, ct.title, ct.fee_type, ct.total_amount_cents, ct.installments_count, ct.status,
             ct.notes, ct.created_at, c.name as client_name, c.id as client_id,
             p.cnj_number as process_cnj,
             (SELECT COUNT(*) FROM invoices i WHERE i.contract_id = ct.id AND i.status = 'paga') as paid_count,
             (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.contract_id = ct.id AND i.status = 'paga') as paid_cents
      FROM contracts ct
      JOIN clients c ON c.id = ct.client_id
      LEFT JOIN processes p ON p.id = ct.process_id
      ORDER BY ct.created_at DESC
    `).all();
    return sendJson(res, 200, { contracts: rows });
  }

  if (pathname === '/api/contracts' && method === 'POST') {
    if (!perms.canAccessFinanceiro(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { client_id, process_id, title, fee_type, total_amount_cents, installments_count, first_due_date, notes } = body || {};
    const n = Number(installments_count) || 1;
    if (!client_id || !title || !total_amount_cents || total_amount_cents <= 0 || !first_due_date || n < 1) {
      return sendJson(res, 400, { error: 'dados_invalidos' });
    }
    const validFee = ['fixo', 'parcelado', 'mensal', 'exito'].includes(fee_type) ? fee_type : 'parcelado';
    const info = db.prepare(`
      INSERT INTO contracts (client_id, process_id, title, fee_type, total_amount_cents, installments_count, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(client_id, process_id || null, title, validFee, Math.round(total_amount_cents), n, notes || '', session.id);
    const contractId = Number(info.lastInsertRowid);

    // Divide o valor total em N parcelas iguais; a ultima absorve o resto de
    // arredondamento (em centavos) para o somatorio bater certinho com o total.
    const base = Math.floor(total_amount_cents / n);
    const resto = total_amount_cents - base * n;
    const insertInvoice = db.prepare(`INSERT INTO invoices (client_id, amount_cents, due_date, status, contract_id) VALUES (?, ?, ?, 'aberta', ?)`);
    const [y0, m0, d0] = first_due_date.split('-').map(Number);
    for (let i = 0; i < n; i++) {
      const amount = base + (i === n - 1 ? resto : 0);
      const dt = new Date(Date.UTC(y0, m0 - 1 + i, d0));
      const dueDate = dt.toISOString().slice(0, 10);
      insertInvoice.run(client_id, amount, dueDate, contractId);
    }
    return sendJson(res, 201, { id: contractId });
  }

  const contractDeleteMatch = pathname.match(/^\/api\/contracts\/(\d+)$/);
  if (contractDeleteMatch && method === 'DELETE') {
    if (!perms.canAccessFinanceiro(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    const id = Number(contractDeleteMatch[1]);
    const paidCount = db.prepare(`SELECT COUNT(*) c FROM invoices WHERE contract_id = ? AND status = 'paga'`).get(id).c;
    if (paidCount > 0) return sendJson(res, 409, { error: 'contrato_com_parcelas_pagas' });
    db.prepare('DELETE FROM invoices WHERE contract_id = ?').run(id);
    db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  // Marca/desmarca uma parcela (fatura) como paga
  const invoiceStatusMatch = pathname.match(/^\/api\/invoices\/(\d+)\/status$/);
  if (invoiceStatusMatch && method === 'PATCH') {
    if (!perms.canAccessFinanceiro(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    const id = Number(invoiceStatusMatch[1]);
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const status = body && body.status === 'paga' ? 'paga' : 'aberta';
    const info = db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
    if (info.changes === 0) return sendJson(res, 404, { error: 'nao_encontrado' });
    // Se todas as parcelas de um contrato estiverem pagas, marca o contrato como quitado.
    const row = db.prepare('SELECT contract_id FROM invoices WHERE id = ?').get(id);
    if (row && row.contract_id) {
      const pend = db.prepare(`SELECT COUNT(*) c FROM invoices WHERE contract_id = ? AND status != 'paga'`).get(row.contract_id).c;
      db.prepare(`UPDATE contracts SET status = ? WHERE id = ? AND status != 'cancelado'`)
        .run(pend === 0 ? 'quitado' : 'ativo', row.contract_id);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/timesheet' && method === 'GET') {
    const all = session.role === 'socio';
    const rows = db.prepare(`
      SELECT t.id, t.entry_date, t.description, t.minutes, u.name as user_name
      FROM timesheet_entries t JOIN users u ON u.id = t.user_id
      ${all ? '' : 'WHERE t.user_id = ?'}
      ORDER BY t.entry_date DESC
    `).all(...(all ? [] : [session.id]));
    return sendJson(res, 200, { timesheet: rows });
  }

  if (pathname === '/api/timesheet' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { description, minutes, process_id } = body || {};
    if (!minutes) return sendJson(res, 400, { error: 'duracao_obrigatoria' });
    const info = db.prepare(`
      INSERT INTO timesheet_entries (user_id, process_id, description, minutes, entry_date)
      VALUES (?, ?, ?, ?, date('now'))
    `).run(session.id, process_id || null, description || '', minutes);
    return sendJson(res, 201, { id: Number(info.lastInsertRowid) });
  }

  if (pathname === '/api/usuarios' && method === 'GET') {
    if (!perms.canManageUsers(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    const rows = db.prepare('SELECT id, name, email, role, active FROM users ORDER BY name ASC').all();
    return sendJson(res, 200, { usuarios: rows });
  }

  if (pathname === '/api/usuarios' && method === 'POST') {
    if (!perms.canManageUsers(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { name, email, password, role } = body || {};
    if (!name || !email || !password || !['socio', 'advogado', 'estagiario'].includes(role)) {
      return sendJson(res, 400, { error: 'campos_obrigatorios' });
    }
    if (password.length < 8) return sendJson(res, 400, { error: 'senha_curta' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
    if (existing) return sendJson(res, 409, { error: 'email_ja_cadastrado' });
    const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, String(email).toLowerCase().trim(), hashPassword(password), role);
    return sendJson(res, 201, { id: Number(info.lastInsertRowid) });
  }

  const processoDetailMatch = pathname.match(/^\/api\/processos\/(\d+)$/);
  if (processoDetailMatch && method === 'GET') {
    const id = Number(processoDetailMatch[1]);
    const processo = db.prepare(`
      SELECT p.*, c.name as client_name, c.email as client_email, u.name as responsible_name
      FROM processes p JOIN clients c ON c.id = p.client_id JOIN users u ON u.id = p.responsible_id
      WHERE p.id = ?
    `).get(id);
    if (!processo) return sendJson(res, 404, { error: 'nao_encontrado' });
    if (!perms.canSeeAllProcesses(session.role) && processo.responsible_id !== session.id) {
      return sendJson(res, 403, { error: 'sem_permissao' });
    }
    const arquivos = db.prepare(`
      SELECT id, google_file_id, name, mime_type, link, added_at FROM drive_files
      WHERE process_id = ? ORDER BY added_at DESC
    `).all(id);
    return sendJson(res, 200, { processo, arquivos });
  }

  // ---------- Google: status / conexao ----------
  if (pathname === '/api/google/status' && method === 'GET') {
    const row = google.getStoredTokens(session.id);
    return sendJson(res, 200, {
      configured: google.isConfigured(),
      connected: Boolean(row),
      email: row ? row.google_email : null,
    });
  }

  if (pathname === '/api/google/disconnect' && method === 'POST') {
    google.disconnect(session.id);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/google/picker-token' && method === 'GET') {
    try {
      const accessToken = await google.getValidAccessToken(session.id);
      if (!accessToken) return sendJson(res, 409, { error: 'google_nao_conectado' });
      return sendJson(res, 200, { accessToken, apiKey: process.env.GOOGLE_PICKER_API_KEY || '', clientId: process.env.GOOGLE_CLIENT_ID || '' });
    } catch (e) {
      return sendJson(res, 500, { error: 'falha_google', detail: String(e.message || e) });
    }
  }

  // ---------- Gmail ----------
  if (pathname === '/api/gmail/send' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { client_id, subject, body: text } = body || {};
    const cliente = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    if (!cliente || !cliente.email) return sendJson(res, 400, { error: 'cliente_sem_email' });
    try {
      await google.sendEmail(session.id, { to: cliente.email, subject, body: text });
      db.prepare(`
        INSERT INTO email_log (client_id, subject, snippet, from_addr, to_addr, email_date, direction, synced_by)
        VALUES (?, ?, ?, ?, ?, datetime('now'), 'enviado', ?)
      `).run(client_id, subject, (text || '').slice(0, 200), session.email, cliente.email, session.id);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes('google_nao_conectado')) return sendJson(res, 409, { error: 'google_nao_conectado' });
      return sendJson(res, 500, { error: 'falha_envio', detail: msg });
    }
  }

  if (pathname === '/api/gmail/log' && method === 'GET') {
    const clientId = Number(parsed_query(req).client_id);
    if (!clientId) return sendJson(res, 400, { error: 'client_id_obrigatorio' });
    const cliente = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!cliente) return sendJson(res, 404, { error: 'nao_encontrado' });
    if (!cliente.email) return sendJson(res, 200, { emails: [], aviso: 'cliente_sem_email' });
    try {
      const emails = await google.searchEmails(session.id, cliente.email);
      const insert = db.prepare(`
        INSERT OR IGNORE INTO email_log (client_id, gmail_message_id, subject, snippet, from_addr, to_addr, email_date, direction, synced_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of emails) {
        const direction = (m.from || '').toLowerCase().includes(cliente.email.toLowerCase()) ? 'recebido' : 'enviado';
        insert.run(clientId, m.id, m.subject, m.snippet, m.from, m.to, m.date, direction, session.id);
      }
      return sendJson(res, 200, { emails });
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes('google_nao_conectado')) return sendJson(res, 409, { error: 'google_nao_conectado' });
      return sendJson(res, 500, { error: 'falha_busca', detail: msg });
    }
  }

  // ---------- Drive ----------
  if (pathname === '/api/drive/attach' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'json_invalido' }); }
    const { process_id, client_id, google_file_id, name, mime_type, link } = body || {};
    if (!google_file_id || !name || (!process_id && !client_id)) {
      return sendJson(res, 400, { error: 'campos_obrigatorios' });
    }
    const info = db.prepare(`
      INSERT INTO drive_files (process_id, client_id, google_file_id, name, mime_type, link, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(process_id || null, client_id || null, google_file_id, name, mime_type || '', link || '', session.id);
    return sendJson(res, 201, { id: Number(info.lastInsertRowid) });
  }

  const driveDeleteMatch = pathname.match(/^\/api\/drive\/files\/(\d+)$/);
  if (driveDeleteMatch && method === 'DELETE') {
    db.prepare('DELETE FROM drive_files WHERE id = ?').run(Number(driveDeleteMatch[1]));
    return sendJson(res, 200, { ok: true });
  }

  // Exporta um documento gerado (Google Doc) como PDF para download direto,
  // sem que o usuario precise abrir o Google Drive.
  const drivePdfMatch = pathname.match(/^\/api\/drive\/files\/(\d+)\/pdf$/);
  if (drivePdfMatch && method === 'GET') {
    const id = Number(drivePdfMatch[1]);
    const row = db.prepare('SELECT * FROM drive_files WHERE id = ?').get(id);
    if (!row) return sendJson(res, 404, { error: 'nao_encontrado' });
    try {
      const buffer = await google.exportPdf(session.id, row.google_file_id);
      const safeName = String(row.name || 'documento').replace(/["\r\n]/g, '');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeName}.pdf"; filename*=UTF-8''${encodeURIComponent(safeName)}.pdf`,
      });
      return res.end(buffer);
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes('google_nao_conectado')) return sendJson(res, 409, { error: 'google_nao_conectado' });
      console.error(e);
      return sendJson(res, 500, { error: 'falha_exportar_pdf', detail: msg });
    }
  }

  const deactivateMatch = pathname.match(/^\/api\/usuarios\/(\d+)\/desativar$/);
  if (deactivateMatch && method === 'PATCH') {
    if (!perms.canManageUsers(session.role)) return sendJson(res, 403, { error: 'sem_permissao' });
    const id = Number(deactivateMatch[1]);
    if (id === session.id) return sendJson(res, 400, { error: 'nao_pode_desativar_a_si_mesmo' });
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'rota_nao_encontrada' });
}

// ---------- router principal ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);
  const method = req.method;

  try {
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname, method);
    }

    if (pathname === '/auth/google/connect') {
      const session = getSession(req);
      if (!session) { res.writeHead(302, { Location: '/' }); return res.end(); }
      if (!google.isConfigured()) {
        res.writeHead(302, { Location: '/app?google_erro=nao_configurado' });
        return res.end();
      }
      const state = newSessionToken();
      oauthStates.set(state, { userId: session.id, expires: Date.now() + 10 * 60 * 1000 });
      res.writeHead(302, { Location: google.buildAuthUrl(state) });
      return res.end();
    }

    if (pathname === '/auth/google/callback') {
      const q = parsed_query(req);
      const stateEntry = q.state ? oauthStates.get(q.state) : null;
      if (!stateEntry || stateEntry.expires < Date.now()) {
        res.writeHead(302, { Location: '/app?google_erro=estado_invalido' });
        return res.end();
      }
      oauthStates.delete(q.state);
      if (q.error || !q.code) {
        res.writeHead(302, { Location: '/app?google_erro=' + encodeURIComponent(q.error || 'sem_codigo') });
        return res.end();
      }
      try {
        const tokens = await google.exchangeCode(q.code);
        const userinfo = await google.fetchUserInfo(tokens.access_token);
        google.saveTokens(stateEntry.userId, tokens, userinfo.email);
        res.writeHead(302, { Location: '/app?google_conectado=1' });
        return res.end();
      } catch (e) {
        console.error(e);
        res.writeHead(302, { Location: '/app?google_erro=falha_conexao' });
        return res.end();
      }
    }

    if (pathname === '/app' || pathname === '/app.html') {
      const session = getSession(req);
      if (!session) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return serveStatic(req, res, 'app.html');
    }

    if (pathname === '/' || pathname === '/login.html') {
      const session = getSession(req);
      if (session) { res.writeHead(302, { Location: '/app' }); return res.end(); }
      return serveStatic(req, res, 'login.html');
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'erro_interno' });
  }
});

// limpeza periodica de sessoes expiradas
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Sistema juridico rodando em http://localhost:${PORT}`);
});
