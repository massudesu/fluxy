// Cria (ou atualiza) as tabelas do Fluxy no PostgreSQL.
// Uso:
//   node backend/database/migrate.js          -> so cria o schema
//   node backend/database/migrate.js --seed    -> schema + dados de exemplo

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { DATABASE_URL } = require('../src/config');

// Erros comuns na primeira instalacao e o que fazer (ver README, passos 2 e 3).
const HINTS = {
  '3D000': 'o banco ainda nao existe: crie com "createdb -U postgres fluxy_db" (ou CREATE DATABASE no pgAdmin).',
  '28P01': 'usuario ou senha recusados: confira DATABASE_URL em backend/.env.',
  ECONNREFUSED: 'o PostgreSQL nao respondeu: confira se ele esta em execucao e a porta em DATABASE_URL.'
};

async function run() {
  const poolConfig = { connectionString: DATABASE_URL };
  if (DATABASE_URL && (DATABASE_URL.includes('sslmode=require') || DATABASE_URL.includes('neon.tech') || DATABASE_URL.includes('supabase.co'))) {
    poolConfig.ssl = { rejectUnauthorized: false };
  }
  const pool = new Pool(poolConfig);
  // So os avisos do proprio schema.sql (ex.: cadastros repetidos unidos); os "already exists,
  // skipping" do CREATE ... IF NOT EXISTS ficam de fora.
  pool.on('connect', client => client.on('notice', notice => {
    if (notice.message.startsWith('Fluxy:')) console.log(`[Fluxy] ${notice.message.slice(7)}`);
  }));
  const schemaPath = path.join(__dirname, 'schema.sql');
  const seedPath = path.join(__dirname, 'seed.sql');

  console.log('[Fluxy] conectando em', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

  try {
    console.log('[Fluxy] aplicando schema.sql...');
    await pool.query(fs.readFileSync(schemaPath, 'utf8'));
    console.log('[Fluxy] schema pronto.');

    if (process.argv.includes('--seed')) {
      console.log('[Fluxy] inserindo dados de exemplo...');
      await pool.query(fs.readFileSync(seedPath, 'utf8'));
      console.log('[Fluxy] dados de exemplo inseridos.');
    }
  } catch (error) {
    console.error('[Fluxy] falha ao configurar o banco:', error.message);
    if (HINTS[error.code]) console.error('[Fluxy] dica:', HINTS[error.code]);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
