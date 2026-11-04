const { query } = require('./db');
const { HttpError } = require('./http-helpers');
const { hashToken } = require('./security');
const { sessionToken } = require('./session-cookie');

async function userFromToken(req) {
  const token = sessionToken(req);
  if (!token) return null;

  const { rows } = await query(
    `SELECT u.id, u.empresa_id, u.nome, u.email, u.telefone, u.papel, u.senha_hash, u.criado_em,
            s.id AS sessao_id
       FROM sessao s
       JOIN usuario u ON u.id = s.usuario_id
      WHERE s.token_hash = $1 AND s.expira_em > now() AND s.revogado_em IS NULL AND u.ativo = TRUE`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function requireUser(req) {
  const user = await userFromToken(req);
  if (!user) throw new HttpError(401, 'unauthorized', 'Sua sessão expirou. Entre novamente.');
  return user;
}

module.exports = { userFromToken, requireUser };
