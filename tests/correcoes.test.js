// Testes de regressao das correcoes da revisao tecnica (um bloco por problema).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  SESSION_COOKIE, PROJECT_ROOT, PASSWORD, startServer, createClient, registerAccount, newEmail, db, cleanup, nextFakeIp
} = require('./helpers/server');

let server;
let baseUrl;

test.before(async () => {
  server = await startServer();
  baseUrl = server.baseUrl;
});

test.after(async () => {
  await server?.stop();
  await cleanup();
  await require('../backend/src/lib/db').pool.end();
});

const anonymous = options => createClient(baseUrl, options);

// ---------- 1. health ----------

test('health: 200 com o banco no ar', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', database: 'connected' });
});

// ---------- 2. cadastros simultaneos ----------

test('cadastro por nome: vendas simultaneas com o mesmo cliente criam um unico cadastro', async () => {
  const { client, account } = await registerAccount(baseUrl);
  const names = ['Cliente Concorrente', 'cliente concorrente', 'CLIENTE CONCORRENTE'];

  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    client.post('/api/transacoes', { tipo: 'entrada', descricao: `Venda ${index}`, valor: 10, cliente: names[index % 3] })
  ));
  assert.ok(responses.every(response => response.status === 201), responses.map(r => r.status).join(','));
  assert.ok(responses.every(response => response.data.cliente === 'Cliente Concorrente'), 'o nome sai como esta gravado');

  const { rows } = await db().query(
    "SELECT count(*)::int AS total FROM cliente c JOIN usuario u ON u.empresa_id = c.empresa_id WHERE u.id = $1 AND lower(c.nome) = 'cliente concorrente'",
    [account.id]
  );
  assert.equal(rows[0].total, 1);
});

test('cadastro por nome: produtos simultaneos com o mesmo fornecedor criam um unico fornecedor', async () => {
  const { client } = await registerAccount(baseUrl);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    client.post('/api/produtos', { name: `Produto ${index}`, code: `P-${index}`, supplier: index % 2 ? 'Distribuidora X' : 'distribuidora x' })
  ));
  assert.ok(responses.every(response => response.status === 201));
  const suppliers = (await client.get('/api/fornecedores')).data;
  assert.equal(suppliers.length, 1);
  assert.ok(responses.every(response => response.data.supplier === suppliers[0].nome), 'todos apontam para o mesmo cadastro');
});

test('cadastro manual: nome repetido (ignorando maiusculas) responde 409 com mensagem clara', async () => {
  const { client } = await registerAccount(baseUrl);
  assert.equal((await client.post('/api/clientes', { nome: 'Ana Souza' })).status, 201);
  const duplicate = await client.post('/api/clientes', { nome: 'ANA SOUZA' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.message, 'Já existe um cliente com este nome.');

  assert.equal((await client.post('/api/fornecedores', { nome: 'Fornecedor Y' })).status, 201);
  assert.equal((await client.post('/api/fornecedores', { nome: 'fornecedor y' })).data.message, 'Já existe um fornecedor com este nome.');

  const { client: other } = await registerAccount(baseUrl);
  assert.equal((await other.post('/api/clientes', { nome: 'Ana Souza' })).status, 201, 'outra empresa pode ter o mesmo nome');
});

test('migracao: cadastros repetidos que ja existiam sao unidos antes do indice unico', async () => {
  const schema = `fluxy_migracao_${process.pid}`;
  const sql = fs.readFileSync(path.join(PROJECT_ROOT, 'backend', 'database', 'schema.sql'), 'utf8');
  const connection = await db().connect();
  try {
    await connection.query(`CREATE SCHEMA ${schema}`);
    await connection.query(`SET search_path TO ${schema}, public`);
    await connection.query(sql);
    await connection.query('DROP INDEX uq_cliente_empresa_nome; DROP INDEX uq_fornecedor_empresa_nome');

    const empresa = (await connection.query("INSERT INTO empresa (razao_social) VALUES ('Migracao') RETURNING id")).rows[0].id;
    const ids = (await connection.query(
      `INSERT INTO cliente (empresa_id, nome, email, telefone, observacoes) VALUES
         ($1, 'Maria', NULL, '1111', 'primeira'), ($1, 'MARIA', 'maria@x.com', '2222', 'segunda'), ($1, 'Joao', NULL, NULL, NULL)
       RETURNING id`, [empresa]
    )).rows.map(row => row.id);
    await connection.query("INSERT INTO transacao (empresa_id, cliente_id, tipo, descricao, valor) VALUES ($1, $2, 'entrada', 'Venda', 10)", [empresa, ids[1]]);
    await connection.query("INSERT INTO servico (empresa_id, cliente_id, descricao, valor) VALUES ($1, $2, 'Servico', 10)", [empresa, ids[1]]);
    const fornecedores = (await connection.query(
      "INSERT INTO fornecedor (empresa_id, nome, cidade) VALUES ($1, 'Forn', NULL), ($1, 'forn', 'Campinas') RETURNING id", [empresa]
    )).rows.map(row => row.id);
    await connection.query("INSERT INTO produto (empresa_id, fornecedor_id, nome) VALUES ($1, $2, 'Produto')", [empresa, fornecedores[1]]);

    await connection.query(sql);

    const clientes = (await connection.query('SELECT * FROM cliente ORDER BY id')).rows;
    assert.equal(clientes.length, 2);
    assert.deepEqual(
      { id: clientes[0].id, nome: clientes[0].nome, email: clientes[0].email, telefone: clientes[0].telefone, observacoes: clientes[0].observacoes },
      { id: ids[0], nome: 'Maria', email: 'maria@x.com', telefone: '1111', observacoes: 'primeira\nsegunda' },
      'fica o mais antigo, completado com os dados do repetido'
    );
    assert.equal((await connection.query('SELECT cliente_id FROM transacao')).rows[0].cliente_id, ids[0]);
    assert.equal((await connection.query('SELECT cliente_id FROM servico')).rows[0].cliente_id, ids[0]);
    const fornecedor = (await connection.query('SELECT * FROM fornecedor')).rows;
    assert.equal(fornecedor.length, 1);
    assert.equal(fornecedor[0].cidade, 'Campinas');
    assert.equal((await connection.query('SELECT fornecedor_id FROM produto')).rows[0].fornecedor_id, fornecedores[0]);

    await connection.query(sql);
    assert.equal((await connection.query('SELECT count(*)::int AS total FROM cliente')).rows[0].total, 2, 'rodar de novo nao muda nada');
  } finally {
    await connection.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    connection.release();
  }
});

// ---------- 3. sessao em cookie HttpOnly + CSRF ----------

test('sessao: o token vai num cookie HttpOnly e nunca no corpo da resposta', async () => {
  const email = newEmail('cookie');
  const client = anonymous();
  const register = await client.post('/api/auth/register', { name: 'Cookie', email, password: PASSWORD });
  assert.equal(register.status, 201);
  assert.equal(register.data.token, undefined);
  assert.match(client.lastSetCookie, new RegExp(`^${SESSION_COOKIE}=[a-f0-9]{64};`));
  assert.match(client.lastSetCookie, /HttpOnly/);
  assert.match(client.lastSetCookie, /SameSite=Strict/);
  assert.match(client.lastSetCookie, /Path=\//);
  assert.doesNotMatch(client.lastSetCookie, /Max-Age/, 'sem "manter conectado": cookie de sessao do navegador');
  assert.doesNotMatch(client.lastSetCookie, /Secure/, 'sem HTTPS (desenvolvimento) o cookie nao pode exigir Secure');

  const login = anonymous();
  const response = await login.post('/api/auth/login', { email, password: PASSWORD, remember: true });
  assert.equal(response.data.token, undefined);
  assert.match(login.lastSetCookie, /Max-Age=2592000/, 'com "manter conectado": 30 dias');

  assert.equal((await login.post('/api/auth/logout')).status, 200);
  assert.match(login.lastSetCookie, /Max-Age=0/, 'o logout apaga o cookie');
});

test('sessao: o antigo cabecalho Authorization: Bearer nao abre mais a sessao', async () => {
  const { client } = await registerAccount(baseUrl);
  const response = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${client.token}` } });
  assert.equal(response.status, 401);
});

test('sessao: com APP_URL em https o cookie exige Secure', async () => {
  const secure = await startServer({ APP_URL: 'https://fluxy.exemplo.test', MAIL_MODE: '' });
  try {
    const client = createClient(secure.baseUrl);
    await client.post('/api/auth/register', { name: 'Seguro', email: newEmail('secure'), password: PASSWORD });
    assert.match(client.lastSetCookie, /; Secure/);
  } finally {
    await secure.stop();
  }
});

test('CSRF: gravacoes sem o cabecalho X-Fluxy-Request sao recusadas, mesmo com sessao valida', async () => {
  const { client } = await registerAccount(baseUrl);
  const forged = createClient(baseUrl, { token: client.token, csrf: false });

  for (const [method, pathname, body] of [
    ['POST', '/api/clientes', { nome: 'Forjado' }],
    ['DELETE', '/api/me', { password: PASSWORD }],
    ['POST', '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Outra1234' }],
    ['POST', '/api/auth/login', { email: 'a@b.com', password: PASSWORD }]
  ]) {
    const response = await forged.request(method, pathname, body);
    assert.equal(response.status, 403, `${method} ${pathname}`);
    assert.equal(response.data.error, 'csrf_rejected');
  }
  assert.equal((await forged.get('/api/clientes')).status, 200, 'leituras continuam funcionando');
  assert.deepEqual((await client.get('/api/clientes')).data, [], 'nada foi gravado');
  assert.equal((await client.get('/api/me')).status, 200, 'a conta continua existindo');
});

test('CSRF: Origin de outro site e recusado; o proprio site e aceito', async () => {
  const { client } = await registerAccount(baseUrl);
  const host = new URL(baseUrl).host;

  const otherSite = await client.request('POST', '/api/clientes', { nome: 'De fora' }, { Origin: 'https://site-malicioso.test' });
  assert.equal(otherSite.status, 403);
  const sandboxed = await client.request('POST', '/api/clientes', { nome: 'Iframe' }, { Origin: 'null' });
  assert.equal(sandboxed.status, 403);
  const sameSite = await client.request('POST', '/api/clientes', { nome: 'Do proprio site' }, { Origin: `http://${host}` });
  assert.equal(sameSite.status, 201);
});

test('CSRF: atras de proxy, o endereco publico (APP_URL ou X-Forwarded-Host) conta como o proprio site', async () => {
  const proxied = await startServer({ APP_URL: 'https://fluxy.exemplo.test' });
  try {
    const { client } = await registerAccount(proxied.baseUrl);
    const viaAppUrl = await client.request('POST', '/api/clientes', { nome: 'Via APP_URL' }, { Origin: 'https://fluxy.exemplo.test' });
    assert.equal(viaAppUrl.status, 201, 'o Host interno do proxy nao bloqueia o site publico');
    const forwarded = await client.request('POST', '/api/clientes', { nome: 'Via proxy' }, {
      Origin: 'https://outro-nome.exemplo.test', 'X-Forwarded-Host': 'outro-nome.exemplo.test'
    });
    assert.equal(forwarded.status, 201, 'com TRUST_PROXY o X-Forwarded-Host vale');
  } finally {
    await proxied.stop();
  }

  const direct = await startServer({ TRUST_PROXY: '' });
  try {
    const { client } = await registerAccount(direct.baseUrl);
    const spoofed = await client.request('POST', '/api/clientes', { nome: 'Forjado' }, {
      Origin: 'https://site-malicioso.test', 'X-Forwarded-Host': 'site-malicioso.test'
    });
    assert.equal(spoofed.status, 403, 'sem TRUST_PROXY o X-Forwarded-Host e ignorado');
  } finally {
    await direct.stop();
  }
});

test('CSRF: origem listada em CORS_ORIGINS pode gravar e recebe permissao para enviar o cookie', async () => {
  const other = await startServer({ CORS_ORIGINS: 'https://meu-front.test' });
  try {
    const { client } = await registerAccount(other.baseUrl);
    const allowed = await client.request('POST', '/api/clientes', { nome: 'Via CORS' }, { Origin: 'https://meu-front.test' });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

    const preflight = await fetch(`${other.baseUrl}/api/clientes`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://meu-front.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-fluxy-request' }
    });
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-Fluxy-Request/);
  } finally {
    await other.stop();
  }
});

test('frontend: o token nao e guardado no navegador e toda gravacao envia o cabecalho anti-CSRF', () => {
  const read = file => fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'js', file), 'utf8');
  const api = read('core/api.js');
  const auth = read('core/auth.js');
  assert.doesNotMatch(api + auth, /setItem\([^)]*token/i, 'nenhum token vai para localStorage/sessionStorage');
  assert.doesNotMatch(api, /Authorization/);
  assert.match(api, /'X-Fluxy-Request'\] = '1'/);
  assert.match(api, /credentials: 'include'/);
});

// ---------- 4. modo local ----------

test('modo local: senha em texto puro deixa de ser aceita e ha chave para desativar o modo', () => {
  const auth = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'js', 'core', 'auth.js'), 'utf8');
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'index.html'), 'utf8');
  const matcher = auth.slice(auth.indexOf('async function localPasswordMatches'), auth.indexOf('let localPasswordMigration'));
  assert.doesNotMatch(matcher, /user\.password(?!Hash)/, 'a comparacao com texto puro foi removida');
  assert.match(auth, /migratePlaintextLocalPasswords/);
  assert.match(html, /<meta name="fluxy-local-mode" content="(demo|off)">/);
});

// ---------- 5. limite de tentativas no banco ----------

test('limite de tentativas: sobrevive ao reinicio do servidor e vale entre instancias', async () => {
  const { email } = await registerAccount(baseUrl);
  const ip = nextFakeIp();
  const first = await startServer();
  const second = await startServer();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await createClient(first.baseUrl, { ip }).post('/api/auth/login', { email, password: 'Errada123' })).status, 401);
    }
    await first.stop();

    const blocked = await createClient(second.baseUrl, { ip }).post('/api/auth/login', { email, password: PASSWORD });
    assert.equal(blocked.status, 429, 'outra instancia (ou o servidor reiniciado) enxerga o mesmo bloqueio');
  } finally {
    await first.stop();
    await second.stop();
  }
});

const { createRateLimiter, consume } = require('../backend/src/lib/rate-limit');
const statusOf = promise => promise.then(() => 200, error => error.status);
const limitName = label => `${label}-${process.pid}-${Date.now()}`;

test('limite de tentativas: bloqueia ao estourar e libera depois da janela', async () => {
  const limiter = createRateLimiter({ name: limitName('janela'), windowMs: 300, max: 3 });
  for (let attempt = 0; attempt < 3; attempt++) await consume(limiter, 'chave');
  const blocked = await consume(limiter, 'chave').catch(error => error);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.extra.retryAfter >= 1);
  assert.equal(await statusOf(consume(limiter, 'outra-chave')), 200, 'uma chave nao bloqueia a outra');

  await limiter.reset('chave');
  assert.equal(await statusOf(consume(limiter, 'chave')), 200, 'reset libera a chave');

  for (let attempt = 0; attempt < 3; attempt++) await consume(limiter, 'expira');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await statusOf(consume(limiter, 'expira')), 200, 'depois da janela as tentativas voltam');
});

test('limite de tentativas: pedidos simultaneos nao passam juntos e nomes diferentes nao se misturam', async () => {
  const limiter = createRateLimiter({ name: limitName('simultaneo'), windowMs: 60000, max: 3 });
  const statuses = await Promise.all(Array.from({ length: 10 }, () => statusOf(consume(limiter, 'mesma-chave'))));
  assert.equal(statuses.filter(status => status === 200).length, 3);

  const other = createRateLimiter({ name: limitName('outro'), windowMs: 60000, max: 3 });
  assert.equal(await statusOf(consume(other, 'mesma-chave')), 200);
});

test('limite de tentativas: senhas erradas enviadas ao mesmo tempo nao driblam o bloqueio', async () => {
  const { email } = await registerAccount(baseUrl);
  const ip = nextFakeIp();
  const statuses = await Promise.all(Array.from({ length: 15 }, (_, attempt) =>
    createClient(baseUrl, { ip }).post('/api/auth/login', { email, password: `Errada${attempt}A` }).then(response => response.status)
  ));
  assert.equal(statuses.filter(status => status === 401).length, 5, statuses.join(','));
  assert.equal(statuses.filter(status => status === 429).length, 10);
  assert.equal((await createClient(baseUrl, { ip }).post('/api/auth/login', { email, password: PASSWORD })).status, 429);
});

test('limite de tentativas: o banco guarda so o hash da chave, sem e-mail nem IP', async () => {
  const email = newEmail('limite');
  const ip = nextFakeIp();
  await anonymous({ ip }).post('/api/auth/login', { email, password: 'Errada123' });
  const { rows } = await db().query('SELECT chave FROM limite_tentativa');
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.chave)));
  assert.ok(!rows.some(row => row.chave.includes(email) || row.chave.includes(ip)));
});

// ---------- 6 e 10. paginacao por cursor ----------

async function seedTransactions(client, dates) {
  for (const [index, data] of dates.entries()) {
    const response = await client.post('/api/transacoes', {
      tipo: index % 2 ? 'saida' : 'entrada', descricao: `Lancamento ${index}`, valor: '10.00', data, categoria: index % 2 ? 'Aluguel' : 'Vendas'
    });
    assert.equal(response.status, 201);
  }
}

test('paginacao: transacoes vem em paginas pelo cursor, sem repetir nem pular', async () => {
  const { client } = await registerAccount(baseUrl);
  const dates = ['2026-01-05', '2026-03-10', '2026-03-10', '2026-02-01', '2026-03-10', '2025-12-31', '2026-01-05'];
  await seedTransactions(client, dates);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = new URLSearchParams({ limit: '3', ...(cursor ? { cursor } : {}) });
    const page = (await client.get(`/api/transacoes?${query}`)).data;
    assert.ok(page.items.length <= 3);
    seen.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);

  assert.equal(pages, 3);
  assert.equal(seen.length, dates.length);
  assert.equal(new Set(seen.map(item => item.id)).size, dates.length, 'nenhum item repetido');
  const order = seen.map(item => `${item.data}|${String(item.id).padStart(12, '0')}`);
  assert.deepEqual(order, [...order].sort().reverse(), 'mais recentes primeiro, desempate pelo id');

  const legacy = (await client.get('/api/transacoes')).data;
  assert.ok(Array.isArray(legacy) && legacy.length === dates.length, 'sem parametros o contrato antigo continua');
});

test('paginacao: busca e filtro de tipo rodam no servidor', async () => {
  const { client } = await registerAccount(baseUrl);
  await seedTransactions(client, ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);

  const income = (await client.get('/api/transacoes?tipo=entrada&limit=10')).data;
  assert.equal(income.items.length, 2);
  assert.ok(income.items.every(item => item.tipo === 'entrada'));

  const byCategory = (await client.get(`/api/transacoes?q=${encodeURIComponent('ALUG')}&limit=10`)).data;
  assert.equal(byCategory.items.length, 2, 'a busca olha a categoria, sem diferenciar maiusculas');
  const byDescription = (await client.get('/api/transacoes?q=lancamento%202')).data;
  assert.deepEqual(byDescription.items.map(item => item.descricao), ['Lancamento 2']);
  const wildcard = (await client.get(`/api/transacoes?q=${encodeURIComponent('%')}`)).data;
  assert.equal(wildcard.items.length, 0, '% e texto comum, nao curinga');
});

test('paginacao: cursor, limite e tipo invalidos recebem 400', async () => {
  const { client } = await registerAccount(baseUrl);
  for (const query of ['cursor=nao-e-cursor', `cursor=${Buffer.from('2026-13-40|1').toString('base64url')}`, 'limit=0', 'limit=abc', 'tipo=outro']) {
    const response = await client.get(`/api/transacoes?${query}`);
    assert.equal(response.status, 400, query);
  }
  const capped = (await client.get('/api/transacoes?limit=99999')).status;
  assert.equal(capped, 200, 'limite alto e reduzido ao maximo, nao recusado');
});

test('paginacao: movimentacoes de estoque tambem paginam', async () => {
  const { client } = await registerAccount(baseUrl);
  const product = (await client.post('/api/produtos', { name: 'Item', code: 'I-1', quantity: 1 })).data;
  for (let index = 0; index < 4; index++) {
    await client.post('/api/movimentacoes-estoque', { productId: product.id, quantity: 1, movement: 'entrada' });
  }
  const first = (await client.get('/api/movimentacoes-estoque?limit=3')).data;
  assert.equal(first.items.length, 3);
  const second = (await client.get(`/api/movimentacoes-estoque?limit=3&cursor=${first.nextCursor}`)).data;
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
});

test('carga inicial: traz so a primeira pagina, o cursor da proxima e os totais de tudo', async () => {
  const { client, account } = await registerAccount(baseUrl);
  const empresa = (await db().query('SELECT empresa_id FROM usuario WHERE id = $1', [account.id])).rows[0].empresa_id;
  await db().query(
    `INSERT INTO transacao (empresa_id, tipo, descricao, valor, data_transacao)
     SELECT $1, 'entrada', 'Venda ' || n, 0.10, DATE '2026-05-01' + (n % 20) FROM generate_series(1, 150) AS n`,
    [empresa]
  );

  const sync = (await client.get('/api/sync')).data;
  assert.equal(sync.transactions.length, 100);
  assert.ok(sync.pagination.transactions.nextCursor);
  assert.equal(sync.summary.totals.transactionCount, 150);
  assert.equal(sync.summary.totals.incomeCents, 1500, '150 x 0,10 = 15,00 exatos');
});

// ---------- 7. compressao assincrona ----------

test('compressao: resposta grande sai em gzip valido e preserva Vary: Origin do CORS', async () => {
  const other = await startServer({ CORS_ORIGINS: 'https://meu-front.test' });
  try {
    const { client } = await registerAccount(other.baseUrl);
    for (let index = 0; index < 40; index++) await client.post('/api/clientes', { nome: `Cliente ${index}` });

    const response = await fetch(`${other.baseUrl}/api/clientes`, {
      headers: { Cookie: `${SESSION_COOKIE}=${client.token}`, 'Accept-Encoding': 'gzip', Origin: 'https://meu-front.test' }
    });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.match(response.headers.get('vary'), /Origin/);
    assert.match(response.headers.get('vary'), /Accept-Encoding/);
    assert.equal((await response.json()).length, 40);

    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'backend', 'src', 'lib', 'http-helpers.js'), 'utf8')
      + fs.readFileSync(path.join(PROJECT_ROOT, 'backend', 'src', 'static-server.js'), 'utf8');
    assert.doesNotMatch(source, /gzipSync|readFileSync/, 'nada de compressao ou leitura sincrona no caminho das requisicoes');
    assert.ok(zlib.gzip, 'zlib disponivel');
  } finally {
    await other.stop();
  }
});

// ---------- 8. precisao em dinheiro ----------

test('dinheiro: valores sao gravados exatos e os totais saem em centavos', async () => {
  const { client, account } = await registerAccount(baseUrl);
  await client.post('/api/transacoes', { tipo: 'entrada', descricao: 'A', valor: 0.1, data: '2026-04-10', cliente: 'Maria' });
  await client.post('/api/transacoes', { tipo: 'entrada', descricao: 'B', valor: 0.2, data: '2026-04-11', cliente: 'maria' });
  const odd = await client.post('/api/transacoes', { tipo: 'entrada', descricao: 'C', valor: 1.005, data: '2026-05-01' });
  await client.post('/api/transacoes', { tipo: 'saida', descricao: 'D', valor: '1234,56', data: '2026-05-02', categoria: 'Aluguel' });
  await client.post('/api/transacoes', { tipo: 'saida', descricao: 'E', valor: '0.01', data: '2026-05-03' });
  assert.equal(odd.data.valor, 1.01, '1,005 arredonda para 1,01 (com Number virava 1,00)');

  const empresa = (await db().query('SELECT empresa_id FROM usuario WHERE id = $1', [account.id])).rows[0].empresa_id;
  const stored = (await db().query("SELECT valor::text FROM transacao WHERE empresa_id = $1 AND descricao = 'C'", [empresa])).rows[0].valor;
  assert.equal(stored, '1.01');

  const summary = (await client.get('/api/resumo')).data;
  assert.deepEqual(summary.totals, { incomeCents: 131, expenseCents: 123457, incomeCount: 3, transactionCount: 5 });
  assert.deepEqual(summary.monthly, [
    { month: '2026-04', incomeCents: 30, expenseCents: 0 },
    { month: '2026-05', incomeCents: 101, expenseCents: 123457 }
  ]);
  assert.deepEqual(summary.expensesByCategory, [{ category: 'Aluguel', cents: 123456 }, { category: 'Geral', cents: 1 }]);
  assert.deepEqual(summary.incomeByCustomer, [{ customer: 'Maria', cents: 30 }]);
});

test('dinheiro: /api/resumo exige login e so aceita GET', async () => {
  assert.equal((await anonymous().get('/api/resumo')).status, 401);
  const { client } = await registerAccount(baseUrl);
  assert.equal((await client.post('/api/resumo', {})).status, 405);
});
