const { query } = require('./db');
const { logError } = require('./logger');
const { purgeExpiredLimits } = require('./rate-limit');

const INTERVAL_MS = 12 * 60 * 60 * 1000;

// Remove apenas sessoes, links e contadores de tentativa ja vencidos; nenhum dado de negocio e tocado.
async function purgeExpiredAccessRecords() {
  try {
    await query(`DELETE FROM redefinicao_senha WHERE expira_em < now() - interval '1 day'`);
    await query(
      `DELETE FROM sessao
        WHERE expira_em < now() - interval '7 days'
           OR revogado_em < now() - interval '7 days'`
    );
    await purgeExpiredLimits();
  } catch (error) {
    logError('limpeza de sessoes e links expirados', error);
  }
}

function scheduleMaintenance() {
  purgeExpiredAccessRecords();
  setInterval(purgeExpiredAccessRecords, INTERVAL_MS).unref();
}

module.exports = { scheduleMaintenance, purgeExpiredAccessRecords };
