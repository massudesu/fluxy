const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NEEDS_DATABASE = ['api.test.js', 'correcoes.test.js', 'recuperacao-senha.test.js', 'seguranca.test.js'];

async function databaseProblem() {
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (_error) {
    return 'o driver "pg" nao esta instalado (rode "npm install")';
  }

  const { DATABASE_URL } = require('../backend/src/config');
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 4000 });
  try {
    await pool.query('SELECT 1 FROM usuario LIMIT 1');
    return '';
  } catch (error) {
    return error.code === '42P01'
      ? 'as tabelas ainda nao existem (rode "npm run db:migrate")'
      : `nao foi possivel conectar ao PostgreSQL (${error.code || error.message})`;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  const all = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js')).sort();
  const problem = await databaseProblem();
  const skipped = problem ? all.filter(file => NEEDS_DATABASE.includes(file)) : [];
  if (!problem) {
    const helpers = require('./helpers/server');
    await helpers.resetLocalhostLimits();
    await helpers.cleanup();
  }
  const selected = all.filter(file => !skipped.includes(file));

  const result = spawnSync(process.execPath, ['--test', ...selected.map(file => path.join(__dirname, file))], { stdio: 'inherit' });

  if (skipped.length) {
    console.log(`\nNAO EXECUTADOS (dependem de configuracao externa): ${skipped.join(', ')}`);
    console.log(`Motivo: ${problem}.`);
  }
  process.exit(result.status || (skipped.length ? 2 : 0));
}

main();
