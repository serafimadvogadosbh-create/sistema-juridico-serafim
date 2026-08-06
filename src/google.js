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
  endereco: process.env.ESCRITORIO_ENDERECO || 'Av. Francisco Sales, nº 329, Sala 1202, bairro Floresta, Belo Horizonte/MG – CEP 30.150-221',
  cidade: process.env.ESCRITORIO_CIDADE || 'Belo Horizonte/MG',
  pixCnpj: process.env.ESCRITORIO_PIX_CNPJ || '60.186.215/0001-70',
  pixBanco: process.env.ESCRITORIO_PIX_BANCO || 'BANCO INTER',
  pixTitular: process.env.ESCRITORIO_PIX_TITULAR || 'DOUGLAS LÓZ SERAFIM',
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

// Constroi o texto final e as requisicoes de formatacao (justificado + negrito
// nos rotulos/clausulas) a partir de uma lista de paragrafos. Cada paragrafo e
// { segments: [[texto, negrito], ...], align: 'JUSTIFIED'|'CENTER'|'START' }.
function buildRichTextRequests(paragraphs) {
  let text = '';
  let index = 1; // corpo do Google Doc comeca no index 1
  const boldRanges = [];
  const paraRanges = [];
  for (const para of paragraphs) {
    const paraStart = index;
    for (const [segText, bold] of para.segments) {
      const segStart = index;
      text += segText;
      index += segText.length;
      if (bold) boldRanges.push({ start: segStart, end: index });
    }
    text += '\n';
    index += 1;
    paraRanges.push({ start: paraStart, end: index, align: para.align || 'JUSTIFIED' });
  }
  const requests = [{ insertText: { location: { index: 1 }, text } }];
  for (const pr of paraRanges) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: pr.start, endIndex: pr.end },
        paragraphStyle: { alignment: pr.align },
        fields: 'alignment',
      },
    });
  }
  for (const br of boldRanges) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: br.start, endIndex: br.end },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }
  return requests;
}

async function createDocInFolder(accessToken, title, paragraphs, folderId) {
  const doc = await fetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((r) => { if (!r.ok) throw new Error('docs_create_failed'); return r.json(); });

  const requests = buildRichTextRequests(paragraphs);
  await fetch(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  }).then((r) => { if (!r.ok) throw new Error('docs_fill_failed'); });

  await driveRequest(accessToken, `https://www.googleapis.com/drive/v3/files/${doc.documentId}?addParents=${folderId}&fields=id,parents`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  return doc.documentId;
}

// Modelos de fallback (sem o papel timbrado com logotipo): usados apenas se
// as configuracoes template_procuracao_id/template_contrato_id forem
// removidas e precisarem ser recriadas do zero. Em producao, os modelos
// "de verdade" sao os documentos com identidade visual do escritorio
// (logotipo, faixas coloridas) enviados manualmente para a pasta "Modelos -
// Sistema Jurídico" no Drive e referenciados via app_settings — este texto
// replica a mesma estrutura/clausulas e a mesma formatacao (justificado +
// negrito nos topicos), so que sem o papel timbrado.
const TEMPLATE_PROCURACAO_PARAGRAPHS = [
  { align: 'CENTER', segments: [['INSTRUMENTO PARTICULAR DE PROCURAÇÃO', true]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['OUTORGANTE: {{NOME_CLIENTE}}', true],
    [', {{QUALIFICACAO_CLIENTE}}, portador(a) do CPF/CNPJ nº {{CPF_CNPJ}}, RG nº {{RG}}, residente e domiciliado(a) em {{ENDERECO}}.', false],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['OUTORGADO: {{NOME_ADVOGADO}}', true],
    [', inscrito(a) na OAB/{{OAB_UF}} sob o nº {{OAB_NUMERO}}, com escritório profissional situado à {{ESCRITORIO_ENDERECO}}.', false],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['PODERES: ', true],
    ['Pelo presente instrumento particular de procuração, o(a) OUTORGANTE nomeia e constitui seu bastante procurador(a) o(a) OUTORGADO(A), a quem confere amplos poderes para o foro em geral, com a cláusula "ad judicia et extra", em qualquer Juízo, Instância ou Tribunal, podendo propor contra quem de direito as ações competentes e defendê-lo(a) nas contrárias, seguindo umas e outras até final decisão, usando os recursos legais e acompanhando-os, conferindo-lhe, ainda, poderes especiais para confessar, desistir, transigir, firmar compromissos ou acordos, receber e dar quitação, agir em conjunto ou separadamente, substabelecer esta a outrem, com ou sem reserva de iguais poderes, dando tudo por bom, firme e valioso.', false],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['Confere ainda, o(a) OUTORGANTE ao OUTORGADO(A) os poderes especiais para {{OBJETO_PROCURACAO}}.', false],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['{{CIDADE}}, {{DATA_ATUAL}}.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'START', segments: [['_______________________________________', false]] },
  { align: 'START', segments: [['{{NOME_CLIENTE}}', true]] },
  { align: 'START', segments: [['OUTORGANTE', false]] },
];

const TEMPLATE_CONTRATO_PARAGRAPHS = [
  { align: 'CENTER', segments: [['CONTRATO DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS', true]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['Pelo presente instrumento particular, de um lado:', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['CONTRATANTE: {{NOME_CLIENTE}}', true],
    [', {{QUALIFICACAO_CLIENTE}}, portador(a) do CPF/CNPJ nº {{CPF_CNPJ}}, RG nº {{RG}}, residente e domiciliado(a) em {{ENDERECO}};', false],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['e, de outro lado:', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['CONTRATADO(A): {{NOME_ADVOGADO}}', true],
    [', advogado(a), inscrito(a) na OAB/{{OAB_UF}} sob o nº {{OAB_NUMERO}}, com endereço profissional situado à {{ESCRITORIO_ENDERECO}}.', false],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['têm entre si justo e contratado o que segue:', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 1ª — DO OBJETO', true]] },
  { align: 'JUSTIFIED', segments: [['O presente contrato tem por objeto a prestação de serviços advocatícios do(a) CONTRATADO(A) para o patrocínio de interesses do(a) CONTRATANTE em {{OBJETO_CONTRATO}}, bem como a prática de todos os atos processuais e extraprocessuais necessários à condução do feito até sua finalização.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 2ª — DA EXTENSÃO DOS SERVIÇOS', true]] },
  { align: 'JUSTIFIED', segments: [['Os serviços compreendem, entre outros:', false]] },
  { align: 'JUSTIFIED', segments: [['I. análise da documentação apresentada;', false]] },
  { align: 'JUSTIFIED', segments: [['II. elaboração e protocolo da petição inicial ou manifestação cabível;', false]] },
  { align: 'JUSTIFIED', segments: [['III. acompanhamento do processo até sentença, homologação de acordo ou encerramento da demanda;', false]] },
  { align: 'JUSTIFIED', segments: [['IV. comparecimento a audiências e sessões de conciliação/mediação, quando designadas;', false]] },
  { align: 'JUSTIFIED', segments: [['V. elaboração de petições incidentais necessárias ao regular andamento do feito;', false]] },
  { align: 'JUSTIFIED', segments: [['VI. prática de atos perante cartórios, órgãos públicos e repartições correlatas, quando indispensável ao cumprimento do objeto contratado.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['Parágrafo único. ', true],
    ['Eventuais serviços extraordinários, inclusive recursos, cumprimento de sentença, impugnações, incidentes complexos ou novas demandas não abrangidas neste contrato, somente serão exigíveis mediante ajuste adicional entre as partes.', false],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 3ª — DOS HONORÁRIOS CONTRATUAIS', true]] },
  { align: 'JUSTIFIED', segments: [['Pelos serviços contratados, o(a) CONTRATANTE pagará ao(à) CONTRATADO(A) o valor de {{VALOR_HONORARIOS}}.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 4ª — DA FORMA DE PAGAMENTO', true]] },
  { align: 'JUSTIFIED', segments: [['O pagamento será realizado da seguinte forma: {{FORMA_PAGAMENTO}}.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [
    ['Parágrafo único. ', true],
    ['O(A) CONTRATANTE deverá efetuar os pagamentos no prazo, na forma e nas condições estabelecidas no presente contrato através do ', false],
    ['PIX/CNPJ nº {{PIX_CNPJ}}, {{PIX_BANCO}} – Titular: {{PIX_TITULAR}}.', true],
  ] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 5ª — DAS DESPESAS E CUSTAS', true]] },
  { align: 'JUSTIFIED', segments: [['As custas processuais, taxas, emolumentos, certidões, diligências, deslocamentos, autenticações, reconhecimentos de firma e demais despesas necessárias ao andamento da demanda não estão incluídas nos honorários contratados, incumbindo seu adiantamento e pagamento ao(à) CONTRATANTE, salvo ajuste expresso em sentido diverso.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 6ª — DOS HONORÁRIOS DE SUCUMBÊNCIA', true]] },
  { align: 'JUSTIFIED', segments: [['Eventuais honorários de sucumbência fixados judicialmente pertencem exclusivamente ao(à) CONTRATADO(A), não se compensando nem se confundindo com os honorários contratuais ora pactuados.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 7ª — DAS OBRIGAÇÕES DO(A) CONTRATANTE', true]] },
  { align: 'JUSTIFIED', segments: [['O(A) CONTRATANTE compromete-se a:', false]] },
  { align: 'JUSTIFIED', segments: [['I. fornecer documentos, informações e esclarecimentos verdadeiros e completos;', false]] },
  { align: 'JUSTIFIED', segments: [['II. comparecer aos atos para os quais for intimado(a) ou convocado(a);', false]] },
  { align: 'JUSTIFIED', segments: [['III. comunicar imediatamente qualquer alteração de endereço, telefone ou e-mail;', false]] },
  { align: 'JUSTIFIED', segments: [['IV. efetuar pontualmente os pagamentos ajustados neste instrumento.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 8ª — DA RESCISÃO', true]] },
  { align: 'JUSTIFIED', segments: [['O presente contrato poderá ser rescindido por qualquer das partes, mediante comunicação escrita. Em caso de revogação imotivada ou desistência por parte do(a) CONTRATANTE após o início dos serviços, permanecerão devidos os honorários proporcionais ao trabalho já realizado, sem prejuízo das despesas assumidas.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['CLÁUSULA 9ª — DO FORO', true]] },
  { align: 'JUSTIFIED', segments: [['Para dirimir quaisquer controvérsias oriundas deste contrato, as partes elegem o foro da Comarca de {{CIDADE}}, com renúncia de qualquer outro, por mais privilegiado que seja.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['E, por estarem justas e contratadas, firmam o presente instrumento em duas vias de igual teor e forma, juntamente com duas testemunhas.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'JUSTIFIED', segments: [['{{CIDADE}}, {{DATA_ATUAL}}.', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'START', segments: [['_______________________________________', false]] },
  { align: 'START', segments: [['{{NOME_CLIENTE}}', true]] },
  { align: 'START', segments: [['CONTRATANTE', false]] },
  { align: 'START', segments: [['', false]] },
  { align: 'START', segments: [['_______________________________________', false]] },
  { align: 'START', segments: [['{{NOME_ADVOGADO}}', true]] },
  { align: 'START', segments: [['CONTRATADO(A) — OAB/{{OAB_UF}} {{OAB_NUMERO}}', false]] },
];

async function ensureTemplates(userId) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('google_nao_conectado');
  const modelosFolderId = await ensureFolder(accessToken, 'modelos_folder_id', 'Modelos - Sistema Jurídico');

  let procuracaoId = getSetting('template_procuracao_id');
  if (!procuracaoId) {
    procuracaoId = await createDocInFolder(accessToken, 'Modelo - Procuração', TEMPLATE_PROCURACAO_PARAGRAPHS, modelosFolderId);
    setSetting('template_procuracao_id', procuracaoId);
  }
  let contratoId = getSetting('template_contrato_id');
  if (!contratoId) {
    contratoId = await createDocInFolder(accessToken, 'Modelo - Contrato de Prestação de Serviços', TEMPLATE_CONTRATO_PARAGRAPHS, modelosFolderId);
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
    PIX_CNPJ: ESCRITORIO.pixCnpj,
    PIX_BANCO: ESCRITORIO.pixBanco,
    PIX_TITULAR: ESCRITORIO.pixTitular,
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

// Exporta um Google Doc (procuracao/contrato gerado) como PDF, para download
// direto pelo usuario sem precisar abrir o Google Drive.
async function exportPdf(userId, fileId) {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('google_nao_conectado');
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error('pdf_export_failed: ' + res.status);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
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
  exportPdf,
};
