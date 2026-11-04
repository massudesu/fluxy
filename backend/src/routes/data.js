const { query, withTransaction } = require('../lib/db');
const { HttpError, sendJson, readBody } = require('../lib/http-helpers');
const { requireUser } = require('../lib/auth-middleware');
const { findOrCreateCustomer, findOrCreateSupplier, findOrCreateCategory } = require('../lib/lookups');
const {
  invalid, requiredText, optionalText, optionalEmail, money, integer, isoDate, time, stateCode, oneOf
} = require('../lib/validation');

function targetFromPath(prefix, pathname) {
  if (pathname === prefix) return null;
  const match = pathname.slice(prefix.length).match(/^\/(\d{1,15})(?:\/(\w+))?$/);
  return match ? { id: Number(match[1]), action: match[2] || null } : undefined;
}

const pad = number => String(number).padStart(2, '0');

const dateOnly = value => {
  if (!value) return '';
  if (value instanceof Date) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  return String(value).slice(0, 10);
};
const timeOnly = value => (value ? String(value).slice(0, 5) : '');

const notFound = message => new HttpError(404, 'not_found', message);

async function removeById(table, id, companyId) {
  const { rowCount } = await query(`DELETE FROM ${table} WHERE id = $1 AND empresa_id = $2`, [id, companyId]);
  if (!rowCount) throw notFound('Registro não encontrado.');
}

// ---------- paginacao por cursor ----------
// Cursor (data, id) em vez de OFFSET: nao fica lento em tabelas grandes nem repete ou pula
// itens quando um registro novo entra enquanto a pessoa navega.

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

function encodeCursor(date, id) {
  return Buffer.from(`${date}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  const decoded = Buffer.from(String(value), 'base64url').toString('utf8');
  const match = decoded.match(/^(\d{4}-\d{2}-\d{2})\|(\d{1,15})$/);
  if (!match) throw invalid('O cursor de paginação é inválido. Recarregue a lista.');
  return { date: isoDate(match[1], 'a data do cursor'), id: Number(match[2]) };
}

function pageOptions(params) {
  const limit = params.has('limit') ? integer(params.get('limit'), 'o tamanho da página', { min: 1 }) : PAGE_DEFAULT;
  return { limit: Math.min(limit, PAGE_MAX), cursor: decodeCursor(params.get('cursor')) };
}

function toPage(rows, limit, mapRow, dateColumn) {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(mapRow),
    nextCursor: hasMore ? encodeCursor(dateOnly(last[dateColumn]), last.id) : null
  };
}

const wantsPage = params => ['limit', 'cursor', 'tipo', 'q'].some(name => params.has(name));

function resourceRoutes({ prefix, table, list, create, extra }) {
  return async function handle(req, res, pathname) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
    const target = targetFromPath(prefix, pathname);
    if (target === undefined) return false;

    const user = await requireUser(req);

    if (req.method === 'GET' && target === null) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      sendJson(res, 200, await list(user.empresa_id, params));
      return true;
    }
    if (req.method === 'POST' && target === null) {
      sendJson(res, 201, await create(await readBody(req), user.empresa_id));
      return true;
    }
    if (extra && target) {
      const result = await extra(req, target, user);
      if (result !== undefined) {
        sendJson(res, 200, result);
        return true;
      }
    }
    if (req.method === 'DELETE' && target && !target.action && table) {
      await removeById(table, target.id, user.empresa_id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (target && target.action) return false;
    throw new HttpError(405, 'method_not_allowed', 'Operação não permitida neste endereço.');
  };
}

// ---------- clientes ----------

function mapCustomer(row) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email || '',
    telefone: row.telefone || '',
    observacoes: row.observacoes || '',
    created: dateOnly(row.criado_em)
  };
}

async function listCustomers(companyId) {
  const { rows } = await query('SELECT * FROM cliente WHERE empresa_id = $1 ORDER BY nome', [companyId]);
  return rows.map(mapCustomer);
}

async function createCustomer(body, companyId) {
  const { rows } = await query(
    `INSERT INTO cliente (empresa_id, nome, email, telefone, observacoes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      companyId,
      requiredText(body.nome, 'o nome do cliente', 150),
      optionalEmail(body.email),
      optionalText(body.telefone, 'o telefone', 20),
      optionalText(body.observacoes, 'as observações', 2000)
    ]
  );
  return mapCustomer(rows[0]);
}

// ---------- fornecedores ----------

function mapSupplier(row) {
  return {
    id: row.id,
    nome: row.nome,
    documento: row.documento || '',
    telefone: row.telefone || '',
    email: row.email || '',
    cidade: row.cidade || '',
    estado: row.estado || '',
    categoria: row.categoria_fornecida || '',
    observacoes: row.observacoes || '',
    created: dateOnly(row.criado_em)
  };
}

async function listSuppliers(companyId) {
  const { rows } = await query('SELECT * FROM fornecedor WHERE empresa_id = $1 ORDER BY nome', [companyId]);
  return rows.map(mapSupplier);
}

async function createSupplier(body, companyId) {
  const { rows } = await query(
    `INSERT INTO fornecedor (empresa_id, nome, documento, telefone, email, cidade, estado, categoria_fornecida, observacoes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      companyId,
      requiredText(body.nome, 'o nome do fornecedor', 150),
      optionalText(body.documento, 'o CNPJ/CPF', 18),
      optionalText(body.telefone, 'o telefone', 20),
      optionalEmail(body.email),
      optionalText(body.cidade, 'a cidade', 100),
      stateCode(body.estado),
      optionalText(body.categoria, 'a categoria', 100),
      optionalText(body.observacoes, 'as observações', 2000)
    ]
  );
  return mapSupplier(rows[0]);
}

// ---------- produtos ----------

function mapProduct(row) {
  return {
    id: row.id,
    code: row.codigo || '',
    barcode: row.codigo_barras || '',
    name: row.nome,
    category: row.categoria || '',
    supplier: row.fornecedor_nome || '',
    quantity: row.quantidade,
    minimum: row.quantidade_minima,
    costPrice: Number(row.preco_custo),
    salePrice: Number(row.preco_venda)
  };
}

async function listProducts(companyId) {
  const { rows } = await query(
    `SELECT p.*, f.nome AS fornecedor_nome
       FROM produto p
       LEFT JOIN fornecedor f ON f.id = p.fornecedor_id
      WHERE p.empresa_id = $1
      ORDER BY p.nome`,
    [companyId]
  );
  return rows.map(mapProduct);
}

async function createProduct(body, companyId) {
  const name = requiredText(body.name, 'o nome do produto', 150);
  const code = optionalText(body.code, 'o código do produto', 50);
  const barcode = optionalText(body.barcode, 'o código de barras', 50);
  const category = optionalText(body.category, 'a categoria', 100);
  const supplierName = optionalText(body.supplier, 'o fornecedor', 150);
  const quantity = integer(body.quantity, 'a quantidade', { fallback: 0 });
  const minimum = integer(body.minimum, 'a quantidade mínima', { fallback: 0 });
  const costPrice = money(body.costPrice || 0, 'o preço de custo', { allowZero: true });
  const salePrice = money(body.salePrice || 0, 'o preço de venda', { allowZero: true });

  const { product, supplier } = await withTransaction(async db => {
    if (code) {
      const duplicate = await db.query('SELECT 1 FROM produto WHERE empresa_id = $1 AND codigo = $2', [companyId, code]);
      if (duplicate.rows.length) throw new HttpError(409, 'duplicate_code', 'Já existe um produto com este código.');
    }

    const linkedSupplier = await findOrCreateSupplier(supplierName, companyId, db);
    const { rows } = await db.query(
      `INSERT INTO produto (empresa_id, fornecedor_id, codigo, codigo_barras, nome, categoria, quantidade, quantidade_minima, preco_custo, preco_venda)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [companyId, linkedSupplier?.id ?? null, code, barcode, name, category, quantity, minimum, costPrice, salePrice]
    );
    const created = rows[0];
    if (quantity > 0) {
      await db.query(
        `INSERT INTO movimentacao_estoque (empresa_id, produto_id, produto_nome, tipo, quantidade, observacao)
         VALUES ($1, $2, $3, 'entrada', $4, 'Cadastro inicial')`,
        [companyId, created.id, created.nome, quantity]
      );
    }
    return { product: created, supplier: linkedSupplier };
  });

  return mapProduct({ ...product, fornecedor_nome: supplier?.nome || '' });
}

// ---------- movimentacoes de estoque ----------

function mapStockMovement(row) {
  return {
    id: row.id,
    date: dateOnly(row.data_movimentacao),
    productName: row.produto_nome,
    movement: row.tipo,
    quantity: row.quantidade,
    note: row.observacao || ''
  };
}

async function listStockMovementsPage(companyId, { limit = PAGE_DEFAULT, cursor = null } = {}) {
  const values = [companyId];
  let after = '';
  if (cursor) {
    values.push(cursor.date, cursor.id);
    after = 'AND (data_movimentacao, id) < ($2::date, $3::bigint)';
  }
  values.push(limit + 1);
  const { rows } = await query(
    `SELECT * FROM movimentacao_estoque
      WHERE empresa_id = $1 ${after}
      ORDER BY data_movimentacao DESC, id DESC
      LIMIT $${values.length}`,
    values
  );
  return toPage(rows, limit, mapStockMovement, 'data_movimentacao');
}

// Sem parametros mantem o contrato antigo (lista inteira); com ?limit/?cursor devolve { items, nextCursor }.
async function listStockMovements(companyId, params = new URLSearchParams()) {
  if (wantsPage(params)) return listStockMovementsPage(companyId, pageOptions(params));
  const { rows } = await query(
    `SELECT * FROM movimentacao_estoque
      WHERE empresa_id = $1
      ORDER BY data_movimentacao DESC, id DESC`,
    [companyId]
  );
  return rows.map(mapStockMovement);
}

async function createStockMovement(body, companyId) {
  const productId = integer(body.productId, 'o produto', { min: 1 });
  const quantity = integer(body.quantity, 'a quantidade', { min: 1 });
  const movement = oneOf(body.movement, ['entrada', 'saida'], 'entrada', 'o tipo de movimentação');
  const note = optionalText(body.note, 'a observação', 200);

  const created = await withTransaction(async db => {
    const { rows } = await db.query(
      'SELECT id, nome, quantidade FROM produto WHERE id = $1 AND empresa_id = $2 FOR UPDATE',
      [productId, companyId]
    );
    const product = rows[0];
    if (!product) throw notFound('Produto não encontrado.');
    if (movement === 'saida' && product.quantidade < quantity) {
      throw new HttpError(400, 'insufficient_stock', 'Quantidade insuficiente em estoque.');
    }

    const newQuantity = movement === 'entrada' ? product.quantidade + quantity : product.quantidade - quantity;
    await db.query('UPDATE produto SET quantidade = $1 WHERE id = $2 AND empresa_id = $3', [newQuantity, productId, companyId]);

    const inserted = await db.query(
      `INSERT INTO movimentacao_estoque (empresa_id, produto_id, produto_nome, tipo, quantidade, observacao)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [companyId, productId, product.nome, movement, quantity, note]
    );
    return inserted.rows[0];
  });

  return mapStockMovement(created);
}

// ---------- transacoes (movimentacoes financeiras) ----------

function mapTransaction(row) {
  return {
    id: row.id,
    data: dateOnly(row.data_transacao),
    descricao: row.descricao,
    categoria: row.categoria_nome || '',
    tipo: row.tipo,
    valor: Number(row.valor),
    cliente: row.cliente_nome || ''
  };
}

const TRANSACTION_SELECT =
  `SELECT t.*, c.nome AS categoria_nome, cl.nome AS cliente_nome
     FROM transacao t
     LEFT JOIN categoria c ON c.id = t.categoria_id
     LEFT JOIN cliente cl ON cl.id = t.cliente_id`;

// Mesma regra da busca que a tela fazia no navegador. position() evita tratar % e _ como curingas.
async function listTransactionsPage(companyId, { limit = PAGE_DEFAULT, cursor = null, type = null, search = null } = {}) {
  const values = [companyId];
  const conditions = ['t.empresa_id = $1'];
  if (type) {
    values.push(type);
    conditions.push(`t.tipo = $${values.length}`);
  }
  if (search) {
    values.push(search);
    conditions.push(`position(lower($${values.length}) in lower(t.descricao || ' ' || coalesce(c.nome, ''))) > 0`);
  }
  if (cursor) {
    values.push(cursor.date, cursor.id);
    conditions.push(`(t.data_transacao, t.id) < ($${values.length - 1}::date, $${values.length}::bigint)`);
  }
  values.push(limit + 1);

  const { rows } = await query(
    `${TRANSACTION_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.data_transacao DESC, t.id DESC
      LIMIT $${values.length}`,
    values
  );
  return toPage(rows, limit, mapTransaction, 'data_transacao');
}

async function listTransactions(companyId, params = new URLSearchParams()) {
  if (wantsPage(params)) {
    const tipo = params.get('tipo');
    return listTransactionsPage(companyId, {
      ...pageOptions(params),
      type: tipo && tipo !== 'all' ? oneOf(tipo, ['entrada', 'saida'], null, 'o tipo da movimentação') : null,
      search: optionalText(params.get('q'), 'o texto da busca', 100)
    });
  }
  const { rows } = await query(
    `${TRANSACTION_SELECT}
      WHERE t.empresa_id = $1
      ORDER BY t.data_transacao DESC, t.id DESC`,
    [companyId]
  );
  return rows.map(mapTransaction);
}

async function createTransaction(body, companyId) {
  const type = oneOf(body.tipo, ['entrada', 'saida'], 'entrada', 'o tipo da movimentação');
  const description = requiredText(body.descricao, 'a descrição', 200);
  const amount = money(body.valor, 'um valor');
  const date = isoDate(body.data, 'a data');
  const categoryName = optionalText(body.categoria, 'a categoria', 80);
  const customerName = optionalText(body.cliente, 'o cliente', 150);

  const { created, customer } = await withTransaction(async db => {
    const categoryId = await findOrCreateCategory(categoryName, type === 'entrada' ? 'receita' : 'despesa', companyId, db);
    const linkedCustomer = await findOrCreateCustomer(customerName, companyId, db);
    const { rows } = await db.query(
      `INSERT INTO transacao (empresa_id, categoria_id, cliente_id, tipo, descricao, valor, data_transacao)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, CURRENT_DATE)) RETURNING *`,
      [companyId, categoryId, linkedCustomer?.id ?? null, type, description, amount, date]
    );
    return { created: rows[0], customer: linkedCustomer };
  });

  return mapTransaction({ ...created, categoria_nome: categoryName, cliente_nome: customer?.nome || '' });
}

// ---------- resumo financeiro ----------
// O navegador so tem a primeira pagina de transacoes; os totais de todas sao somados aqui,
// em NUMERIC, e saem em centavos inteiros.

async function financialSummary(companyId) {
  const [monthly, categories, customers] = await Promise.all([
    query(
      `SELECT to_char(data_transacao, 'YYYY-MM') AS month,
              (COALESCE(sum(valor) FILTER (WHERE tipo = 'entrada'), 0) * 100)::bigint AS income_cents,
              (COALESCE(sum(valor) FILTER (WHERE tipo = 'saida'), 0) * 100)::bigint AS expense_cents,
              count(*) FILTER (WHERE tipo = 'entrada')::int AS income_count,
              count(*)::int AS transaction_count
         FROM transacao
        WHERE empresa_id = $1
        GROUP BY 1
        ORDER BY 1`,
      [companyId]
    ),
    query(
      `SELECT COALESCE(c.nome, 'Geral') AS category, (sum(t.valor) * 100)::bigint AS cents
         FROM transacao t
         LEFT JOIN categoria c ON c.id = t.categoria_id
        WHERE t.empresa_id = $1 AND t.tipo = 'saida'
        GROUP BY 1
        ORDER BY cents DESC, category`,
      [companyId]
    ),
    query(
      `SELECT cl.nome AS customer, (sum(t.valor) * 100)::bigint AS cents
         FROM transacao t
         JOIN cliente cl ON cl.id = t.cliente_id
        WHERE t.empresa_id = $1 AND t.tipo = 'entrada'
        GROUP BY cl.nome`,
      [companyId]
    )
  ]);

  // Os totais gerais sao a soma dos meses: inteiros, entao a soma em JavaScript e exata.
  const totals = { incomeCents: 0, expenseCents: 0, incomeCount: 0, transactionCount: 0 };
  monthly.rows.forEach(row => {
    totals.incomeCents += row.income_cents;
    totals.expenseCents += row.expense_cents;
    totals.incomeCount += row.income_count;
    totals.transactionCount += row.transaction_count;
  });

  return {
    monthly: monthly.rows.map(row => ({ month: row.month, incomeCents: row.income_cents, expenseCents: row.expense_cents })),
    totals,
    expensesByCategory: categories.rows.map(row => ({ category: row.category, cents: row.cents })),
    incomeByCustomer: customers.rows.map(row => ({ customer: row.customer, cents: row.cents }))
  };
}

// ---------- contas a pagar/receber ----------

function mapBill(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    descricao: row.descricao,
    valor: Number(row.valor),
    vencimento: dateOnly(row.vencimento),
    status: row.status
  };
}

async function listBills(companyId) {
  const { rows } = await query('SELECT * FROM conta WHERE empresa_id = $1 ORDER BY vencimento, id', [companyId]);
  return rows.map(mapBill);
}

async function createBill(body, companyId) {
  const { rows } = await query(
    `INSERT INTO conta (empresa_id, tipo, descricao, valor, vencimento)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      companyId,
      oneOf(body.tipo, ['pagar', 'receber'], 'receber', 'o tipo da conta'),
      requiredText(body.descricao, 'a descrição', 200),
      money(body.valor, 'um valor'),
      isoDate(body.vencimento, 'a data de vencimento', { required: true })
    ]
  );
  return mapBill(rows[0]);
}

async function toggleBillStatus(req, target, user) {
  if (req.method !== 'POST' || target.action !== 'status') return undefined;

  const { rows } = await query(
    `UPDATE conta SET
       status = CASE WHEN status = 'pago' THEN 'pendente' ELSE 'pago' END::status_conta,
       pago_em = CASE WHEN status = 'pago' THEN NULL ELSE now() END
     WHERE id = $1 AND empresa_id = $2
     RETURNING *`,
    [target.id, user.empresa_id]
  );
  if (!rows[0]) throw notFound('Conta não encontrada.');
  return mapBill(rows[0]);
}

// ---------- servicos prestados ----------

function mapService(row) {
  return {
    id: row.id,
    client: row.cliente_nome || '',
    description: row.descricao,
    valor: Number(row.valor),
    date: dateOnly(row.data_servico)
  };
}

async function listServices(companyId) {
  const { rows } = await query(
    `SELECT s.*, cl.nome AS cliente_nome
       FROM servico s
       LEFT JOIN cliente cl ON cl.id = s.cliente_id
      WHERE s.empresa_id = $1
      ORDER BY s.data_servico DESC, s.id DESC`,
    [companyId]
  );
  return rows.map(mapService);
}

async function createService(body, companyId) {
  const description = requiredText(body.description, 'a descrição do serviço', 200);
  const amount = money(body.valor, 'um valor');
  const date = isoDate(body.date, 'a data');
  const customerName = optionalText(body.client, 'o cliente', 150);

  const { created, customer } = await withTransaction(async db => {
    const linkedCustomer = await findOrCreateCustomer(customerName, companyId, db);
    const { rows } = await db.query(
      `INSERT INTO servico (empresa_id, cliente_id, descricao, valor, data_servico)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE)) RETURNING *`,
      [companyId, linkedCustomer?.id ?? null, description, amount, date]
    );
    return { created: rows[0], customer: linkedCustomer };
  });

  return mapService({ ...created, cliente_nome: customer?.nome || '' });
}

// ---------- agenda / eventos ----------

const EVENT_TYPES = ['entrega', 'compra', 'fornecedor', 'reuniao', 'compromisso', 'feriado', 'importante'];

function mapEvent(row) {
  return {
    id: row.id,
    title: row.titulo,
    type: row.tipo,
    date: dateOnly(row.data_evento),
    time: timeOnly(row.horario),
    description: row.descricao || ''
  };
}

async function listEvents(companyId) {
  const { rows } = await query(
    'SELECT * FROM evento_agenda WHERE empresa_id = $1 ORDER BY data_evento, horario NULLS FIRST, id',
    [companyId]
  );
  return rows.map(mapEvent);
}

async function createEvent(body, companyId) {
  const { rows } = await query(
    `INSERT INTO evento_agenda (empresa_id, titulo, tipo, data_evento, horario, descricao)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      companyId,
      requiredText(body.title, 'o título do evento', 150),
      oneOf(body.type, EVENT_TYPES, 'compromisso', 'o tipo do evento'),
      isoDate(body.date, 'a data do evento', { required: true }),
      time(body.time, 'o horário'),
      optionalText(body.description, 'a descrição', 300)
    ]
  );
  return mapEvent(rows[0]);
}

// ---------- roteamento ----------

const ROUTES = [
  resourceRoutes({ prefix: '/api/clientes', table: 'cliente', list: listCustomers, create: createCustomer }),
  resourceRoutes({ prefix: '/api/fornecedores', table: 'fornecedor', list: listSuppliers, create: createSupplier }),
  resourceRoutes({ prefix: '/api/produtos', table: 'produto', list: listProducts, create: createProduct }),
  resourceRoutes({ prefix: '/api/movimentacoes-estoque', list: listStockMovements, create: createStockMovement }),
  resourceRoutes({ prefix: '/api/transacoes', table: 'transacao', list: listTransactions, create: createTransaction }),
  resourceRoutes({ prefix: '/api/contas', table: 'conta', list: listBills, create: createBill, extra: toggleBillStatus }),
  resourceRoutes({ prefix: '/api/servicos', table: 'servico', list: listServices, create: createService }),
  resourceRoutes({ prefix: '/api/eventos', table: 'evento_agenda', list: listEvents, create: createEvent })
];

async function handleSummaryRoute(req, res, pathname) {
  if (pathname !== '/api/resumo') return false;
  if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Operação não permitida neste endereço.');
  const user = await requireUser(req);
  sendJson(res, 200, await financialSummary(user.empresa_id));
  return true;
}

async function handleDataRoutes(req, res, pathname) {
  if (await handleSummaryRoute(req, res, pathname)) return true;
  for (const handle of ROUTES) {
    if (await handle(req, res, pathname)) return true;
  }
  return false;
}

module.exports = {
  handleDataRoutes,
  listCustomers,
  listSuppliers,
  listProducts,
  listStockMovementsPage,
  listTransactionsPage,
  listBills,
  listServices,
  listEvents,
  financialSummary
};
