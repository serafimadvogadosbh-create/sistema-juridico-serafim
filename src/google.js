// google.js — integração com Google OAuth2, Gmail API e Drive API.
// Implementado só com fetch nativo do Node (sem dependências externas: o registro
// npm não está disponível no ambiente de build usado para testar este projeto).
'use strict';
const { db } = require('./db');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error('token_exchange_failed: ' + (await res.text()));
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('token_refresh_failed: ' + (await res.text()));
  return res.json();
}

function saveTokens(userId, tokens, googleEmail) {
  const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
  const existing = db.prepare(`SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = 'google'`).get(userId);
  if (existing) {
    db.prepare(`
      UPDATE oauth_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
        expires_at = ?, scope = ?, google_email = COALESCE(?, google_email), updated_at = datetime('now')
      WHERE user_id = ? AND provider = 'google'
    `).run(tokens.access_token, tokens.refresh_token || null, expiresAt, tokens.scope || '', googleEmail || null, userId);
  } else {
    db.prepare(`
      INSERT INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scope, google_email)
      VALUES (?, 'google', ?, ?, ?, ?, ?)
    `).run(userId, tokens.access_token, tokens.refresh_token || null, expiresAt, tokens.scope || '', googleEmail || null);
  }
}

function getStoredTokens(userId) {
  return db.prepare(`SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = 'google'`).get(userId);
}

function disconnect(userId) {
  db.prepare(`DELETE FROM oauth_tokens WHERE user_id = ? AND provider = 'google'`).run(userId);
}

// Retorna um access_token valido, renovando via refresh_token se necessario.
async function getValidAccessToken(userId) {
  const row = getStoredTokens(userId);
  if (!row) return null;
  if (row.expires_at - 60000 > Date.now()) return row.access_token;
  if (!row.refresh_token) return null;
  const tokens = await refreshAccessToken(row.refresh_token);
  saveTokens(userId, tokens, row.google_email);
  return tokens.access_token;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('userinfo_failed');
  return res.json();
}

// ---------- Gmail ----------
function toBase64Url(str) {
  return Buffer.from(str, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail(userId, { to, subject, body }) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('google_nao_conectado');
  const raw = toBase64Url(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  );
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error('gmail_send_failed: ' + (await res.text()));
  return res.json();
}

async function searchEmails(userId, clientEmail) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('google_nao_conectado');
  const q = encodeURIComponent(`from:${clientEmail} OR to:${clientEmail}`);
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=15`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error('gmail_list_failed: ' + (await listRes.text()));
  const list = await listRes.json();
  const messages = list.messages || [];
  const details = [];
  for (const m of messages) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) continue;
    const msg = await r.json();
    const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name, h.value]));
    details.push({
      id: msg.id,
      subject: headers.Subject || '(sem assunto)',
      from: headers.From || '',
      to: headers.To || '',
      date: headers.Date || '',
      snippet: msg.snippet || '',
    });
  }
  return details;
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  exchangeCode,
  saveTokens,
  getStoredTokens,
  disconnect,
  getValidAccessToken,
  fetchUserInfo,
  sendEmail,
  searchEmails,
};
