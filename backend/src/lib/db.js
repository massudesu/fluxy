const { Pool, types } = require('pg');
const { DATABASE_URL } = require('../config');

// BIGINT (ids e contagens) vira Number enquanto couber sem perda; acima disso fica como texto.
types.setTypeParser(20, value => {
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
});

// NUMERIC fica como texto (exato): somas sao feitas no banco e Number so aparece na resposta.

// DATE fica como "AAAA-MM-DD": convertido para Date, o dia mudaria conforme o fuso do servidor.
types.setTypeParser(1082, value => value);

// Sem limite, um banco inacessivel deixaria a requisicao parada ate o timeout do sistema operacional.
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000 });

pool.on('error', error => {
  console.error('[Fluxy] erro inesperado no pool do PostgreSQL:', error.message);
});

function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
