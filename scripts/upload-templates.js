// scripts/upload-templates.js
//
// Script de uso único (rodar via Render Web Shell: `node scripts/upload-templates.js`).
// Faz upload dos dois modelos com identidade visual (templates/*.docx, que já
// incluem o papel timbrado do escritório) para a pasta "Modelos - Sistema
// Jurídico" no Google Drive da conta conectada, convertendo-os para o formato
// nativo do Google Docs (necessário para preservar as imagens de cabeçalho/
// rodapé de forma confiável e para permitir replaceAllText/copy depois).
// Ao final, atualiza app_settings.template_procuracao_id e
// app_settings.template_contrato_id para apontar para os novos documentos.
'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const google = require('../src/google');

async function main() {
  const tokenRow = db.prepare(`SELECT user_id FROM oauth_tokens WHERE provider = 'google' LIMIT 1`).get();
  if (!tokenRow) throw new Error('Nenhuma conta Google conectada (oauth_tokens vazio).');
  const userId = tokenRow.user_id;
  console.log('Usando userId:', userId);

  const accessToken = await google.getValidAccessToken(userId);
  if (!accessToken) throw new Error('Não foi possível obter access_token válido.');

  const folderRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'modelos_folder_id'`).get();
  if (!folderRow) throw new Error('app_settings.modelos_folder_id não encontrado. Gere um documento pelo sistema pelo menos uma vez antes de rodar este script.');
  const modelosFolderId = folderRow.value;
  console.log('Pasta de modelos:', modelosFolderId);

  async function uploadAsGoogleDoc(filePath, driveName) {
    const fileBuf = fs.readFileSync(filePath);
    const boundary = 'boundary_' + Math.random().toString(16).slice(2);
    const metadata = JSON.stringify({
      name: driveName,
      mimeType: 'application/vnd.google-apps.document',
      parents: [modelosFolderId],
    });
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`,
      'utf-8'
    );
    const closing = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
    const body = Buffer.concat([preamble, fileBuf, closing]);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`upload_failed (${driveName}): ${res.status} ${await res.text()}`);
    return res.json();
  }

  const templatesDir = path.join(__dirname, '..', 'templates');

  console.log('Enviando Procuração...');
  const procuracao = await uploadAsGoogleDoc(
    path.join(templatesDir, 'Modelo - Procuracao.docx'),
    'Modelo - Procuração (papel timbrado)'
  );
  console.log('  ->', procuracao.id, procuracao.webViewLink);

  console.log('Enviando Contrato...');
  const contrato = await uploadAsGoogleDoc(
    path.join(templatesDir, 'Modelo - Contrato de Prestacao de Servicos.docx'),
    'Modelo - Contrato de Prestação de Serviços (papel timbrado)'
  );
  console.log('  ->', contrato.id, contrato.webViewLink);

  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('template_procuracao_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(procuracao.id);
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('template_contrato_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(contrato.id);

  console.log('\napp_settings atualizado:');
  console.log('  template_procuracao_id =', procuracao.id);
  console.log('  template_contrato_id   =', contrato.id);
  console.log('\nPronto. Os próximos documentos gerados usarão os novos modelos com papel timbrado.');
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
