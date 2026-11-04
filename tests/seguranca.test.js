const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT, PASSWORD, startServer, createClient, registerAccount, newEmail, cleanup } = require('./helpers/server');

let server;
let baseUrl;

test.before(async () => {
  server = await startServer();
  baseUrl = server.baseUrl;
});

test.after(async () => {
  await server?.stop();
  await cleanup();
});

const raw = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...options });

test('cabecalhos de seguranca acompanham as paginas e a API', async () => {
  for (const pathname of ['/index.html', '/health', '/api/nao-existe', '/arquivo-que-nao-existe']) {
    const { headers } = await raw(pathname);
    assert.equal(headers.get('x-content-type-options'), 'nosniff', pathname);
    assert.equal(headers.get('x-frame-options'), 'DENY', pathname);
    assert.equal(headers.get('referrer-policy'), 'no-referrer', pathname);
    assert.ok(headers.get('content-security-policy'), pathname);
  }

  const policy = (await raw('/index.html')).headers.get('content-security-policy');
  assert.match(policy, /script-src 'self'(;|$)/, 'scripts apenas do proprio site');
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal((await raw('/health')).headers.get('strict-transport-security'), null, 'HSTS so em producao atras de HTTPS');
});

test('a pagina nao depende de script embutido nem de onclick (exigencia da politica de seguranca)', () => {
  const frontend = path.join(PROJECT_ROOT, 'frontend');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');

  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'nenhum <script> sem src');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'nenhum atributo on...=');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'nenhum style embutido');
  assert.doesNotMatch(html, /<script[^>]+src="https?:/i, 'nenhum script carregado de outro site');

  const scripts = fs.readdirSync(path.join(frontend, 'js'), { recursive: true })
    .filter(file => String(file).endsWith('.js'))
    .map(file => fs.readFileSync(path.join(frontend, 'js', String(file)), 'utf8'))
    .join('\n');
  assert.doesNotMatch(scripts, /onclick="|style="/, 'o HTML gerado pelo JavaScript segue a mesma regra');
});

test('a pergunta de seguranca saiu do cadastro e da recuperacao', () => {
  const frontend = path.join(PROJECT_ROOT, 'frontend');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const auth = fs.readFileSync(path.join(frontend, 'js', 'core', 'auth.js'), 'utf8');

  assert.doesNotMatch(html, /register-question|register-answer|forgot-answer|Pergunta de seguran/i);
  assert.doesNotMatch(auth, /securityQuestion|securityAnswer|answer-question/);
  assert.match(html, /id="forgot-email"/);
  assert.match(auth, /\/api\/auth\/forgot-password/);
});

test('o navegador nao guarda senha nem hash de senha das contas do servidor', () => {
  const auth = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'js', 'core', 'auth.js'), 'utf8');
  const registerOnServer = auth.slice(auth.indexOf('async function registerUser'), auth.indexOf('async function handleRegister'));
  const loginOnServer = auth.slice(auth.indexOf('async function authenticateUser'), auth.indexOf('function recordLocalLogin'));

  for (const block of [registerOnServer, loginOnServer]) {
    assert.doesNotMatch(block.split('FLUXY_API.localOnly')[1], /saveLocalUsers|setLocalPassword|legacyHash|localStorage/);
  }
});

test('CORS: sem configuracao, outro site nao recebe permissao para ler a API', async () => {
  const response = await raw('/health', { headers: { Origin: 'https://site-malicioso.test' } });
  assert.equal(response.headers.get('access-control-allow-origin'), null);

  const preflight = await raw('/api/auth/login', {
    method: 'OPTIONS',
    headers: { Origin: 'https://site-malicioso.test', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('CORS: com CORS_ORIGINS, apenas a origem listada e liberada', async () => {
  const other = await startServer({ CORS_ORIGINS: 'https://meu-front.test, https://outro-front.test/' });
  try {
    const allowed = await fetch(`${other.baseUrl}/health`, { headers: { Origin: 'https://meu-front.test' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://meu-front.test');
    assert.match(allowed.headers.get('access-control-allow-methods'), /DELETE/);
    assert.match(allowed.headers.get('vary'), /Origin/);

    const trailingSlash = await fetch(`${other.baseUrl}/health`, { headers: { Origin: 'https://outro-front.test' } });
    assert.equal(trailingSlash.headers.get('access-control-allow-origin'), 'https://outro-front.test');

    const denied = await fetch(`${other.baseUrl}/health`, { headers: { Origin: 'https://site-malicioso.test' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally {
    await other.stop();
  }
});

test('enderecos malformados nao derrubam o servidor', async () => {
  for (const pathname of ['/%00', '/index.html%00.png', '/%E0%A4%A', '/%', '/api/%00', '/api/clientes/%00']) {
    const response = await raw(pathname);
    assert.ok([400, 401, 404].includes(response.status), `${pathname} -> ${response.status}`);
  }
  assert.equal((await raw('/health')).status, 200, 'o servidor continua de pe');
});

test('arquivos fora da pasta do site nunca sao servidos', async () => {
  const attempts = [
    '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json',
    '/%2e%2e%2fbackend%2f.env.example', '/css/..%2f..%2fbackend/src/config.js', '//etc/passwd', '/.../package.json'
  ];
  for (const pathname of attempts) {
    const response = await raw(pathname);
    const body = await response.text();
    assert.ok([403, 404].includes(response.status), `${pathname} -> ${response.status}`);
    assert.doesNotMatch(body, /fluxy-local-app|DATABASE_URL|root:/, `${pathname} vazou conteudo`);
  }
});

test('arquivos estaticos: cache com validacao, compressao e metodos permitidos', async () => {
  const first = await raw('/css/global.css', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-encoding'), 'gzip');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag);

  const revalidated = await raw('/css/global.css', { headers: { 'If-None-Match': etag } });
  assert.equal(revalidated.status, 304);
  assert.equal((await revalidated.text()).length, 0);

  const withoutGzip = await raw('/css/global.css', { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(withoutGzip.headers.get('content-encoding'), null);
  assert.match(await withoutGzip.text(), /:root/);

  const library = await raw('/vendor/chart-4.5.1.umd.min.js');
  assert.match(library.headers.get('cache-control'), /immutable/);

  assert.equal((await raw('/index.html', { method: 'POST' })).status, 405);
  assert.equal((await raw('/index.html', { method: 'DELETE' })).status, 405);
  const head = await raw('/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
});

test('respostas da API nunca ficam em cache e a carga grande vai compactada', async () => {
  const { client } = await registerAccount(baseUrl);
  for (let index = 0; index < 30; index++) await client.post('/api/clientes', { nome: `Cliente ${index}` });

  const response = await fetch(`${baseUrl}/api/sync`, {
    headers: { Cookie: `fluxy_session=${client.token}`, 'Accept-Encoding': 'gzip', 'X-Forwarded-For': client.ip }
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal((await response.json()).clients.length, 30);
});

test('login: cinco senhas erradas bloqueiam a 6a tentativa, mesmo com a senha certa', async () => {
  const { email } = await registerAccount(baseUrl);
  const attacker = createClient(baseUrl);

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await attacker.post('/api/auth/login', { email, password: `Errada${attempt}A` })).status, 401);
  }
  const blocked = await attacker.post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.match(blocked.data.message, /Muitas tentativas/);

  const owner = await createClient(baseUrl).post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(owner.status, 200, 'o dono da conta, em outro aparelho, continua entrando');
});

test('login: o bloqueio tambem vale para e-mail que nao existe (nao revela cadastro)', async () => {
  const attacker = createClient(baseUrl);
  const email = newEmail('inexistente');

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await attacker.post('/api/auth/login', { email, password: 'Qualquer123' })).status, 401);
  }
  assert.equal((await attacker.post('/api/auth/login', { email, password: 'Qualquer123' })).status, 429);
});

test('login: muitas tentativas contra a mesma conta, vindas de varios IPs, tambem sao contidas', async () => {
  const { email } = await registerAccount(baseUrl);

  let status = 0;
  for (let attempt = 0; attempt < 21; attempt++) {
    status = (await createClient(baseUrl).post('/api/auth/login', { email, password: `Errada${attempt}A` })).status;
  }
  assert.equal(status, 429);
});

test('cadastro: mais de 10 contas seguidas do mesmo IP sao bloqueadas', async () => {
  const client = createClient(baseUrl);
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt++) {
    statuses.push((await client.post('/api/auth/register', { name: 'Robô', email: newEmail('lote'), password: PASSWORD })).status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(201), 429]);
});

test('atras de proxy, forjar o inicio do X-Forwarded-For nao dribla o limite', async () => {
  const email = newEmail('forjado');
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fluxy-Request': '1', 'X-Forwarded-For': `203.0.113.${attempt}, 198.51.100.77` },
      body: JSON.stringify({ email, password: 'Qualquer123' })
    });
    status = response.status;
  }
  assert.equal(status, 429);
});

test('texto com byte nulo e recusado como dado invalido, sem erro interno', async () => {
  const login = await createClient(baseUrl).post('/api/auth/login', { email: 'a\u0000@b.co', password: 'Qualquer123' });
  assert.ok([400, 401].includes(login.status), `status ${login.status}`);

  const { client } = await registerAccount(baseUrl);
  assert.equal((await client.post('/api/clientes', { nome: 'Ana\u0000Maria' })).status, 400);
});

test('X-Forwarded-For so e aceito quando TRUST_PROXY esta ligado', async () => {
  const other = await startServer({ TRUST_PROXY: '' });
  try {
    const email = newEmail('proxy');
    let status = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      status = (await createClient(other.baseUrl).post('/api/auth/login', { email, password: 'Qualquer123' })).status;
    }
    assert.equal(status, 429, 'trocar o cabecalho nao pode driblar o limite');
  } finally {
    await other.stop();
  }
});

test('banco fora do ar: respostas sem detalhes internos e o servidor continua de pe', async () => {
  const other = await startServer({ DATABASE_URL: 'postgres://usuario:senha-secreta@127.0.0.1:9/banco_inexistente' });
  try {
    const health = await fetch(`${other.baseUrl}/health`);
    assert.equal(health.status, 503, 'monitores precisam enxergar a falha pelo codigo HTTP');
    assert.ok(Number(health.headers.get('retry-after')) > 0);
    assert.deepEqual(await health.json(), { status: 'degraded', database: 'unavailable' });

    const login = await createClient(other.baseUrl).post('/api/auth/login', { email: 'a@b.com', password: PASSWORD });
    assert.equal(login.status, 503);
    assert.equal(login.data.error, 'database_unavailable');
    assert.doesNotMatch(JSON.stringify(login.data), /ECONNREFUSED|127\.0\.0\.1|senha-secreta|banco_inexistente/);

    assert.equal((await fetch(`${other.baseUrl}/index.html`)).status, 200, 'a pagina ainda abre');
    assert.ok(!other.output().includes('senha-secreta'), 'a senha do banco nao aparece no log');
  } finally {
    await other.stop();
  }
});

test('em producao, sem configuracao de banco o servidor se recusa a iniciar', async () => {
  await assert.rejects(
    startServer({ NODE_ENV: 'production', DATABASE_URL: '', PGHOST: '', PGUSER: '', PGPASSWORD: '', PGDATABASE: '' }),
    /encerrou antes de ficar pronto/
  );
});

test('o exemplo de configuracao nao traz credenciais reais', () => {
  const example = fs.readFileSync(path.join(PROJECT_ROOT, 'backend', '.env.example'), 'utf8');
  assert.match(example, /^SMTP_PASS=$/m);
  assert.match(example, /^SMTP_USER=$/m);
  assert.match(example, /SUA_SENHA/);
  assert.doesNotMatch(example, /postgres:postgres@/);

  const gitignore = fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^(backend\/)?\.env$/m, 'o .env precisa ficar fora do Git');
  assert.match(gitignore, /^!\.env\.example$|^(?![\s\S]*\.env\.\*)/m, 'o .env.example precisa continuar versionado');
  assert.match(gitignore, /^backend\/database\/data\/$/m, 'os usuarios gravados pelo backend em C ficam fora do Git');
});
