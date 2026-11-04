const { query, withTransaction } = require('../lib/db');
const { HttpError, sendJson, readBody } = require('../lib/http-helpers');
const { clearedSessionCookie } = require('../lib/session-cookie');
const { log } = require('../lib/logger');
const { requireUser } = require('../lib/auth-middleware');
const { createRateLimiter, consume } = require('../lib/rate-limit');
const { requiredText, optionalText } = require('../lib/validation');
const { passwordHash, passwordMatches, passwordProblem } = require('../lib/security');

const ACCESS_HISTORY_LIMIT = 5;

const passwordFailuresByUser = createRateLimiter({ name: 'senha-atual-usuario', windowMs: 15 * 60 * 1000, max: 5 });

function mapProfile(user) {
  return {
    id: user.id,
    name: user.nome,
    email: user.email,
    phone: user.telefone || '',
    role: user.papel,
    created: user.criado_em
  };
}

function describeDevice(userAgent) {
  const agent = String(userAgent || '');
  if (!agent) return 'Dispositivo não identificado';
  const kind = /Mobile|Android|iPhone/i.test(agent) ? 'Celular' : 'Computador';
  const browser = [
    ['Edg/', 'Edge'], ['OPR/', 'Opera'], ['Firefox/', 'Firefox'], ['Chrome/', 'Chrome'], ['Safari/', 'Safari']
  ].find(([marker]) => agent.includes(marker));
  return browser ? `${kind} · ${browser[1]}` : kind;
}

async function listAccessHistory(usuarioId) {
  const { rows } = await query(
    `SELECT data_acesso, dispositivo, sucesso
       FROM historico_acesso
      WHERE usuario_id = $1
      ORDER BY data_acesso DESC
      LIMIT $2`,
    [usuarioId, ACCESS_HISTORY_LIMIT]
  );
  return rows.map(row => ({ date: row.data_acesso, device: describeDevice(row.dispositivo), success: row.sucesso }));
}

async function confirmCurrentPassword(user, password) {
  await consume(passwordFailuresByUser, user.id);
  if (!(await passwordMatches(typeof password === 'string' ? password : '', user.senha_hash))) {
    throw new HttpError(403, 'wrong_password', 'A senha atual não confere.');
  }
  await passwordFailuresByUser.reset(user.id);
}

async function showProfile(req, res) {
  sendJson(res, 200, mapProfile(await requireUser(req)));
}

async function updateProfile(req, res) {
  const user = await requireUser(req);
  const body = await readBody(req);
  const name = requiredText(body.name, 'o seu nome', 120);
  const phone = optionalText(body.phone, 'o telefone', 20);

  const { rows } = await query(
    `UPDATE usuario SET nome = $1, telefone = $2, atualizado_em = now()
      WHERE id = $3
      RETURNING id, nome, email, telefone, papel, criado_em`,
    [name, phone, user.id]
  );
  sendJson(res, 200, mapProfile(rows[0]));
}

async function showAccessHistory(req, res) {
  const user = await requireUser(req);
  sendJson(res, 200, await listAccessHistory(user.id));
}

async function changePassword(req, res) {
  const user = await requireUser(req);
  const body = await readBody(req);

  await confirmCurrentPassword(user, body.currentPassword);
  const problem = passwordProblem(body.newPassword);
  if (problem) throw new HttpError(400, 'weak_password', problem);

  const senhaHash = await passwordHash(body.newPassword);
  await withTransaction(async db => {
    await db.query('UPDATE usuario SET senha_hash = $1, atualizado_em = now() WHERE id = $2', [senhaHash, user.id]);
    await db.query('UPDATE redefinicao_senha SET utilizado = TRUE WHERE usuario_id = $1', [user.id]);
    await db.query(
      'UPDATE sessao SET revogado_em = now() WHERE usuario_id = $1 AND id <> $2 AND revogado_em IS NULL',
      [user.id, user.sessao_id]
    );
  });

  log('password_changed', `id=${user.id}`);
  sendJson(res, 200, { ok: true, message: 'Senha alterada.' });
}

async function endOtherSessions(req, res) {
  const user = await requireUser(req);
  const { rowCount } = await query(
    'UPDATE sessao SET revogado_em = now() WHERE usuario_id = $1 AND id <> $2 AND revogado_em IS NULL AND expira_em > now()',
    [user.id, user.sessao_id]
  );
  sendJson(res, 200, { ok: true, ended: rowCount });
}

// Unica usuaria da empresa: a empresa vai junto e, por ON DELETE CASCADE, todos os dados.
async function deleteAccount(req, res) {
  const user = await requireUser(req);
  const body = await readBody(req);
  await confirmCurrentPassword(user, body.password);

  await withTransaction(async db => {
    const { rows } = await db.query('SELECT count(*)::int AS total FROM usuario WHERE empresa_id = $1', [user.empresa_id]);
    if (rows[0].total <= 1) await db.query('DELETE FROM empresa WHERE id = $1', [user.empresa_id]);
    else await db.query('DELETE FROM usuario WHERE id = $1', [user.id]);
  });

  log('account_deleted', `id=${user.id}`);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedSessionCookie() });
}

const ROUTES = {
  'GET /api/me': showProfile,
  'POST /api/me': updateProfile,
  'PUT /api/me': updateProfile,
  'DELETE /api/me': deleteAccount,
  'GET /api/me/acessos': showAccessHistory,
  'POST /api/auth/change-password': changePassword,
  'POST /api/auth/logout-others': endOtherSessions
};

async function handleAccountRoutes(req, res, pathname) {
  const handler = ROUTES[`${req.method} ${pathname}`];
  if (!handler) return false;
  await handler(req, res);
  return true;
}

module.exports = { handleAccountRoutes, mapProfile, listAccessHistory };
