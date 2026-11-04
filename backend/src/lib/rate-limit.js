const crypto = require('crypto');
const { query } = require('./db');
const { HttpError } = require('./http-helpers');

function createRateLimiter({ name, windowMs, max }) {
  const storageKey = key => crypto.createHash('sha256').update(`${name}\u0000${String(key)}`).digest('hex');

  return {
    max,
    async hit(key) {
      const { rows } = await query(
        `INSERT INTO limite_tentativa (chave, contagem, expira_em)
         VALUES ($1, 1, now() + make_interval(secs => $2))
         ON CONFLICT (chave) DO UPDATE SET
           contagem  = CASE WHEN limite_tentativa.expira_em <= now() THEN 1 ELSE limite_tentativa.contagem + 1 END,
           expira_em = CASE WHEN limite_tentativa.expira_em <= now() THEN EXCLUDED.expira_em ELSE limite_tentativa.expira_em END
         RETURNING contagem, GREATEST(1, ceil(extract(epoch FROM expira_em - now())))::int AS seconds_left`,
        [storageKey(key), windowMs / 1000]
      );
      return { count: rows[0].contagem, secondsLeft: rows[0].seconds_left };
    },
    async reset(key) {
      await query('DELETE FROM limite_tentativa WHERE chave = $1', [storageKey(key)]);
    }
  };
}

function tooManyRequests(seconds) {
  const minutes = Math.ceil(seconds / 60);
  const wait = minutes > 1 ? `${minutes} minutos` : '1 minuto';
  return new HttpError(429, 'too_many_requests', `Muitas tentativas. Aguarde ${wait} e tente de novo.`, {
    retryAfter: seconds
  });
}

// Conta e confere numa unica operacao: pedidos simultaneos nao passam juntos pelo limite.
async function consume(limiter, key) {
  const { count, secondsLeft } = await limiter.hit(key);
  if (count > limiter.max) throw tooManyRequests(secondsLeft);
}

async function purgeExpiredLimits() {
  await query('DELETE FROM limite_tentativa WHERE expira_em < now()');
}

module.exports = { createRateLimiter, consume, purgeExpiredLimits };
