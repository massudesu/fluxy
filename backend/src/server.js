const http = require('http');
const { exec } = require('child_process');
const { HOST, PORT, DATABASE_URL, IS_PRODUCTION, CONFIG_ERRORS, CORS_ORIGINS, TRUST_PROXY, APP_URL } = require('./config');
const { log, logError } = require('./lib/logger');
const { pool, query } = require('./lib/db');
const { sendJson } = require('./lib/http-helpers');
const { csrfRejected } = require('./lib/session-cookie');
const { logMailStatus } = require('./lib/mailer');
const { scheduleMaintenance } = require('./lib/maintenance');
const { handleApi } = require('./routes');
const { serveStatic } = require('./static-server');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function resolvePathname(req) {
  try {
    return decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_error) {
    return null;
  }
}

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

  const arrivedOverHttps = TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
  if (IS_PRODUCTION && arrivedOverHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin || !CORS_ORIGINS.includes(origin)) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  // Credentials: o site autorizado em outro dominio precisa enviar o cookie da sessao.
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Fluxy-Request');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

function handleRequest(req, res) {
  applySecurityHeaders(req, res);

  const pathname = resolvePathname(req);
  if (pathname === null) return sendJson(res, 400, { error: 'invalid_request', message: 'Endereço inválido.' });

  if (pathname === '/health' || pathname.startsWith('/api/')) {
    applyCors(req, res);
    res.acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (csrfRejected(req)) {
      return sendJson(res, 403, {
        error: 'csrf_rejected',
        message: 'Requisição bloqueada por segurança. Recarregue a página e tente de novo.'
      });
    }
    return handleApi(req, res, pathname);
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handleRequest(req, res))
    .catch(error => {
      logError('erro ao atender a requisicao', error);
      sendJson(res, 500, { error: 'internal_error', message: 'Ocorreu um erro interno. Tente novamente.' });
    });
});

const localUrl = `http://localhost:${PORT}/index.html`;

function openBrowser() {
  if (process.env.FLUXY_NO_OPEN === '1' || IS_PRODUCTION) return;
  const command = process.platform === 'win32'
    ? `start "" "${localUrl}"`
    : process.platform === 'darwin' ? `open "${localUrl}"` : `xdg-open "${localUrl}"`;
  exec(command, () => {});
}

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    log(`a porta ${PORT} ja esta em uso - o Fluxy provavelmente ja esta aberto.`);
    log(`abrindo ${localUrl}`);
    openBrowser();
    setTimeout(() => process.exit(0), 1200);
    return;
  }
  console.error('[Fluxy] falha ao iniciar o servidor:', error.message);
  process.exit(1);
});

async function start() {
  if (CONFIG_ERRORS.length) {
    CONFIG_ERRORS.forEach(problem => console.error(`[Fluxy] configuracao: ${problem}`));
    process.exit(1);
  }

  try {
    await query('SELECT 1');
    log('conexao com o PostgreSQL: OK');
    scheduleMaintenance();
  } catch (error) {
    log(`ATENCAO: nao foi possivel conectar ao PostgreSQL (${error.code || error.message})`);
    log('confira backend/.env e rode "npm run db:migrate" antes de usar o sistema.');
  }

  server.listen(PORT, HOST, () => {
    log(`Fluxy ONLINE (frontend + API na mesma porta) - modo ${IS_PRODUCTION ? 'producao' : 'desenvolvimento'}`);
    log(`site .......: ${localUrl}`);
    log(`api ........: http://localhost:${PORT}/api`);
    log(`health .....: http://localhost:${PORT}/health`);
    log(`banco ......: ${DATABASE_URL.replace(/:[^:@/]+@/, ':****@')}`);
    log(`links ......: ${APP_URL} (APP_URL, usado no e-mail de redefinicao de senha)`);
    logMailStatus();
    log('para encerrar, feche esta janela ou pressione Ctrl+C');
    openBrowser();
  });
}

function shutdown() {
  server.close(() => {
    pool.end().catch(() => {}).finally(() => process.exit(0));
  });
  // No Node 18 (ainda suportado) conexoes keep-alive ociosas seguravam o close() ate o limite de 3 s.
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = {
  server,
  start,
  resolvePathname,
  applySecurityHeaders,
  applyCors,
  handleRequest
};
