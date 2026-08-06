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
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// Dados do escritorio usados para preencher procuracao/contrato.
// Podem ser sobrescritos via variaveis de ambiente no Render.
const ESCRITORIO = {
  nome: process.env.ESCRITORIO_NOME || 'Serafim Advogados',
  oabUf: process.env.ESCRITORIO_OAB_UF || 'MG',
  oabNumero: process.env.ESCRITORIO_OAB_NUMERO || '196.089',
  endereco: process.env.ESCRITORIO_ENDERECO || '[endereço do escritório — preencher]',
  cidade: process.env.ESCRITORIO_CIDADE || 'Belo Horizonte/MG',
};

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

// ---------- Configuracoes persistidas (ids de pasta/modelos) ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// ---------- Geracao de documentos (Procuracao / Contrato) ----------
async function driveRequest(accessToken, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error('drive_api_failed: ' + (await res.text()));
  return res.json();
}

async function findFolderByName(accessToken, name) {
  const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const data = await driveRequest(accessToken, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  return (data.files && data.files[0]) || null;
}

async function createFolder(accessToken, name) {
  return driveRequest(accessToken, 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
}

async function ensureFolder(accessToken, settingKey, folderName) {
  const cached = getSetting(settingKey);
  if (cached) return cached;
  const existing = await findFolderByName(accessToken, folderName);
  const folder = existing || (await createFolder(accessToken, folderName));
  setSetting(settingKey, folder.id);
  return folder.id;
}

async function createDocInFolder(accessToken, title, bodyText, folderId) {
  const doc = await fetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((r) => { if (!r.ok) throw new Error('docs_create_failed'); return r.json(); });

  await fetch(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: bodyText } }] }),
  }).then((r) => { if (!r.ok) throw new Error('docs_fill_failed'); });

  await driveRequest(accessToken, `https://www.googleapis.com/drive/v3/files/${doc.documentId}?addParents=${folderId}&fields=id,parents`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  return doc.documentId;
}

const TEMPLATE_PROCURACAO = `PROCURAÇÃO

OUTORGANTE: {{NOME_CLIENTE}}, {{QUALIFICACAO_CLIENTE}}, portador(a) do CPF/CNPJ nº {{CPF_CNPJ}}, RG nº {{RG}}, residente e domiciliado(a) em {{ENDERECO}}.

OUTORGADO(A): {{NOME_ADVOGADO}}, inscrito(a) na OAB/{{OAB_UF}} sob o nº {{OAB_NUMERO}}, com escritório profissional em {{ESCRITORIO_ENDERECO}}.

PODERES: Pelo presente instrumento particular de procuração, o(a) OUTORGANTE nomeia e constitui seu bastante procurador(a) o(a) OUTORGADO(A), a quem confere amplos poderes para o foro em geral, com a cláusula "ad judicia et extra", em qualquer Juízo, Instância ou Tribunal, podendo propor contra quem de direito as ações competentes e defendê-lo(a) nas contrárias, seguindo umas e outras até final decisão, usando os recursos legais e acompanhando-os, conferindo-lhe, ainda, poderes especiais para confessar, desistir, transigir, firmar compromissos ou acordos, receber e dar quitação, agir em conjunto ou separadamente, substabelecer esta a outrem, com ou sem reserva de iguais poderes, dando tudo por bom, firme e valioso, especialmente para atuar em relação a: {{OBJETO_PROCURACAO}}.

{{CIDADE}}, {{DATA_ATUAL}}.


_______________________________________
{{NOME_CLIENTE}}
`;

const TEMPLATE_CONTRATO = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS

CONTRATANTE: {{NOME_CLIENTE}}, {{QUALIFICACAO_CLIENTE}}, portador(a) do CPF/CNPJ nº {{CPF_CNPJ}}, RG nº {{RG}}, residente e domiciliado(a) em {{ENDERECO}}.

CONTRATADO(A): {{NOME_ESCRITORIO}}, inscrito(a) na OAB/{{OAB_UF}} sob o nº {{OAB_NUMERO}}, com escritório profissional em {{ESCRITORIO_ENDERECO}}.

As partes acima identificadas têm, entre si, justo e acertado o presente Contrato de Prestação de Serviços Advocatícios, que se regerá pelas cláusulas seguintes:

CLÁUSULA 1ª — DO OBJETO
O presente contrato tem como objeto a prestação de serviços advocatícios pelo(a) CONTRATADO(A) em favor do(a) CONTRATANTE, consistentes em: {{OBJETO_CONTRATO}}.

CLÁUSULA 2ª — DOS HONORÁRIOS
Pelos serviços ora contratados, o(a) CONTRATANTE pagará ao(à) CONTRATADO(A) o valor de {{VALOR_HONORARIOS}}, na seguinte forma: {{FORMA_PAGAMENTO}}.

CLÁUSULA 3ª — DAS OBRIGAÇÕES
O(A) CONTRATADO(A) obriga-se a empregar todos os esforços técnicos ao alcance da profissão em prol dos interesses do(a) CONTRATANTE, sem que isso represente garantia de resultado. O(A) CONTRATANTE obriga-se a fornecer, em tempo hábil, toda a documentação e informações necessárias à execução dos serviços.

CLÁUSULA 4ª — DA VIGÊNCIA E RESCISÃO
Este contrato vigorará a partir desta data até o cumprimento do objeto pactuado, podendo ser rescindido por qualquer das partes mediante notificação prévia, resguardado ao(à) CONTRATADO(A) o direito aos honorários proporcionais aos serviços já prestados até a rescisão.

CLÁUSULA 5ª — DO FORO
Fica eleito o foro da Comarca de {{CIDADE}} para dirimir quaisquer dúvidas oriundas do presente contrato.

E por estarem assim justas e contratadas, as partes firmam o presente instrumento.

{{CIDADE}}, {{DATA_ATUAL}}.


_______________________________________                    _______________________________________
{{NOME_CLIENTE}} (CONTRATANTE)                              {{NOME_ADVOGADO}} (CONTRATADO)
`;

async function ensureTemplates(userId) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('google_nao_conectado');
  const modelosFolderId = await ensureFolder(accessToken, 'modelos_folder_id', 'Modelos - Sistema Jurídico');

  let procuracaoId = getSetting('template_procuracao_id');
  if (!procuracaoId) {
    procuracaoId = await createDocInFolder(accessToken, 'Modelo - Procuração', TEMPLATE_PROCURACAO, modelosFolderId);
    setSetting('template_procuracao_id', procuracaoId);
  }
  let contratoId = getSetting('template_contrato_id');
  if (!contratoId) {
    contratoId = await createDocInFolder(accessToken, 'Modelo - Contrato de Prestação de Serviços', TEMPLATE_CONTRATO, modelosFolderId);
    setSetting('template_contrato_id', contratoId);
  }
  return { procuracaoId, contratoId, modelosFolderId };
}

function qualificacaoCliente(cliente) {
  if (cliente.type === 'PJ') return 'pessoa jurídica de direito privado';
  const estadoCivil = cliente.estado_civil || '[estado civil]';
  const profissao = cliente.profissao || '[profissão]';
  return `brasileiro(a), ${estadoCivil}, ${profissao}`;
}

function fmtDataExtenso() {
  return new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Gera Procuracao ou Contrato de Prestacao de Servicos para um cliente,
// preenchendo um modelo do Google Docs com os dados do cliente/escritorio.
async function generateDocument(userId, { tipo, cliente, advogadoNome, extra = {} }) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('google_nao_conectado');
  const { procuracaoId, contratoId, modelosFolderId } = await ensureTemplates(userId);
  const destFolderId = await ensureFolder(accessToken, 'documentos_gerados_folder_id', 'Documentos Gerados - Sistema Jurídico');

  const isContrato = tipo === 'contrato';
  const templateId = isContrato ? contratoId : procuracaoId;
  const docName = `${isContrato ? 'Contrato de Prestação de Serviços' : 'Procuração'} - ${cliente.name}`;

  const copyRes = await driveRequest(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${templateId}/copy?fields=id,name,webViewLink`,
    { method: 'POST', body: JSON.stringify({ name: docName, parents: [destFolderId] }) }
  );

  const replacements = {
    NOME_CLIENTE: cliente.name || '',
    QUALIFICACAO_CLIENTE: qualificacaoCliente(cliente),
    CPF_CNPJ: cliente.cpf_cnpj || '[CPF/CNPJ — preencher]',
    RG: cliente.rg || (cliente.type === 'PJ' ? 'não se aplica' : '[RG — preencher]'),
    ENDERECO: cliente.endereco || '[endereço — preencher]',
    NOME_ADVOGADO: advogadoNome || ESCRITORIO.nome,
    NOME_ESCRITORIO: ESCRITORIO.nome,
    OAB_UF: ESCRITORIO.oabUf,
    OAB_NUMERO: ESCRITORIO.oabNumero,
    ESCRITORIO_ENDERECO: ESCRITORIO.endereco,
    CIDADE: ESCRITORIO.cidade,
    DATA_ATUAL: fmtDataExtenso(),
    OBJETO_PROCURACAO: extra.objeto || 'representação judicial e extrajudicial em geral',
    OBJETO_CONTRATO: extra.objeto || '[objeto do contrato — preencher]',
    VALOR_HONORARIOS: extra.valor_honorarios || '[valor — a combinar]',
    FORMA_PAGAMENTO: extra.forma_pagamento || '[forma de pagamento — a combinar]',
  };

  const requests = Object.entries(replacements).map(([key, value]) => ({
    replaceAllText: { containsText: { text: `{{${key}}}`, matchCase: true }, replaceText: String(value) },
  }));
  await fetch(`https://docs.googleapis.com/v1/documents/${copyRes.id}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  }).then((r) => { if (!r.ok) throw new Error('docs_replace_failed: ' + r.status); });

  return { id: copyRes.id, name: copyRes.name, webViewLink: copyRes.webViewLink };
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
  generateDocument,
};
