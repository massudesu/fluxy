const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
const LOG_DIR = path.join(PROJECT_ROOT, 'backend', 'logs');

// Le backend/.env sem dependencia externa; variaveis ja definidas no sistema tem prioridade.
(function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, 'backend', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  });
})();

function readBoolean(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(raw);
}

function readList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(item => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HOST = process.env.API_HOST || '127.0.0.1';
const PORT = Number(process.env.API_PORT || process.env.PORT || 8080);

const CONFIG_ERRORS = [];

function buildDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const hasPgVariables = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].some(name => process.env[name]);
  if (IS_PRODUCTION && !hasPgVariables) {
    CONFIG_ERRORS.push('Defina DATABASE_URL (ou PGHOST/PGUSER/PGPASSWORD/PGDATABASE) antes de iniciar em producao.');
  }

  const user = encodeURIComponent(process.env.PGUSER || 'postgres');
  const password = encodeURIComponent(process.env.PGPASSWORD || 'postgres');
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || 5432;
  const database = encodeURIComponent(process.env.PGDATABASE || 'fluxy_db');
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

const DATABASE_URL = buildDatabaseUrl();

// Base do link de redefinicao de senha. Nunca vem do cabecalho Host, que o visitante controla.
const defaultAppUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;
const APP_URL_IS_EXPLICIT = Boolean(process.env.APP_URL || process.env.VERCEL_URL);
const APP_URL = (process.env.APP_URL || defaultAppUrl).replace(/\/+$/, '');

const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: SMTP_PORT,
  secure: readBoolean('SMTP_SECURE', SMTP_PORT === 465),
  requireTls: readBoolean('SMTP_REQUIRE_TLS', true),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || process.env.SMTP_USER || ''
};

const MAIL_MODE = String(process.env.MAIL_MODE || 'smtp').trim().toLowerCase();

const CORS_ORIGINS = readList('CORS_ORIGINS');

const TRUST_PROXY = readBoolean('TRUST_PROXY', Boolean(process.env.VERCEL));

const COOKIE_SECURE = readBoolean('COOKIE_SECURE', IS_PRODUCTION || /^https:/i.test(APP_URL));
// Site em outro dominio (CORS_ORIGINS) so recebe o cookie com SameSite=None, que exige Secure.
const COOKIE_SAME_SITE = CORS_ORIGINS.length && COOKIE_SECURE ? 'None' : 'Strict';
if (IS_PRODUCTION && CORS_ORIGINS.length && !COOKIE_SECURE) {
  CONFIG_ERRORS.push('CORS_ORIGINS em producao exige HTTPS: defina APP_URL com https:// (ou COOKIE_SECURE=true).');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

module.exports = {
  PROJECT_ROOT,
  FRONTEND_DIR,
  LOG_DIR,
  IS_PRODUCTION,
  HOST,
  PORT,
  DATABASE_URL,
  CONFIG_ERRORS,
  APP_URL,
  APP_URL_IS_EXPLICIT,
  SMTP,
  MAIL_MODE,
  CORS_ORIGINS,
  TRUST_PROXY,
  COOKIE_SECURE,
  COOKIE_SAME_SITE,
  MIME_TYPES
};
