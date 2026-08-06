// seed.js — utilitario para recriar o banco do zero (apaga data/app.db antes de rodar)
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');
for (const ext of ['', '-wal', '-shm']) {
  const p = DB_PATH + ext;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
require('./db').init();
console.log('Banco recriado e populado com dados de exemplo.');
