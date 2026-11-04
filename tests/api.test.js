const test = require('node:test');
const assert = require('node:assert/strict');

const { PASSWORD, startServer, createClient, registerAccount, newEmail, db, cleanup } = require('./helpers/server');

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

const anonymous = () => createClient(baseUrl);

async function login(email, password, extra = {}) {
  const client = anonymous();
  const response = await client.post('/api/auth/login', { email, password, ...extra });
  return { client, response };
}

test('cadastro: cria a conta sem pergunta de seguranca', async () => {
  const email = newEmail('cadastro');
  const response = await anonymous().post('/api/auth/register', {
    name: 'Ana Lima', email, password: PASSWORD, phone: '(11) 99999-0000', cpf: '123.456.789-00'
  });

  assert.equal(response.status, 201);
  assert.equal(response.data.email, email);
  assert.equal(response.data.name, 'Ana Lima');
  assert.equal(response.data.token, undefined, 'o token nao vai no corpo: o JavaScript da pagina nao pode le-lo');

  const { rows } = await db().query('SELECT * FROM usuario WHERE email = $1', [email]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pergunta_seguranca, null);
  assert.equal(rows[0].resposta_seguranca_hash, null);
  assert.notEqual(rows[0].senha_hash, PASSWORD, 'a senha nunca pode ser gravada em texto puro');
  assert.match(rows[0].senha_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
});

test('cadastro: pergunta e resposta enviadas por um navegador antigo sao ignoradas', async () => {
  const { email } = await registerAccount(baseUrl, {
    securityQuestion: 'Qual e a sua cidade natal?', securityAnswer: 'Recife'
  });
  const { rows } = await db().query('SELECT pergunta_seguranca, resposta_seguranca_hash FROM usuario WHERE email = $1', [email]);
  assert.deepEqual(rows[0], { pergunta_seguranca: null, resposta_seguranca_hash: null });
});

test('cadastro: a conta nova ja pode usar o sistema (empresa, modulos e preferencias criados)', async () => {
  const { client } = await registerAccount(baseUrl, { name: 'Loja da Bia' });
  const sync = await client.get('/api/sync');

  assert.equal(sync.status, 200);
  assert.equal(sync.data.company.name, 'Loja da Bia');
  assert.equal(Object.keys(sync.data.modules).length, 10);
  assert.ok(Object.values(sync.data.modules).every(Boolean));
  assert.deepEqual(sync.data.settings.notifications, { accounts: true, events: true });
});

test('cadastro: recusa e-mail repetido, e-mail invalido, nome vazio e senha fraca', async () => {
  const { email } = await registerAccount(baseUrl);
  const attempt = body => anonymous().post('/api/auth/register', { name: 'Teste', email: newEmail(), password: PASSWORD, ...body });

  const duplicate = await attempt({ email });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, 'email_already_exists');

  assert.equal((await attempt({ email: email.toUpperCase() })).status, 409, 'maiusculas nao criam uma segunda conta');
  assert.equal((await attempt({ email: 'nao-e-email' })).status, 400);
  assert.equal((await attempt({ name: '   ' })).status, 400);
  assert.equal((await attempt({ name: 'x'.repeat(121) })).status, 400);

  for (const password of ['Abc123', 'senha1234', 'SENHA1234', 'SenhaSemNumero', 'Aa1' + 'x'.repeat(126), '', 12345678]) {
    const response = await attempt({ password });
    assert.equal(response.status, 400, `senha ${JSON.stringify(password)} deveria ser recusada`);
    assert.equal(response.data.error, 'weak_password');
  }
});

test('cadastro: quando falha, nao sobra empresa orfa no banco', async () => {
  const { email } = await registerAccount(baseUrl);
  const countEmpresas = async () => (await db().query('SELECT count(*)::int AS total FROM empresa')).rows[0].total;

  const before = await countEmpresas();
  const response = await anonymous().post('/api/auth/register', { name: 'Repetida', email, password: PASSWORD });
  assert.equal(response.status, 409);
  assert.equal(await countEmpresas(), before);
});

test('login: credenciais validas devolvem token que abre a sessao', async () => {
  const { email, password } = await registerAccount(baseUrl, { name: 'Carlos Souza' });
  const { client, response } = await login(email, password);

  assert.equal(response.status, 200);
  assert.equal(response.data.name, 'Carlos Souza');
  assert.equal(response.data.senha_hash, undefined);

  const me = await client.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.email, email);
  assert.equal(me.data.senha_hash, undefined, 'o hash da senha nunca sai na API');
});

test('login: senha errada e e-mail inexistente recebem a mesma resposta', async () => {
  const { email } = await registerAccount(baseUrl);

  const wrongPassword = (await login(email, 'SenhaErrada1')).response;
  const unknownEmail = (await login(newEmail('fantasma'), PASSWORD)).response;

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(wrongPassword.data, unknownEmail.data, 'a resposta nao pode revelar se o e-mail existe');
  assert.equal(wrongPassword.data.token, undefined);
});

test('login: corpo invalido e recusado como requisicao invalida', async () => {
  const brokenJson = await anonymous().request('POST', '/api/auth/login', '{email:');
  assert.equal(brokenJson.status, 400);
  assert.equal(brokenJson.data.error, 'invalid_json');

  const notAnObject = await anonymous().request('POST', '/api/auth/login', '["a","b"]');
  assert.equal(notAnObject.status, 400);

  const weirdTypes = await anonymous().post('/api/auth/login', { email: { $ne: null }, password: ['x'] });
  assert.equal(weirdTypes.status, 401);

  const injection = await anonymous().post('/api/auth/login', { email: "' OR '1'='1", password: "' OR '1'='1" });
  assert.equal(injection.status, 401);
});

test('login: "manter conectado" define a duracao da sessao', async () => {
  const { email, password } = await registerAccount(baseUrl);
  const hoursLeft = async client => {
    const { hashToken } = require('../backend/src/lib/security');
    const { rows } = await db().query(
      "SELECT extract(epoch FROM (expira_em - now())) / 3600 AS hours FROM sessao WHERE token_hash = $1",
      [hashToken(client.token)]
    );
    return Number(rows[0].hours);
  };

  const short = await login(email, password);
  const long = await login(email, password, { remember: true });

  assert.ok(Math.abs(await hoursLeft(short.client) - 12) < 0.1, 'sem a opcao: 12 horas');
  assert.ok(Math.abs(await hoursLeft(long.client) - 30 * 24) < 0.1, 'com a opcao: 30 dias');
});

test('login: o token da sessao fica no banco apenas como hash', async () => {
  const { client } = await registerAccount(baseUrl);
  const { rows } = await db().query('SELECT count(*)::int AS total FROM sessao WHERE token_hash = $1', [client.token]);
  assert.equal(rows[0].total, 0);
});

test('logout: o token deixa de valer no servidor', async () => {
  const { client } = await registerAccount(baseUrl);
  assert.equal((await client.get('/api/me')).status, 200);
  assert.equal((await client.post('/api/auth/logout')).status, 200);
  assert.equal((await client.get('/api/me')).status, 401);
});

test('conta antiga: continua entrando e os dados da pergunta de seguranca sao preservados', async () => {
  const { passwordHash } = require('../backend/src/lib/security');
  const email = newEmail('antiga');
  const answerHash = await passwordHash('rex');

  const empresa = await db().query("INSERT INTO empresa (razao_social) VALUES ('Empresa Antiga') RETURNING id");
  await db().query(
    `INSERT INTO usuario (empresa_id, nome, email, senha_hash, papel, pergunta_seguranca, resposta_seguranca_hash)
     VALUES ($1, 'Conta Antiga', $2, $3, 'admin', 'Nome do seu primeiro animal de estimacao?', $4)`,
    [empresa.rows[0].id, email, await passwordHash(PASSWORD), answerHash]
  );

  const { client, response } = await login(email, PASSWORD);
  assert.equal(response.status, 200, 'a conta antiga entra normalmente');
  assert.equal((await client.get('/api/sync')).status, 200);

  const retired = await anonymous().post('/api/auth/answer-question', { email, answer: 'rex' });
  assert.equal(retired.status, 410, 'a rota da pergunta de seguranca foi desativada');
  assert.equal(retired.data.token, undefined);

  const { rows } = await db().query('SELECT pergunta_seguranca, resposta_seguranca_hash FROM usuario WHERE email = $1', [email]);
  assert.equal(rows[0].pergunta_seguranca, 'Nome do seu primeiro animal de estimacao?');
  assert.equal(rows[0].resposta_seguranca_hash, answerHash, 'nada foi apagado da conta antiga');
});

const PROTECTED_ROUTES = [
  ['GET', '/api/me'], ['POST', '/api/me'], ['DELETE', '/api/me'], ['GET', '/api/me/acessos'],
  ['GET', '/api/sync'],
  ['POST', '/api/auth/change-password'], ['POST', '/api/auth/logout-others'],
  ['GET', '/api/company'], ['POST', '/api/company'],
  ['GET', '/api/modulos'], ['POST', '/api/modulos'],
  ['GET', '/api/configuracoes'], ['POST', '/api/configuracoes'],
  ['GET', '/api/clientes'], ['POST', '/api/clientes'], ['DELETE', '/api/clientes/1'],
  ['GET', '/api/fornecedores'], ['POST', '/api/fornecedores'], ['DELETE', '/api/fornecedores/1'],
  ['GET', '/api/produtos'], ['POST', '/api/produtos'], ['DELETE', '/api/produtos/1'],
  ['GET', '/api/movimentacoes-estoque'], ['POST', '/api/movimentacoes-estoque'],
  ['GET', '/api/transacoes'], ['POST', '/api/transacoes'], ['DELETE', '/api/transacoes/1'],
  ['GET', '/api/contas'], ['POST', '/api/contas'], ['POST', '/api/contas/1/status'], ['DELETE', '/api/contas/1'],
  ['GET', '/api/servicos'], ['POST', '/api/servicos'], ['DELETE', '/api/servicos/1'],
  ['GET', '/api/eventos'], ['POST', '/api/eventos'], ['DELETE', '/api/eventos/1']
];

test('protecao: sem token, toda rota de dados responde 401 e nao devolve nada', async () => {
  for (const [method, pathname] of PROTECTED_ROUTES) {
    const response = await anonymous().request(method, pathname, method === 'GET' ? undefined : {});
    assert.equal(response.status, 401, `${method} ${pathname} deveria exigir login`);
    assert.deepEqual(Object.keys(response.data).sort(), ['error', 'message']);
  }
});

test('protecao: token inventado, encerrado ou vencido nao abre nada', async () => {
  const invented = createClient(baseUrl, { token: 'a'.repeat(64) });
  assert.equal((await invented.get('/api/sync')).status, 401);

  const { client, account } = await registerAccount(baseUrl);
  await db().query("UPDATE sessao SET expira_em = now() - interval '1 minute' WHERE usuario_id = $1", [account.id]);
  assert.equal((await client.get('/api/sync')).status, 401, 'sessao vencida');

  const { client: disabled, email } = await registerAccount(baseUrl);
  await db().query('UPDATE usuario SET ativo = FALSE WHERE email = $1', [email]);
  assert.equal((await disabled.get('/api/sync')).status, 401, 'conta desativada');
  assert.equal((await login(email, PASSWORD)).response.status, 401, 'conta desativada nao entra');
});

test('protecao: rota inexistente responde 404 em JSON', async () => {
  const response = await anonymous().get('/api/nao-existe');
  assert.equal(response.status, 404);
  assert.equal(response.data.error, 'not_found');
});

test('isolamento: uma empresa nao enxerga nem altera os dados de outra', async () => {
  const { client: alice } = await registerAccount(baseUrl, { name: 'Alice' });
  const { client: bob } = await registerAccount(baseUrl, { name: 'Bob' });

  const cliente = (await alice.post('/api/clientes', { nome: 'Cliente da Alice' })).data;
  const conta = (await alice.post('/api/contas', { tipo: 'pagar', descricao: 'Conta da Alice', valor: 100, vencimento: '2030-01-10' })).data;
  const produto = (await alice.post('/api/produtos', { name: 'Produto da Alice', code: 'A-1', quantity: 5 })).data;
  const transacao = (await alice.post('/api/transacoes', { tipo: 'entrada', descricao: 'Venda da Alice', valor: 50 })).data;

  for (const pathname of ['/api/clientes', '/api/contas', '/api/produtos', '/api/transacoes', '/api/movimentacoes-estoque']) {
    assert.deepEqual((await bob.get(pathname)).data, [], `${pathname} do Bob deveria estar vazio`);
  }
  const bobSync = (await bob.get('/api/sync')).data;
  assert.equal(JSON.stringify(bobSync).includes('Alice'), false, 'a carga inicial do Bob nao pode conter nada da Alice');

  assert.equal((await bob.del(`/api/clientes/${cliente.id}`)).status, 404);
  assert.equal((await bob.del(`/api/contas/${conta.id}`)).status, 404);
  assert.equal((await bob.del(`/api/produtos/${produto.id}`)).status, 404);
  assert.equal((await bob.del(`/api/transacoes/${transacao.id}`)).status, 404);
  assert.equal((await bob.post(`/api/contas/${conta.id}/status`)).status, 404);
  assert.equal((await bob.post('/api/movimentacoes-estoque', { productId: produto.id, quantity: 1, movement: 'saida' })).status, 404);

  assert.equal((await alice.get('/api/clientes')).data.length, 1, 'os dados da Alice continuam la');
  assert.equal((await alice.get('/api/contas')).data[0].status, 'pendente');
  assert.equal((await alice.get('/api/produtos')).data[0].quantity, 5);
});

test('dados: clientes, fornecedores, servicos e eventos sao criados, listados e removidos', async () => {
  const { client } = await registerAccount(baseUrl);

  const cliente = await client.post('/api/clientes', { nome: ' Maria Silva ', email: 'MARIA@exemplo.com', telefone: '11 5555-0000', observacoes: 'VIP' });
  assert.equal(cliente.status, 201);
  assert.equal(cliente.data.nome, 'Maria Silva');
  assert.equal(cliente.data.email, 'maria@exemplo.com');
  assert.match(cliente.data.created, /^\d{4}-\d{2}-\d{2}$/);

  const fornecedor = await client.post('/api/fornecedores', { nome: 'Distribuidora Sol', estado: 'sp', cidade: 'Campinas', categoria: 'Embalagens' });
  assert.equal(fornecedor.status, 201);
  assert.equal(fornecedor.data.estado, 'SP');

  const servico = await client.post('/api/servicos', { client: 'Maria Silva', description: 'Instalação', valor: '250.00', date: '2026-03-15' });
  assert.equal(servico.status, 201);
  assert.deepEqual(
    { client: servico.data.client, valor: servico.data.valor, date: servico.data.date },
    { client: 'Maria Silva', valor: 250, date: '2026-03-15' }
  );
  assert.equal((await client.get('/api/clientes')).data.length, 1, 'o cliente do servico e o mesmo ja cadastrado');

  const evento = await client.post('/api/eventos', { title: 'Reunião', type: 'reuniao', date: '2026-12-31', time: '14:30', description: 'Fechamento' });
  assert.equal(evento.status, 201);
  assert.deepEqual(
    { date: evento.data.date, time: evento.data.time, type: evento.data.type },
    { date: '2026-12-31', time: '14:30', type: 'reuniao' }
  );

  for (const [pathname, id] of [['/api/servicos', servico.data.id], ['/api/eventos', evento.data.id], ['/api/fornecedores', fornecedor.data.id], ['/api/clientes', cliente.data.id]]) {
    assert.equal((await client.del(`${pathname}/${id}`)).status, 200);
    assert.deepEqual((await client.get(pathname)).data, []);
    assert.equal((await client.del(`${pathname}/${id}`)).status, 404, 'remover de novo avisa que ja nao existe');
  }
});

test('dados: transacoes criam categoria e cliente pelo nome e aparecem na listagem', async () => {
  const { client } = await registerAccount(baseUrl);

  const entrada = await client.post('/api/transacoes', { tipo: 'entrada', descricao: 'Venda', valor: 199.9, data: '2026-05-10', categoria: 'Vendas', cliente: 'João' });
  const saida = await client.post('/api/transacoes', { tipo: 'saida', descricao: 'Aluguel', valor: 1500, data: '2026-05-05', categoria: 'Fixas' });
  assert.equal(entrada.status, 201);
  assert.equal(saida.status, 201);
  assert.deepEqual(
    { data: entrada.data.data, categoria: entrada.data.categoria, cliente: entrada.data.cliente, valor: entrada.data.valor },
    { data: '2026-05-10', categoria: 'Vendas', cliente: 'João', valor: 199.9 }
  );

  await client.post('/api/transacoes', { tipo: 'entrada', descricao: 'Outra venda', valor: 10, categoria: 'Vendas', cliente: 'João' });
  const list = (await client.get('/api/transacoes')).data;
  assert.equal(list.length, 3);
  assert.equal((await client.get('/api/clientes')).data.length, 1, 'o mesmo nome nao duplica o cliente');
});

test('dados: contas alternam entre pendente e pago', async () => {
  const { client } = await registerAccount(baseUrl);
  const conta = (await client.post('/api/contas', { tipo: 'receber', descricao: 'Parcela', valor: 300, vencimento: '2026-08-01' })).data;

  assert.equal(conta.status, 'pendente');
  assert.equal(conta.vencimento, '2026-08-01');
  assert.equal((await client.post(`/api/contas/${conta.id}/status`)).data.status, 'pago');
  assert.equal((await client.post(`/api/contas/${conta.id}/status`)).data.status, 'pendente');
  assert.equal((await client.post('/api/contas/999999999/status')).status, 404);
});

test('estoque: cadastro, entrada, saida e bloqueio de saida maior que o saldo', async () => {
  const { client } = await registerAccount(baseUrl);

  const produto = await client.post('/api/produtos', {
    name: 'Caixa', code: 'CX-1', supplier: 'Fornecedor Novo', quantity: '10', minimum: '2', costPrice: '1.50', salePrice: '3'
  });
  assert.equal(produto.status, 201);
  assert.deepEqual(
    { quantity: produto.data.quantity, minimum: produto.data.minimum, costPrice: produto.data.costPrice, supplier: produto.data.supplier },
    { quantity: 10, minimum: 2, costPrice: 1.5, supplier: 'Fornecedor Novo' }
  );
  assert.equal((await client.get('/api/fornecedores')).data.length, 1, 'o fornecedor digitado foi cadastrado');
  assert.equal((await client.get('/api/movimentacoes-estoque')).data[0].note, 'Cadastro inicial');

  const saida = await client.post('/api/movimentacoes-estoque', { productId: produto.data.id, quantity: 4, movement: 'saida', note: 'Venda' });
  assert.equal(saida.status, 201);
  assert.equal((await client.get('/api/produtos')).data[0].quantity, 6);

  const demais = await client.post('/api/movimentacoes-estoque', { productId: produto.data.id, quantity: 7, movement: 'saida' });
  assert.equal(demais.status, 400);
  assert.equal(demais.data.error, 'insufficient_stock');
  assert.equal((await client.get('/api/produtos')).data[0].quantity, 6, 'o saldo nao muda quando a saida e recusada');

  await client.post('/api/movimentacoes-estoque', { productId: produto.data.id, quantity: 3, movement: 'entrada' });
  assert.equal((await client.get('/api/produtos')).data[0].quantity, 9);

  assert.equal((await client.del(`/api/produtos/${produto.data.id}`)).status, 200);
  assert.equal((await client.get('/api/movimentacoes-estoque')).data.length, 3, 'o historico continua depois de remover o produto');
  assert.equal((await client.del('/api/movimentacoes-estoque/1')).status, 405, 'o historico de estoque nao pode ser apagado');
});

test('estoque: duas saidas simultaneas nao deixam o saldo negativo', async () => {
  const { client } = await registerAccount(baseUrl);
  const produto = (await client.post('/api/produtos', { name: 'Item', code: 'IT-1', quantity: 5 })).data;

  const results = await Promise.all(
    [1, 2, 3].map(() => client.post('/api/movimentacoes-estoque', { productId: produto.id, quantity: 4, movement: 'saida' }))
  );
  assert.deepEqual(results.map(result => result.status).sort(), [201, 400, 400]);
  assert.equal((await client.get('/api/produtos')).data[0].quantity, 1);
});

test('estoque: codigo repetido e recusado sem deixar fornecedor orfao', async () => {
  const { client } = await registerAccount(baseUrl);
  await client.post('/api/produtos', { name: 'Primeiro', code: 'REP-1' });

  const duplicate = await client.post('/api/produtos', { name: 'Segundo', code: 'REP-1', supplier: 'Fornecedor Fantasma' });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.message, /código/);
  assert.deepEqual((await client.get('/api/fornecedores')).data, [], 'nada do cadastro recusado pode ficar no banco');
  assert.equal((await client.get('/api/produtos')).data.length, 1);
});

test('carga inicial: /api/sync devolve o mesmo que as rotas individuais', async () => {
  const { client, email } = await registerAccount(baseUrl, { name: 'Dona da Loja', phone: '11 4000-0000' });
  await client.post('/api/clientes', { nome: 'Cliente 1' });
  await client.post('/api/fornecedores', { nome: 'Fornecedor 1' });
  await client.post('/api/produtos', { name: 'Produto 1', code: 'P1', quantity: 2 });
  await client.post('/api/transacoes', { tipo: 'entrada', descricao: 'Venda', valor: 10, cliente: 'Cliente 1' });
  await client.post('/api/contas', { descricao: 'Conta', valor: 10, vencimento: '2026-09-09' });
  await client.post('/api/servicos', { description: 'Serviço', valor: 10 });
  await client.post('/api/eventos', { title: 'Evento', date: '2026-09-09' });

  const sync = (await client.get('/api/sync')).data;
  const individual = {
    clients: '/api/clientes', suppliers: '/api/fornecedores', products: '/api/produtos',
    stockHistory: '/api/movimentacoes-estoque', transactions: '/api/transacoes', accounts: '/api/contas',
    services: '/api/servicos', events: '/api/eventos', modules: '/api/modulos', settings: '/api/configuracoes'
  };
  for (const [key, pathname] of Object.entries(individual)) {
    assert.deepEqual(sync[key], (await client.get(pathname)).data, `${key} difere de ${pathname}`);
  }
  assert.deepEqual(sync.company, (await client.get('/api/company')).data.company);
  assert.deepEqual(
    { name: sync.profile.name, email: sync.profile.email, phone: sync.profile.phone },
    { name: 'Dona da Loja', email, phone: '11 4000-0000' }
  );
  assert.equal(sync.logins.length, 1);
  assert.equal(sync.logins[0].success, true);
});

test('configuracoes: empresa, modulos e alertas sao gravados e relidos', async () => {
  const { client } = await registerAccount(baseUrl);

  const company = await client.post('/api/company', {
    name: 'Padaria Central', trade: 'Central', doc: '11.222.333/0001-44', phone: '(11) 3000-0000',
    state: 'sp', timezone: 'America/Fortaleza', email: '', logo: ''
  });
  assert.equal(company.status, 200);
  assert.deepEqual(
    { name: company.data.company.name, doc: company.data.company.doc, state: company.data.company.state, timezone: company.data.company.timezone },
    { name: 'Padaria Central', doc: '11.222.333/0001-44', state: 'SP', timezone: 'America/Fortaleza' }
  );

  const modules = await client.post('/api/modulos', { estoque: false, agenda: false, modulo_inventado: false, clientes: 'nao' });
  assert.equal(modules.status, 200);
  assert.equal(modules.data.estoque, false);
  assert.equal(modules.data.agenda, false);
  assert.equal(modules.data.clientes, true);
  assert.equal(modules.data.modulo_inventado, undefined);
  assert.equal((await client.post('/api/modulos', { estoque: true })).data.estoque, true);

  const settings = await client.post('/api/configuracoes', { notifications: { accounts: false } });
  assert.deepEqual(settings.data.notifications, { accounts: false, events: true });
});

test('configuracoes: duas empresas podem ficar sem CNPJ; CNPJ repetido e recusado', async () => {
  const { client: first } = await registerAccount(baseUrl);
  const { client: second } = await registerAccount(baseUrl);

  assert.equal((await first.post('/api/company', { name: 'Primeira', doc: '' })).status, 200);
  assert.equal((await second.post('/api/company', { name: 'Segunda', doc: '' })).status, 200);

  const cnpj = `${Date.now()}`.slice(-14);
  assert.equal((await first.post('/api/company', { doc: cnpj })).status, 200);
  const repeated = await second.post('/api/company', { doc: cnpj });
  assert.equal(repeated.status, 409);
  assert.match(repeated.data.message, /CNPJ/);
});

test('validacao: dados invalidos recebem 400 com mensagem, nunca erro interno', async () => {
  const { client } = await registerAccount(baseUrl);
  const cases = [
    ['/api/clientes', {}],
    ['/api/clientes', { nome: 12345678901234567890n.toString().repeat(10) }],
    ['/api/clientes', { nome: { objeto: true } }],
    ['/api/clientes', { nome: 'Ana', email: 'sem-arroba' }],
    ['/api/clientes', { nome: 'Ana', telefone: '9'.repeat(21) }],
    ['/api/fornecedores', { nome: 'Forn', estado: 'São Paulo' }],
    ['/api/produtos', { name: '' }],
    ['/api/produtos', { name: 'P', quantity: -1 }],
    ['/api/produtos', { name: 'P', quantity: 1.5 }],
    ['/api/produtos', { name: 'P', costPrice: -1 }],
    ['/api/produtos', { name: 'P', quantity: 99999999999 }],
    ['/api/movimentacoes-estoque', { productId: 'abc', quantity: 1 }],
    ['/api/movimentacoes-estoque', { productId: 1, quantity: 0 }],
    ['/api/transacoes', { descricao: 'x', valor: 0 }],
    ['/api/transacoes', { descricao: 'x', valor: 'abc' }],
    ['/api/transacoes', { descricao: 'x', valor: 1e15 }],
    ['/api/transacoes', { descricao: 'x', valor: 10, data: '31/12/2026' }],
    ['/api/transacoes', { descricao: 'x'.repeat(201), valor: 10 }],
    ['/api/contas', { descricao: 'x', valor: 10 }],
    ['/api/contas', { descricao: 'x', valor: 10, vencimento: 'amanha' }],
    ['/api/contas', { descricao: 'x', valor: 10, vencimento: '2026-02-30' }],
    ['/api/servicos', { description: '', valor: 10 }],
    ['/api/eventos', { title: 'Evento' }],
    ['/api/eventos', { title: 'Evento', date: '2026-01-01', time: '25:99' }],
    ['/api/eventos', { title: 'Evento', date: '2026-01-01', type: 'festa' }],
    ['/api/transacoes', { descricao: 'x', valor: 10, tipo: 'saída' }],
    ['/api/contas', { descricao: 'x', valor: 10, vencimento: '2026-01-01', tipo: 'pago' }],
    ['/api/movimentacoes-estoque', { productId: 1, quantity: 1, movement: 'baixa' }],
    ['/api/company', { name: '' }],
    ['/api/company', { state: 'SPX' }],
    ['/api/company', { logo: 'javascript:alert(1)' }],
    ['/api/company', { timezone: '<script>' }],
    ['/api/configuracoes', { notifications: { accounts: 'talvez' } }],
    ['/api/me', { name: '' }]
  ];

  for (const [pathname, body] of cases) {
    const response = await client.post(pathname, body);
    assert.equal(response.status, 400, `${pathname} ${JSON.stringify(body).slice(0, 60)} -> ${response.status}`);
    assert.ok(response.data.message.length > 5);
    assert.doesNotMatch(JSON.stringify(response.data), /SELECT|INSERT|syntax|constraint|stack|\.js/i, 'a resposta nao pode expor detalhes internos');
  }

  for (const pathname of ['/api/clientes', '/api/produtos', '/api/transacoes', '/api/contas', '/api/servicos', '/api/eventos', '/api/fornecedores']) {
    assert.deepEqual((await client.get(pathname)).data, [], `nada invalido pode ter sido gravado em ${pathname}`);
  }
});

test('rotas: metodo sem suporte em endereco existente responde 405, sem alterar nada', async () => {
  const { client } = await registerAccount(baseUrl);
  const created = await client.post('/api/clientes', { nome: 'Cliente 405' });
  assert.equal(created.status, 201);

  assert.equal((await client.request('PUT', '/api/clientes', {})).status, 405);
  assert.equal((await client.request('PUT', `/api/clientes/${created.data.id}`, { nome: 'Outro' })).status, 405);
  assert.equal((await client.request('DELETE', '/api/movimentacoes-estoque/1')).status, 405);
  assert.equal((await client.post(`/api/clientes/${created.data.id}/status`)).status, 404);
  assert.equal((await client.get('/api/clientes')).data[0].nome, 'Cliente 405');
  assert.equal((await anonymous().request('PUT', '/api/clientes', {})).status, 401);
});

test('validacao: tipo omitido usa o padrao da rota', async () => {
  const { client } = await registerAccount(baseUrl);
  const transacao = await client.post('/api/transacoes', { descricao: 'Sem tipo', valor: 10 });
  assert.equal(transacao.status, 201);
  assert.equal(transacao.data.tipo, 'entrada');
  const evento = await client.post('/api/eventos', { title: 'Sem tipo', date: '2026-01-01' });
  assert.equal(evento.data.type, 'compromisso');
});

test('validacao: textos com HTML e aspas sao guardados como texto, sem quebrar consultas', async () => {
  const { client } = await registerAccount(baseUrl);
  const nome = `<img src=x onerror=alert(1)> '; DROP TABLE cliente; --`;

  const created = await client.post('/api/clientes', { nome });
  assert.equal(created.status, 201);
  assert.equal((await client.get('/api/clientes')).data[0].nome, nome);
  assert.equal((await db().query("SELECT to_regclass('public.cliente') AS tabela")).rows[0].tabela, 'cliente');
});

test('validacao: corpo acima do limite e recusado com 413', async () => {
  const { client } = await registerAccount(baseUrl);
  const response = await client.post('/api/clientes', { nome: 'Ana', observacoes: 'x'.repeat(200 * 1024) });
  assert.equal(response.status, 413);
  assert.deepEqual((await client.get('/api/clientes')).data, []);
});

test('perfil: nome e telefone sao atualizados; o e-mail nao muda por esta rota', async () => {
  const { client, email } = await registerAccount(baseUrl);
  const updated = await client.post('/api/me', { name: 'Nome Novo', phone: '11 98888-7777', email: 'outro@exemplo.com', role: 'admin', id: 'x' });

  assert.equal(updated.status, 200);
  assert.deepEqual(
    { name: updated.data.name, phone: updated.data.phone, email: updated.data.email },
    { name: 'Nome Novo', phone: '11 98888-7777', email }
  );
});

test('trocar senha: exige a senha atual, valida a nova e derruba as outras sessoes', async () => {
  const { client, email } = await registerAccount(baseUrl);
  const other = (await login(email, PASSWORD)).client;

  const wrong = await client.post('/api/auth/change-password', { currentPassword: 'Errada123', newPassword: 'NovaSenha1' });
  assert.equal(wrong.status, 403);
  const weak = await client.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'fraca' });
  assert.equal(weak.status, 400);
  assert.equal((await login(email, PASSWORD)).response.status, 200, 'tentativas recusadas nao mudam a senha');

  const changed = await client.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'NovaSenha1' });
  assert.equal(changed.status, 200);

  assert.equal((await login(email, PASSWORD)).response.status, 401, 'a senha antiga deixa de valer');
  assert.equal((await login(email, 'NovaSenha1')).response.status, 200);
  assert.equal((await client.get('/api/me')).status, 200, 'a sessao que trocou a senha continua');
  assert.equal((await other.get('/api/me')).status, 401, 'as outras sessoes caem');
});

test('trocar senha: cinco senhas atuais erradas bloqueiam novas tentativas por um tempo', async () => {
  const { client } = await registerAccount(baseUrl);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await client.post('/api/auth/change-password', { currentPassword: 'Errada123', newPassword: 'NovaSenha1' })).status, 403);
  }
  const blocked = await client.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'NovaSenha1' });
  assert.equal(blocked.status, 429);
});

test('sessoes: "encerrar em outros dispositivos" mantem apenas a sessao atual', async () => {
  const { client, email } = await registerAccount(baseUrl);
  const phone = (await login(email, PASSWORD)).client;
  const tablet = (await login(email, PASSWORD)).client;

  const ended = await client.post('/api/auth/logout-others');
  assert.equal(ended.status, 200);
  assert.equal(ended.data.ended, 2);
  assert.equal((await client.get('/api/me')).status, 200);
  assert.equal((await phone.get('/api/me')).status, 401);
  assert.equal((await tablet.get('/api/me')).status, 401);
  assert.equal((await client.post('/api/auth/logout-others')).data.ended, 0);
});

test('historico de acessos: registra entradas e tentativas com senha errada', async () => {
  const { client, email } = await registerAccount(baseUrl);
  await login(email, 'SenhaErrada1');
  await login(email, PASSWORD);

  const history = await client.get('/api/me/acessos');
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.map(entry => entry.success), [true, false, true]);
  assert.ok(history.data.every(entry => typeof entry.device === 'string' && !Number.isNaN(Date.parse(entry.date))));
});

test('excluir conta: pede a senha e apaga a conta, a empresa e todos os dados', async () => {
  const { client, email } = await registerAccount(baseUrl);
  await client.post('/api/clientes', { nome: 'Cliente a apagar' });
  await client.post('/api/transacoes', { descricao: 'Venda', valor: 10 });
  const empresaId = (await db().query('SELECT empresa_id FROM usuario WHERE email = $1', [email])).rows[0].empresa_id;

  assert.equal((await client.del('/api/me', { password: 'Errada123' })).status, 403);
  assert.equal((await client.del('/api/me', {})).status, 403);
  assert.equal((await client.get('/api/clientes')).data.length, 1, 'senha errada nao apaga nada');

  assert.equal((await client.del('/api/me', { password: PASSWORD })).status, 200);
  assert.equal((await client.get('/api/me')).status, 401);
  assert.equal((await login(email, PASSWORD)).response.status, 401);

  for (const table of ['empresa', 'usuario', 'cliente', 'transacao', 'sessao', 'configuracao_empresa']) {
    const column = table === 'empresa' ? 'id' : table === 'sessao' ? null : 'empresa_id';
    const sql = column
      ? `SELECT count(*)::int AS total FROM ${table} WHERE ${column} = $1`
      : 'SELECT count(*)::int AS total FROM sessao s JOIN usuario u ON u.id = s.usuario_id WHERE u.empresa_id = $1';
    assert.equal((await db().query(sql, [empresaId])).rows[0].total, 0, `sobrou registro em ${table}`);
  }
});

test('excluir conta: nao afeta as outras empresas', async () => {
  const { client: leaving } = await registerAccount(baseUrl);
  const { client: staying } = await registerAccount(baseUrl);
  await staying.post('/api/clientes', { nome: 'Cliente que fica' });

  assert.equal((await leaving.del('/api/me', { password: PASSWORD })).status, 200);
  assert.equal((await staying.get('/api/clientes')).data.length, 1);
});
