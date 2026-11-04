// Backend em C: compila em uma pasta temporaria e testa contra o executavel de verdade.
// Pulado (com aviso) quando nao ha gcc ou OpenSSL na maquina.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const C_DIR = path.join(__dirname, '..', 'backend', 'c');
const FRONTEND = path.join(__dirname, '..', 'frontend');
const PASSWORD = 'Senha1234';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxy-c-'));

function compile(output, extraFlags = []) {
  const sources = fs.readdirSync(path.join(C_DIR, 'src')).map(file => path.join(C_DIR, 'src', file));
  const result = spawnSync(process.env.CC || 'gcc', [
    '-Wall', '-Wextra', '-Werror', '-std=c11', '-O2', '-D_POSIX_C_SOURCE=200809L', '-pthread',
    `-I${path.join(C_DIR, 'include')}`, `-I${path.join(C_DIR, 'vendor', 'cjson')}`,
    ...extraFlags, ...sources, path.join(C_DIR, 'vendor', 'cjson', 'cJSON.c'), '-lcrypto', '-o', output
  ], { encoding: 'utf8' });
  return result.status === 0 ? '' : (result.error?.message || result.stderr);
}

const binary = path.join(workDir, 'fluxy-api');
const smallBinary = path.join(workDir, 'fluxy-api-2-sessoes');
const tinyLimitBinary = path.join(workDir, 'fluxy-api-3-contadores');
const buildProblem = compile(binary) || compile(smallBinary, ['-DSESSION_STORE_MAX=2'])
  || compile(tinyLimitBinary, ['-DRATE_LIMIT_MAX_KEYS=3']);
const skip = buildProblem ? `backend em C nao compilou nesta maquina (precisa de gcc e OpenSSL): ${buildProblem.split('\n')[0]}` : false;

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function newRoot() {
  const root = fs.mkdtempSync(path.join(workDir, 'raiz-'));
  fs.symlinkSync(FRONTEND, path.join(root, 'frontend'), 'dir');
  fs.mkdirSync(path.join(root, 'backend', 'database', 'data'), { recursive: true });
  return root;
}

const usersFile = root => path.join(root, 'backend', 'database', 'data', 'fluxy-users.db');

async function startC({ root = newRoot(), executable = binary, env = {} } = {}) {
  const port = await freePort();
  const child = spawn(executable, [String(port)], { env: { ...process.env, FLUXY_ROOT: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Object.assign(new Error(`o backend em C encerrou: ${output}`), { exitCode: child.exitCode });
    if (await fetch(`${baseUrl}/health`).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return {
    root, port, baseUrl, output: () => output,
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    })
  };
}

function client(baseUrl) {
  const state = { cookie: '', setCookie: '' };
  state.request = async (method, pathname, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'X-Fluxy-Request': '1' }),
        ...(state.cookie ? { Cookie: `fluxy_session=${state.cookie}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      state.setCookie = setCookie;
      state.cookie = /Max-Age=0/.test(setCookie) ? '' : setCookie.split(';')[0].split('=')[1];
    }
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch (_error) { /* corpo nao JSON */ }
    return { status: response.status, data, headers: response.headers };
  };
  state.post = (pathname, body = {}) => state.request('POST', pathname, body);
  state.get = pathname => state.request('GET', pathname);
  return state;
}

let server;
test.before(async () => { if (!skip) server = await startC(); });
test.after(async () => {
  await server?.stop();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const register = (baseUrl, overrides = {}) => {
  const visitor = client(baseUrl);
  return visitor.post('/api/auth/register', { name: 'Pessoa C', email: `c-${crypto.randomBytes(4).toString('hex')}@teste.fluxy.invalid`, password: PASSWORD, ...overrides })
    .then(response => ({ visitor, response }));
};

test('C: cadastro abre a sessao por cookie HttpOnly, sem token no corpo', { skip }, async () => {
  const { visitor, response } = await register(server.baseUrl);
  assert.equal(response.status, 201);
  assert.equal(response.data.token, undefined);
  assert.match(visitor.setCookie, /^fluxy_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal((await visitor.get('/api/me')).data.email, response.data.email);
  assert.ok(response.headers.get('content-security-policy'), 'mesma CSP do backend Node');
});

test('C: senha gravada com scrypt (formato do backend Node), nunca em texto puro', { skip }, async () => {
  const email = `scrypt-${Date.now()}@teste.fluxy.invalid`;
  await register(server.baseUrl, { email });
  const line = fs.readFileSync(usersFile(server.root), 'utf8').split('\n').find(row => row.includes(email));
  const [, , , , , salt, hash] = line.split('\t');
  assert.match(salt, /^[a-f0-9]{32}$/);
  assert.match(hash, /^[a-f0-9]{128}$/);
  assert.ok(!line.includes(PASSWORD));
  const expected = crypto.scryptSync(PASSWORD, salt, 64).toString('hex');
  assert.equal(hash, expected, 'o mesmo hash que o backend Node calcula');
});

test('C: JSON invalido, campo de outro tipo e texto longo demais sao recusados (sem truncar)', { skip }, async () => {
  const visitor = client(server.baseUrl);
  assert.equal((await visitor.post('/api/auth/login', '{"email":')).data.error, 'invalid_json');
  assert.equal((await visitor.post('/api/auth/login', '["a"]')).data.error, 'invalid_json');
  assert.equal((await visitor.post('/api/auth/register', { name: ['x'], email: 'a@b.com', password: PASSWORD })).status, 400);

  const longPassword = 'Aa1' + 'x'.repeat(130);
  const tooLong = await register(server.baseUrl, { password: longPassword });
  assert.equal(tooLong.response.status, 400, 'senha acima de 128 caracteres nao e cortada em silencio');
});

test('C: uma chave escrita dentro de um valor nao e confundida com o campo', { skip }, async () => {
  const name = 'Ana "email":"falso@x.com" Lima';
  const { response, visitor } = await register(server.baseUrl, { name });
  assert.equal(response.status, 201);
  assert.equal((await visitor.get('/api/me')).data.name, name);
  assert.notEqual(response.data.email, 'falso@x.com');
});

test('C: "manter conectado" define a duracao do cookie', { skip }, async () => {
  const email = `lembrar-${Date.now()}@teste.fluxy.invalid`;
  await register(server.baseUrl, { email });
  const short = client(server.baseUrl);
  await short.post('/api/auth/login', { email, password: PASSWORD });
  assert.doesNotMatch(short.setCookie, /Max-Age/);
  const long = client(server.baseUrl);
  await long.post('/api/auth/login', { email, password: PASSWORD, remember: true });
  assert.match(long.setCookie, /Max-Age=2592000/);
});

test('C: logout encerra so a sessao atual', { skip }, async () => {
  const email = `logout-${Date.now()}@teste.fluxy.invalid`;
  await register(server.baseUrl, { email });
  const laptop = client(server.baseUrl);
  const phone = client(server.baseUrl);
  await laptop.post('/api/auth/login', { email, password: PASSWORD });
  await phone.post('/api/auth/login', { email, password: PASSWORD });

  const laptopToken = laptop.cookie;
  const logout = await laptop.post('/api/auth/logout');
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const reused = client(server.baseUrl);
  reused.cookie = laptopToken;
  assert.equal((await reused.get('/api/me')).status, 401, 'o token encerrado nao vale mais');
  assert.equal((await phone.get('/api/me')).status, 200, 'o outro aparelho continua conectado');
});

test('C: gravacoes sem o cabecalho anti-CSRF sao recusadas', { skip }, async () => {
  const response = await fetch(`${server.baseUrl}/api/auth/login`, { method: 'POST', body: JSON.stringify({ email: 'a@b.com', password: PASSWORD }) });
  assert.equal(response.status, 403);
});

function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let answer = '';
    socket.on('data', chunk => { answer += chunk; });
    socket.on('end', () => resolve(answer));
    socket.on('error', reject);
  });
}

test('C: corpo acima do limite recebe 413 e Content-Length invalido recebe 400', { skip }, async () => {
  const tooLarge = await rawRequest(server.port, 'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nX-Fluxy-Request: 1\r\nContent-Length: 300000\r\n\r\n');
  assert.match(tooLarge, /^HTTP\/1\.1 413/);
  const invalid = await rawRequest(server.port, 'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\n\r\n');
  assert.match(invalid, /^HTTP\/1\.1 400/);
});

test('C: um cliente parado nao impede o atendimento dos outros', { skip }, async () => {
  const stalled = net.connect(server.port, '127.0.0.1');
  await new Promise(resolve => stalled.once('connect', resolve));
  stalled.write('POST /api/auth/login HTTP/1.1\r\nHost: x\r\n');
  try {
    const started = Date.now();
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.ok(Date.now() - started < 2000, `respondeu em ${Date.now() - started} ms`);
  } finally {
    stalled.destroy();
  }
});

test('C: tabela de sessoes cheia recusa a nova sessao sem derrubar as existentes', { skip }, async () => {
  const small = await startC({ executable: smallBinary });
  try {
    const email = `cheia-${Date.now()}@teste.fluxy.invalid`;
    const first = (await register(small.baseUrl, { email })).visitor;
    const second = client(small.baseUrl);
    assert.equal((await second.post('/api/auth/login', { email, password: PASSWORD })).status, 200);

    const third = await client(small.baseUrl).post('/api/auth/login', { email, password: PASSWORD });
    assert.equal(third.status, 503);
    assert.equal(third.data.error, 'session_unavailable');
    assert.equal((await first.get('/api/me')).status, 200, 'a primeira sessao nao foi sobrescrita');
    assert.equal((await second.get('/api/me')).status, 200);

    await first.post('/api/auth/logout');
    assert.equal((await client(small.baseUrl).post('/api/auth/login', { email, password: PASSWORD })).status, 200, 'a posicao liberada e reutilizada');
  } finally {
    await small.stop();
  }
});

test('C: conta com o hash antigo (SHA-256 iterado) entra e e regravada em scrypt', { skip }, async () => {
  const root = newRoot();
  const salt = crypto.randomBytes(16).toString('hex');
  let digest = crypto.createHash('sha256').update(`${salt}:${PASSWORD}`).digest();
  for (let round = 0; round < 120000; round++) digest = crypto.createHash('sha256').update(digest).update(salt).digest();
  fs.writeFileSync(usersFile(root), `7\tConta Antiga\tantiga@teste.fluxy.invalid\t-\t-\t${salt}\t${digest.toString('hex')}\t-\t-\t-\t2024-01-01T00:00:00Z\n`);

  const legacy = await startC({ root });
  try {
    const visitor = client(legacy.baseUrl);
    assert.equal((await visitor.post('/api/auth/login', { email: 'antiga@teste.fluxy.invalid', password: 'Errada123' })).status, 401);
    const login = await visitor.post('/api/auth/login', { email: 'antiga@teste.fluxy.invalid', password: PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.data.id, 7);
    const [, , , , , newSalt, newHash] = fs.readFileSync(usersFile(root), 'utf8').trim().split('\t');
    assert.match(newHash, /^[a-f0-9]{128}$/, 'regravado no formato novo');
    assert.equal(newHash, crypto.scryptSync(PASSWORD, newSalt, 64).toString('hex'));
  } finally {
    await legacy.stop();
  }
});

test('C: falha ao gravar o arquivo de usuarios nao apaga o original', { skip }, async () => {
  const email = `antes-${Date.now()}@teste.fluxy.invalid`;
  await register(server.baseUrl, { email });
  const before = fs.readFileSync(usersFile(server.root), 'utf8');

  fs.mkdirSync(`${usersFile(server.root)}.tmp`);
  try {
    const failed = await register(server.baseUrl, { email: `depois-${Date.now()}@teste.fluxy.invalid` });
    assert.equal(failed.response.status, 500);
    assert.equal(fs.readFileSync(usersFile(server.root), 'utf8'), before, 'o arquivo anterior continua intacto');
    assert.equal(failed.response.headers.get('set-cookie'), null, 'nenhuma sessao para um cadastro que nao foi salvo');
  } finally {
    fs.rmdirSync(`${usersFile(server.root)}.tmp`);
  }
  assert.equal((await register(server.baseUrl)).response.status, 201, 'depois do problema o servidor volta a gravar');
});

test('C: arquivo de usuarios ilegivel impede o servidor de iniciar (em vez de sobrescreve-lo)', { skip }, async () => {
  const root = newRoot();
  fs.mkdirSync(usersFile(root));
  await assert.rejects(startC({ root }), /nao foi possivel ler/);
});

test('C: empresa so grava JSON valido, exige login e devolve o que foi salvo', { skip }, async () => {
  const { visitor } = await register(server.baseUrl);
  assert.equal((await client(server.baseUrl).post('/api/company', { name: 'X' })).status, 401);
  assert.equal((await visitor.post('/api/company', '{"name": "Loja", }')).status, 400);
  assert.equal((await visitor.post('/api/company', { name: 'Loja "Boa"', city: 'Recife' })).status, 200);
  assert.deepEqual((await visitor.get('/api/company')).data, { company: { name: 'Loja "Boa"', city: 'Recife' } });
});

test('C: arquivos estaticos aceitam so GET/HEAD e nunca saem da pasta do site', { skip }, async () => {
  const head = await fetch(`${server.baseUrl}/index.html`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  assert.equal((await fetch(`${server.baseUrl}/index.html`, { method: 'POST' })).status, 405);
  for (const pathname of ['/../package.json', '/%2e%2e/package.json', '/css/..%2f..%2fpackage.json']) {
    assert.ok([403, 404].includes((await fetch(`${server.baseUrl}${pathname}`)).status), pathname);
  }
  const library = await fetch(`${server.baseUrl}/vendor/chart-4.5.1.umd.min.js`);
  assert.equal(library.status, 200);
  assert.equal(Number(library.headers.get('content-length')), fs.statSync(path.join(FRONTEND, 'vendor', 'chart-4.5.1.umd.min.js')).size, 'arquivo grande chega inteiro');
});

test('C: cada conta so le e grava a propria empresa', { skip }, async () => {
  const { visitor: ana } = await register(server.baseUrl, { name: 'Ana' });
  const { visitor: bia } = await register(server.baseUrl, { name: 'Bia' });

  assert.equal((await ana.post('/api/company', { name: 'Empresa da Ana' })).status, 200);
  assert.deepEqual((await bia.get('/api/company')).data, { company: null }, 'Bia nao enxerga a empresa da Ana');

  assert.equal((await bia.post('/api/company', { name: 'Empresa da Bia' })).status, 200);
  assert.deepEqual((await ana.get('/api/company')).data, { company: { name: 'Empresa da Ana' } }, 'nem sobrescreve');
});

test('C: /health nao expoe dados internos', { skip }, async () => {
  assert.deepEqual(await (await fetch(`${server.baseUrl}/health`)).json(), { status: 'ok', engine: 'c' });
});

test('C: cinco senhas erradas bloqueiam a conta, inclusive com a senha certa', { skip }, async () => {
  const limited = await startC();
  try {
    const email = `forca-${Date.now()}@teste.fluxy.invalid`;
    await register(limited.baseUrl, { email });
    const attacker = client(limited.baseUrl);

    for (let attempt = 0; attempt < 4; attempt++) {
      assert.equal((await attacker.post('/api/auth/login', { email, password: `Errada${attempt}A` })).status, 401);
    }
    assert.equal((await attacker.post('/api/auth/login', { email, password: PASSWORD })).status, 200, 'acertar zera a contagem');

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await attacker.post('/api/auth/login', { email, password: `Errada${attempt}A` })).status, 401);
    }
    const blocked = await attacker.post('/api/auth/login', { email, password: PASSWORD });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.error, 'too_many_requests');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    const unknown = `fantasma-${Date.now()}@teste.fluxy.invalid`;
    for (let attempt = 0; attempt < 5; attempt++) await attacker.post('/api/auth/login', { email: unknown, password: PASSWORD });
    assert.equal((await attacker.post('/api/auth/login', { email: unknown, password: PASSWORD })).status, 429, 'e-mail inexistente tambem bloqueia');

    const other = `outra-${Date.now()}@teste.fluxy.invalid`;
    await register(limited.baseUrl, { email: other });
    assert.equal((await client(limited.baseUrl).post('/api/auth/login', { email: other, password: PASSWORD })).status, 200, 'outra conta continua entrando');
  } finally {
    await limited.stop();
  }
});

test('C: mais de 50 tentativas de login do mesmo IP em 15 minutos sao bloqueadas', { skip }, async () => {
  const limited = await startC();
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 51; attempt++) {
      statuses.push((await client(limited.baseUrl).post('/api/auth/login', { email: `ip-${attempt}@teste.fluxy.invalid`, password: PASSWORD })).status);
    }
    assert.ok(statuses.slice(0, 50).every(status => status === 401));
    assert.equal(statuses[50], 429);
  } finally {
    await limited.stop();
  }
});

test('C: cadastros em sequencia do mesmo IP sao limitados', { skip }, async () => {
  const limited = await startC();
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 21; attempt++) statuses.push((await register(limited.baseUrl)).response.status);
    assert.deepEqual(statuses, [...Array(20).fill(201), 429]);
  } finally {
    await limited.stop();
  }
});

test('C: senhas erradas enviadas ao mesmo tempo nao driblam o bloqueio', { skip }, async () => {
  const limited = await startC();
  try {
    const email = `paralelo-${Date.now()}@teste.fluxy.invalid`;
    await register(limited.baseUrl, { email });
    const statuses = await Promise.all(Array.from({ length: 15 }, (_, attempt) =>
      client(limited.baseUrl).post('/api/auth/login', { email, password: `Errada${attempt}A` }).then(response => response.status)
    ));
    assert.equal(statuses.filter(status => status === 401).length, 5, statuses.join(','));
    assert.equal((await client(limited.baseUrl).post('/api/auth/login', { email, password: PASSWORD })).status, 429);
  } finally {
    await limited.stop();
  }
});

test('C: com a tabela de contadores cheia, nenhum bloqueio ativo e descartado', { skip }, async () => {
  const limited = await startC({ executable: tinyLimitBinary });
  try {
    const email = `cheio-${Date.now()}@teste.fluxy.invalid`;
    // 3 contadores: login por IP, falhas por e-mail+IP e falhas por e-mail.
    for (let attempt = 0; attempt < 5; attempt++) await client(limited.baseUrl).post('/api/auth/login', { email, password: 'Errada1A' });
    assert.equal((await client(limited.baseUrl).post('/api/auth/login', { email, password: 'Errada1A' })).status, 429);

    const other = await client(limited.baseUrl).post('/api/auth/login', { email: 'outro@teste.fluxy.invalid', password: 'Errada1A' });
    assert.equal(other.status, 503, 'sem espaco para contar, a tentativa e recusada, nunca liberada');
    assert.equal((await client(limited.baseUrl).post('/api/auth/login', { email, password: 'Errada1A' })).status, 429, 'o bloqueio anterior continua');
  } finally {
    await limited.stop();
  }
});

test('C: arquivos de dados ficam legiveis so pelo dono (0600)', { skip: skip || process.platform === 'win32' }, async () => {
  const root = newRoot();
  fs.chmodSync(path.dirname(usersFile(root)), 0o755);
  fs.writeFileSync(usersFile(root), '', { mode: 0o644 });
  fs.chmodSync(usersFile(root), 0o644);
  const fresh = await startC({ root });
  try {
    assert.equal(fs.statSync(usersFile(root)).mode & 0o777, 0o600, 'arquivo antigo com 0644 e corrigido ao iniciar');
    assert.equal(fs.statSync(path.dirname(usersFile(root))).mode & 0o777, 0o700, 'pasta de dados so do dono');
    const { visitor } = await register(fresh.baseUrl);
    assert.equal(fs.statSync(usersFile(root)).mode & 0o777, 0o600);
    await visitor.post('/api/company', { name: 'Privada' });
    const company = fs.readdirSync(path.dirname(usersFile(root))).find(file => file.startsWith('fluxy-company-'));
    assert.equal(fs.statSync(path.join(path.dirname(usersFile(root)), company)).mode & 0o777, 0o600);
  } finally {
    await fresh.stop();
  }
});

