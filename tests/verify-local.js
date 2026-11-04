// Conferencia rapida: sobe o servidor de verdade, cria uma conta, entra,
// confere a sessao e apaga a conta. A suite completa roda com "npm test".
const { startServer, createClient, registerAccount, cleanup, resetLocalhostLimits } = require('./helpers/server');

async function run() {
  const checks = [];
  const check = (label, passed, detail = '') => {
    checks.push(passed);
    console.log(`${passed ? 'ok   ' : 'FALHA'} ${label}${detail ? ` (${detail})` : ''}`);
  };

  let server;
  try {
    await resetLocalhostLimits();
    server = await startServer({ TRUST_PROXY: '' });
    const visitor = createClient(server.baseUrl);

    const health = await visitor.get('/health');
    check('servidor e banco de dados', health.data.database === 'connected', health.data.database);

    const { client, email, password } = await registerAccount(server.baseUrl);
    check('cadastro sem pergunta de seguranca', Boolean(client.token));

    const login = await createClient(server.baseUrl).post('/api/auth/login', { email, password });
    check('login', login.status === 200, `status ${login.status}`);
    check('login com senha errada e recusado', (await visitor.post('/api/auth/login', { email, password: 'Errada123' })).status === 401);
    check('sessao autenticada', (await client.get('/api/me')).status === 200);
    check('rota protegida sem login e recusada', (await createClient(server.baseUrl).get('/api/sync')).status === 401);
    check('carga inicial do painel', (await client.get('/api/sync')).status === 200);

    const forgot = await visitor.post('/api/auth/forgot-password', { email });
    const mailReady = forgot.status === 200;
    check('"esqueci minha senha" responde', [200, 502, 503].includes(forgot.status), forgot.data.message);
    if (!mailReady) console.log('     -> esta conferencia roda sem SMTP; para testar o envio real: npm run mail:test -- seu@email.com');

    check('link de redefinicao invalido e recusado', (await visitor.post('/api/auth/reset-password', { token: 'x', password: 'NovaSenha1' })).status === 400);
    check('pagina inicial', (await fetch(`${server.baseUrl}/index.html`)).status === 200);
    check('exclusao da conta de teste', (await client.del('/api/me', { password })).status === 200);
  } catch (error) {
    check('execucao', false, error.message);
  } finally {
    await server?.stop();
    await cleanup().catch(() => {});
  }

  const allPassed = checks.length > 0 && checks.every(Boolean);
  console.log(allPassed ? '\nRESULTADO: TUDO FUNCIONANDO' : '\nRESULTADO: FALHOU');
  process.exit(allPassed ? 0 : 1);
}

run();
