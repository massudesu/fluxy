const defaultDb = require('./db');

// O indice unico (empresa_id, lower(nome)) torna a busca-ou-cadastro atomica com pedidos
// simultaneos. Devolve { id, nome } com o nome como esta gravado.
async function findOrCreateByName(table, name, companyId, db) {
  const inserted = await db.query(
    `INSERT INTO ${table} (empresa_id, nome) VALUES ($1, $2)
     ON CONFLICT (empresa_id, lower(nome)) DO NOTHING
     RETURNING id, nome`,
    [companyId, name]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await db.query(
    `SELECT id, nome FROM ${table} WHERE empresa_id = $1 AND lower(nome) = lower($2)`,
    [companyId, name]
  );
  return existing.rows[0];
}

function findOrCreateCustomer(name, companyId, db = defaultDb) {
  return name ? findOrCreateByName('cliente', name, companyId, db) : null;
}

function findOrCreateSupplier(name, companyId, db = defaultDb) {
  return name ? findOrCreateByName('fornecedor', name, companyId, db) : null;
}

async function findOrCreateCategory(name, type, companyId, db = defaultDb) {
  if (!name) return null;

  const inserted = await db.query(
    `INSERT INTO categoria (empresa_id, nome, tipo) VALUES ($1, $2, $3)
     ON CONFLICT (empresa_id, nome, tipo) DO NOTHING
     RETURNING id`,
    [companyId, name, type]
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  const { rows } = await db.query(
    'SELECT id FROM categoria WHERE empresa_id = $1 AND nome = $2 AND tipo = $3',
    [companyId, name, type]
  );
  return rows[0].id;
}

module.exports = { findOrCreateCustomer, findOrCreateSupplier, findOrCreateCategory };
