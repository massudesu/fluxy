const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { PASSWORD, startServer, createClient, registerAccount, newEmail, db, cleanup } = require('./helpers/server');
const { startFakeSmtp, parseMessage } = require('./helpers/fake-smtp');
const { hashToken } = require('../backend/src/lib/security');

const SMTP_LOGIN = { user: 'envio@fluxy.test', pass: 'senha-do-smtp-de-teste' };
const APP_URL = 'https://fluxy.exemplo.test';
const NEW_PASSWORD = 'NovaSenha2026';

let smtp;
let server;
let baseUrl;

const smtpEnv = port => ({
  APP_URL,
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(port),
  SMTP_SECURE: 'false',
  SMTP_REQUIRE_TLS: 'false',
  SMTP_USER: SMTP_LOGIN.user,
  SMTP_PASS: SMTP_LOGIN.pass,
  MAIL_FROM: 'Fluxy <envio@fluxy.test>'
});

test.before(async () => {
  smtp = await startFakeSmtp({ credentials: SMTP_LOGIN });
  server = await startServer(smtpEnv(smtp.port));
  baseUrl = server.baseUrl;
});

test.after(async () => {
  await server?.stop();
  await smtp?.close();
  await cleanup();
});

const anonymous = () => createClient(baseUrl);
const forgot = (email, client = anonymous()) => client.post('/api/auth/forgot-password', { email });
const reset = (token, password = NEW_PASSWORD) => anonymous().post('/api/auth/reset-password', { token, password });
const loginStatus = async (email, password) => (await anonymous().post('/api/auth/login', { email, password })).status;

function lastMailTo(email) {
  const message = [...smtp.state.messages].reverse().find(item => item.to.includes(email));
  return message ? parseMessage(message.raw) : null;
}

function tokenFrom(mail) {
  const match = mail.text.match(/#redefinir=([a-f0-9]{64})/);
  assert.ok(match, 'o e-mail precisa trazer o link de redefinicao');
  return match[1];
}

async function requestToken(email) {
  const response = await forgot(email);
  assert.equal(response.status, 200);
  return tokenFrom(lastMailTo(email));
}

test('fluxo completo: pedir o link, receber o e-mail, criar a senha e entrar', async () => {
  const { client: oldSession, email } = await registerAccount(baseUrl, { name: 'Marina Costa' });

  const response = await forgot(email);
  assert.equal(response.status, 200);
  assert.equal(response.data.delivery, 'smtp');
  assert.match(response.data.message, /Se este e-mail tiver uma conta/);
  assert.equal(response.data.token, undefined, 'o token nunca volta na resposta da API');
  assert.doesNotMatch(JSON.stringify(response.data), /[a-f0-9]{64}/);

  const mail = lastMailTo(email);
  assert.ok(mail, 'o servidor SMTP recebeu a mensagem');
  assert.equal(mail.subject, 'Fluxy: redefinição de senha');
  assert.match(mail.headers.from, /envio@fluxy\.test/);
  assert.match(mail.text, /Olá, Marina!/);
  assert.match(mail.text, /30 minutos/);
  assert.match(mail.html, /Criar nova senha/);

  const token = tokenFrom(mail);
  assert.ok(mail.text.includes(`${APP_URL}/index.html#redefinir=${token}`), 'o link aponta para a pagina certa do site');
  assert.ok(mail.html.includes(`${APP_URL}/index.html#redefinir=${token}`));

  const stored = await db().query('SELECT token_hash, utilizado, expira_em FROM redefinicao_senha r JOIN usuario u ON u.id = r.usuario_id WHERE u.email = $1', [email]);
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].token_hash, hashToken(token), 'no banco fica so o hash do token');
  assert.notEqual(stored.rows[0].token_hash, token);
  const minutesLeft = (new Date(stored.rows[0].expira_em) - Date.now()) / 60000;
  assert.ok(minutesLeft > 29 && minutesLeft <= 30, `validade de 30 minutos (restam ${minutesLeft.toFixed(1)})`);

  assert.deepEqual((await anonymous().post('/api/auth/reset-password/validate', { token })).data, { valid: true });

  const changed = await reset(token);
  assert.equal(changed.status, 200);
  assert.match(changed.data.message, /Senha alterada/);
  assert.equal(changed.data.email, undefined, 'a resposta nao devolve o e-mail da conta');

  assert.equal(await loginStatus(email, PASSWORD), 401, 'a senha antiga deixa de valer');
  assert.equal(await loginStatus(email, NEW_PASSWORD), 200, 'a senha nova funciona');
  assert.equal((await oldSession.get('/api/me')).status, 401, 'as sessoes abertas com a senha antiga caem');

  const saved = await db().query('SELECT senha_hash FROM usuario WHERE email = $1', [email]);
  assert.match(saved.rows[0].senha_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/, 'a nova senha e gravada com hash');
  assert.ok(!saved.rows[0].senha_hash.includes(NEW_PASSWORD));
});

test('o link so funciona uma vez', async () => {
  const { email } = await registerAccount(baseUrl);
  const token = await requestToken(email);

  assert.equal((await reset(token)).status, 200);

  const again = await reset(token, 'OutraSenha2026');
  assert.equal(again.status, 400);
  assert.equal(again.data.error, 'invalid_token');
  assert.deepEqual((await anonymous().post('/api/auth/reset-password/validate', { token })).data, { valid: false });
  assert.equal(await loginStatus(email, 'OutraSenha2026'), 401);
  assert.equal(await loginStatus(email, NEW_PASSWORD), 200);
});

test('dois usos simultaneos do mesmo link: apenas um e aceito', async () => {
  const { email } = await registerAccount(baseUrl);
  const token = await requestToken(email);

  const results = await Promise.all([reset(token, 'PrimeiraSenha1'), reset(token, 'SegundaSenha2')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
});

test('link expirado e recusado', async () => {
  const { email } = await registerAccount(baseUrl);
  const token = await requestToken(email);
  await db().query("UPDATE redefinicao_senha SET expira_em = now() - interval '1 second' WHERE token_hash = $1", [hashToken(token)]);

  assert.deepEqual((await anonymous().post('/api/auth/reset-password/validate', { token })).data, { valid: false });
  const response = await reset(token);
  assert.equal(response.status, 400);
  assert.equal(response.data.error, 'invalid_token');
  assert.equal(await loginStatus(email, PASSWORD), 200, 'a senha continua a mesma');
});

test('um novo pedido invalida o link anterior', async () => {
  const { email } = await registerAccount(baseUrl);
  const first = await requestToken(email);
  const second = await requestToken(email);

  assert.notEqual(first, second);
  assert.equal((await reset(first)).status, 400);
  assert.equal((await reset(second)).status, 200);
});

test('token inventado, vazio ou de formato estranho e recusado', async () => {
  for (const token of ['a'.repeat(64), '', undefined, 12345, { $gt: '' }, "' OR 1=1 --"]) {
    const response = await reset(token);
    assert.equal(response.status, 400, `token ${JSON.stringify(token)}`);
    assert.equal(response.data.error, 'invalid_token');
  }
});

test('senha fraca e recusada e o link continua valido para tentar de novo', async () => {
  const { email } = await registerAccount(baseUrl);
  const token = await requestToken(email);

  for (const password of ['curta1A', 'semmaiuscula1', 'SEMMINUSCULA1', 'SemNumeroAqui']) {
    const response = await reset(token, password);
    assert.equal(response.status, 400);
    assert.equal(response.data.error, 'weak_password');
  }
  assert.equal(await loginStatus(email, PASSWORD), 200);
  assert.equal((await reset(token)).status, 200);
});

test('e-mail sem conta recebe exatamente a mesma resposta e nenhum e-mail e enviado', async () => {
  const { email: existing } = await registerAccount(baseUrl);
  const unknown = newEmail('sem-conta');

  const forExisting = await forgot(existing);
  const before = { messages: smtp.state.messages.length, connections: smtp.state.connections };
  const forUnknown = await forgot(unknown);

  assert.equal(forUnknown.status, forExisting.status);
  assert.deepEqual(forUnknown.data, forExisting.data, 'a resposta nao pode revelar se a conta existe');
  assert.equal(smtp.state.messages.length, before.messages, 'nada e enviado para quem nao tem conta');
  assert.equal(smtp.state.connections, before.connections + 1, 'o servidor de e-mail e consultado nos dois casos');
  assert.equal(lastMailTo(unknown), null);
});

test('conta desativada nao recebe link', async () => {
  const { email } = await registerAccount(baseUrl);
  await db().query('UPDATE usuario SET ativo = FALSE WHERE email = $1', [email]);

  assert.equal((await forgot(email)).status, 200);
  assert.equal(lastMailTo(email), null);
});

test('e-mail invalido e recusado antes de qualquer envio', async () => {
  for (const email of ['', 'sem-arroba', 'a@b', 'x@y.com\r\nBcc: z@w.com', { $ne: 1 }]) {
    assert.equal((await forgot(email)).status, 400, `e-mail ${JSON.stringify(email)}`);
  }
});

test('o link usa APP_URL e ignora o cabecalho Host enviado pelo visitante', async () => {
  const { email } = await registerAccount(baseUrl);

  const status = await new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { Host: 'site-do-atacante.test', 'X-Forwarded-Host': 'site-do-atacante.test', 'Content-Type': 'application/json', 'X-Fluxy-Request': '1', 'X-Forwarded-For': '10.99.99.1' }
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ email }));
  });

  assert.equal(status, 200);
  const mail = lastMailTo(email);
  assert.ok(mail.text.includes(`${APP_URL}/index.html#redefinir=`));
  assert.ok(!mail.text.includes('atacante') && !mail.html.includes('atacante'));
});

test('limite de pedidos: o 4o pedido seguido para o mesmo e-mail e bloqueado', async () => {
  const { email } = await registerAccount(baseUrl);

  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await forgot(email)).status, 200);
  const blocked = await forgot(email);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  const unknown = newEmail('limite');
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await forgot(unknown)).status, 200);
  assert.equal((await forgot(unknown)).status, 429, 'o limite vale igual para e-mail sem conta');
});

test('limite de pedidos: o 6o pedido seguido do mesmo IP e bloqueado', async () => {
  const client = anonymous();
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await forgot(newEmail('ip'), client)).status, 200);
  assert.equal((await forgot(newEmail('ip'), client)).status, 429);
});

test('o token nao aparece nos logs do servidor', async () => {
  const { email } = await registerAccount(baseUrl);
  const token = await requestToken(email);
  await reset(token);

  const output = server.output();
  assert.ok(!output.includes(token));
  assert.ok(!output.includes(email), 'o e-mail do usuario tambem nao e registrado');
  assert.ok(!output.includes(SMTP_LOGIN.pass));
  assert.match(output, /password_reset id=/);
});

test('provedor de e-mail recusando a mensagem: a API avisa a falha e o link e cancelado', async () => {
  const failing = await startFakeSmtp({ credentials: SMTP_LOGIN, rejectData: true });
  const other = await startServer(smtpEnv(failing.port));
  try {
    const { email } = await registerAccount(other.baseUrl);
    const response = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email });

    assert.equal(response.status, 502);
    assert.equal(response.data.error, 'email_delivery_failed');
    assert.equal(response.data.ok, undefined, 'falha de envio nunca e apresentada como sucesso');

    const { rows } = await db().query('SELECT utilizado FROM redefinicao_senha r JOIN usuario u ON u.id = r.usuario_id WHERE u.email = $1', [email]);
    assert.ok(rows.length === 1 && rows[0].utilizado === true, 'o link que nao chegou a ser entregue fica inutilizado');
  } finally {
    await other.stop();
    await failing.close();
  }
});

test('remetente recusado pelo provedor: mesma falha com ou sem conta', async () => {
  const picky = await startFakeSmtp({ credentials: SMTP_LOGIN, rejectSender: true });
  const other = await startServer(smtpEnv(picky.port));
  try {
    const { email } = await registerAccount(other.baseUrl);
    const existing = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email });
    const unknown = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email: newEmail('remetente') });

    assert.equal(existing.status, 502);
    assert.deepEqual(unknown.data, existing.data);
    assert.equal(unknown.status, 502);
  } finally {
    await other.stop();
    await picky.close();
  }
});

test('provedor de e-mail fora do ar: mesma falha com ou sem conta', async () => {
  const offline = await startFakeSmtp();
  const { port } = offline;
  await offline.close();
  const other = await startServer(smtpEnv(port));
  try {
    const { email } = await registerAccount(other.baseUrl);
    const existing = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email });
    const unknown = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email: newEmail('offline') });

    assert.equal(existing.status, 502);
    assert.equal(unknown.status, 502);
    assert.deepEqual(existing.data, unknown.data);
    assert.doesNotMatch(JSON.stringify(existing.data), /ECONNREFUSED|127\.0\.0\.1|smtp/i, 'sem detalhes internos na resposta');
  } finally {
    await other.stop();
  }
});

test('senha do SMTP errada: a API avisa a falha', async () => {
  const other = await startServer({ ...smtpEnv(smtp.port), SMTP_PASS: 'senha-errada' });
  try {
    const { email } = await registerAccount(other.baseUrl);
    const response = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email });
    assert.equal(response.status, 502);
    assert.ok(!other.output().includes('senha-errada'), 'a senha do SMTP nao vai para o log');
  } finally {
    await other.stop();
  }
});

test('sem SMTP configurado: a recuperacao fica indisponivel e avisa isso (com ou sem conta)', async () => {
  const other = await startServer();
  try {
    const { email } = await registerAccount(other.baseUrl);
    const existing = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email });
    const unknown = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email: newEmail('sem-smtp') });

    assert.equal(existing.status, 503);
    assert.equal(existing.data.error, 'email_not_configured');
    assert.deepEqual(existing.data, unknown.data);

    const { rows } = await db().query('SELECT count(*)::int AS total FROM redefinicao_senha r JOIN usuario u ON u.id = r.usuario_id WHERE u.email = $1', [email]);
    assert.equal(rows[0].total, 0, 'nenhum link e criado se nao ha como envia-lo');
    assert.match(other.output(), /NAO CONFIGURADO/);
  } finally {
    await other.stop();
  }
});

test('em producao, exige TLS no SMTP por padrao e APP_URL definido', async () => {
  const semAppUrl = await startServer({ ...smtpEnv(smtp.port), NODE_ENV: 'production', APP_URL: '' });
  try {
    const response = await createClient(semAppUrl.baseUrl).post('/api/auth/forgot-password', { email: newEmail('prod') });
    assert.equal(response.status, 503, 'sem APP_URL o link apontaria para localhost');
  } finally {
    await semAppUrl.stop();
  }

  const exigeTls = await startServer({ ...smtpEnv(smtp.port), SMTP_REQUIRE_TLS: '' });
  try {
    const { email } = await registerAccount(exigeTls.baseUrl);
    const sentBefore = smtp.state.messages.length;
    const response = await createClient(exigeTls.baseUrl).post('/api/auth/forgot-password', { email });
    assert.equal(response.status, 502, 'servidor SMTP sem criptografia e recusado');
    assert.equal(smtp.state.messages.length, sentBefore);
  } finally {
    await exigeTls.stop();
  }
});

test('MAIL_MODE=console (so desenvolvimento): nao envia nada e diz isso na resposta', async () => {
  const other = await startServer({ MAIL_MODE: 'console' });
  try {
    const { email } = await registerAccount(other.baseUrl);
    const response = await createClient(other.baseUrl).post('/api/auth/forgot-password', { email });

    assert.equal(response.status, 200);
    assert.equal(response.data.delivery, 'console');
    assert.match(response.data.message, /nenhum e-mail foi enviado/);
    assert.match(other.output(), /#redefinir=[a-f0-9]{64}/);
  } finally {
    await other.stop();
  }

  const production = await startServer({ MAIL_MODE: 'console', NODE_ENV: 'production', APP_URL });
  try {
    const response = await createClient(production.baseUrl).post('/api/auth/forgot-password', { email: newEmail('console') });
    assert.equal(response.status, 503, 'em producao o modo console e ignorado');
  } finally {
    await production.stop();
  }
});

test('conta bloqueada por tentativas vindas de varios IPs: redefinir a senha pelo e-mail libera a dona', async () => {
  const { email } = await registerAccount(baseUrl);
  for (let attempt = 0; attempt < 21; attempt++) await loginStatus(email, `Errada${attempt}A`);
  assert.equal(await loginStatus(email, PASSWORD), 429, 'o bloqueio por e-mail vale para qualquer IP');

  assert.equal((await reset(await requestToken(email))).status, 200);
  assert.equal(await loginStatus(email, NEW_PASSWORD), 200, 'so quem recebe o e-mail consegue sair do bloqueio');
});
