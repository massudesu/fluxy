const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEST_EMAIL_DOMAIN = 'teste.fluxy.invalid';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('o servidor de teste encerrou antes de ficar pronto');
    // Qualquer resposta serve: com o banco fora do ar o /health responde 503, mas o servidor esta de pe.
    const response = await fetch(`${baseUrl}/health`).catch(() => null);
    if (response) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('o servidor de teste nao respondeu a tempo');
}

const ISOLATED_ENV = {
  NODE_ENV: '', APP_URL: '', MAIL_MODE: '', CORS_ORIGINS: '',
  SMTP_HOST: '', SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASS: '', SMTP_REQUIRE_TLS: '', MAIL_FROM: ''
};

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'backend', 'src', 'index.js')], {
    env: {
      ...process.env,
      ...ISOLATED_ENV,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      FLUXY_NO_OPEN: '1',
      TRUST_PROXY: 'true',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  await waitUntilReady(baseUrl, child);

  return {
    baseUrl,
    port,
    output: () => output,
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    })
  };
}

let ipCounter = 0;
const nextFakeIp = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${(ipCounter++ % 250) + 1}`;

// Imita o navegador: guarda o cookie de sessao que o servidor envia (Set-Cookie) e o devolve
// nas proximas chamadas. "token" e o valor desse cookie, util para conferir o banco.
// Toda chamada que altera dados leva o cabecalho anti-CSRF, como o frontend faz;
// { csrf: false } simula uma requisicao vinda de outro site.
const SESSION_COOKIE = 'fluxy_session';

function sessionFromSetCookie(headers) {
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  const session = cookies.find(cookie => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (!session) return undefined;
  const value = session.split(';')[0].slice(SESSION_COOKIE.length + 1);
  return /Max-Age=0/i.test(session) ? '' : value;
}

function createClient(baseUrl, { ip = nextFakeIp(), token = '', csrf = true } = {}) {
  const client = {
    ip,
    token,
    lastSetCookie: null,
    async request(method, pathname, body, extraHeaders = {}) {
      const headers = { 'X-Forwarded-For': client.ip };
      if (csrf && !['GET', 'HEAD'].includes(method)) headers['X-Fluxy-Request'] = '1';
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (client.token) headers.Cookie = `${SESSION_COOKIE}=${client.token}`;
      Object.assign(headers, extraHeaders);

      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      });
      const session = sessionFromSetCookie(response.headers);
      if (session !== undefined) {
        client.token = session;
        client.lastSetCookie = (typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie() : [response.headers.get('set-cookie')])
          .find(cookie => cookie && cookie.startsWith(`${SESSION_COOKIE}=`));
      }
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_error) {
        data = text;
      }
      return { status: response.status, data, headers: response.headers };
    },
    get: pathname => client.request('GET', pathname),
    post: (pathname, body = {}) => client.request('POST', pathname, body),
    del: (pathname, body) => client.request('DELETE', pathname, body)
  };
  return client;
}

const createdEmails = new Set();

function newEmail(prefix = 'conta') {
  const email = `${prefix}-${crypto.randomBytes(6).toString('hex')}@${TEST_EMAIL_DOMAIN}`;
  createdEmails.add(email);
  return email;
}

const PASSWORD = 'Senha1234';

async function registerAccount(baseUrl, overrides = {}) {
  const email = overrides.email || newEmail();
  createdEmails.add(email);
  const client = createClient(baseUrl);
  const response = await client.post('/api/auth/register', {
    name: 'Pessoa de Teste', email, password: PASSWORD, ...overrides
  });
  if (response.status !== 201) throw new Error(`cadastro de teste falhou: ${response.status} ${JSON.stringify(response.data)}`);
  if (!client.token) throw new Error('o cadastro nao abriu a sessao (cookie ausente)');
  return { client, email, password: overrides.password || PASSWORD, account: response.data };
}

let pool = null;

function db() {
  if (!pool) {
    const { Pool } = require('pg');
    const { DATABASE_URL } = require(path.join(PROJECT_ROOT, 'backend', 'src', 'config'));
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  }
  return pool;
}

// Os limites por IP ficam no banco e sobrevivem entre execucoes; testes que falam com o servidor
// sem proxy saem todos de 127.0.0.1 e, somados, bloqueariam a proxima rodada. So esses
// contadores sao zerados (os por e-mail ficam como estao).
const IP_LIMITS = ['login-ip', 'cadastro-ip', 'esqueci-ip', 'redefinir-ip'];
const LOCAL_ADDRESSES = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];

async function resetLocalhostLimits() {
  const keys = IP_LIMITS.flatMap(name => LOCAL_ADDRESSES.map(ip =>
    crypto.createHash('sha256').update(`${name}\u0000${ip}`).digest('hex')));
  await db().query('DELETE FROM limite_tentativa WHERE chave = ANY($1)', [keys]);
}

async function cleanup() {
  if (createdEmails.size) {
    const emails = [...createdEmails];
    await db().query('DELETE FROM empresa WHERE id IN (SELECT empresa_id FROM usuario WHERE email = ANY($1))', [emails]);
    await db().query('DELETE FROM usuario WHERE email = ANY($1)', [emails]);
    createdEmails.clear();
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { resetLocalhostLimits, SESSION_COOKIE, PROJECT_ROOT, PASSWORD, startServer, createClient, registerAccount, newEmail, db, cleanup, nextFakeIp };
