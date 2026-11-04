const { query, withTransaction } = require('../lib/db');
const { HttpError, sendJson, readBody, clientIp } = require('../lib/http-helpers');
const { sessionToken, sessionCookie, clearedSessionCookie } = require('../lib/session-cookie');
const { log, logError } = require('../lib/logger');
const { createRateLimiter, consume } = require('../lib/rate-limit');
const { requiredText, optionalText } = require('../lib/validation');
const mailer = require('../lib/mailer');
const { APP_URL } = require('../config');
const {
  passwordHash,
  passwordMatches,
  simulatePasswordCheck,
  passwordProblem,
  newToken,
  hashToken,
  normalizeEmail,
  isValidEmail
} = require('../lib/security');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const SESSION_REMEMBERED_MS = 30 * 24 * HOUR;
const SESSION_DEFAULT_MS = 12 * HOUR;
const RESET_MINUTES = 30;

const limits = {
  loginByIp: createRateLimiter({ name: 'login-ip', windowMs: 15 * MINUTE, max: 50 }),
  loginFailuresByEmailAndIp: createRateLimiter({ name: 'login-falha-email-ip', windowMs: 15 * MINUTE, max: 5 }),
  loginFailuresByEmail: createRateLimiter({ name: 'login-falha-email', windowMs: 15 * MINUTE, max: 20 }),
  registerByIp: createRateLimiter({ name: 'cadastro-ip', windowMs: HOUR, max: 10 }),
  forgotByIp: createRateLimiter({ name: 'esqueci-ip', windowMs: 15 * MINUTE, max: 5 }),
  forgotByEmail: createRateLimiter({ name: 'esqueci-email', windowMs: HOUR, max: 3 }),
  resetByIp: createRateLimiter({ name: 'redefinir-ip', windowMs: 15 * MINUTE, max: 10 })
};

const FORGOT_PASSWORD_MESSAGE =
  `Se este e-mail tiver uma conta no Fluxy, o link para criar uma nova senha acaba de ser enviado. ` +
  `Confira a caixa de entrada e o spam. O link vale por ${RESET_MINUTES} minutos.`;

// Devolve o cabecalho Set-Cookie da nova sessao. O token em si nunca vai no corpo da resposta.
async function createSession(usuarioId, remember, db = { query }) {
  const token = newToken();
  const durationMs = remember ? SESSION_REMEMBERED_MS : SESSION_DEFAULT_MS;
  await db.query(
    'INSERT INTO sessao (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)',
    [usuarioId, hashToken(token), new Date(Date.now() + durationMs)]
  );
  return sessionCookie(token, remember ? durationMs : 0);
}

async function registerAccess(usuarioId, req, sucesso) {
  const dispositivo = String(req.headers['user-agent'] || '').slice(0, 150);
  await query(
    'INSERT INTO historico_acesso (usuario_id, dispositivo, sucesso) VALUES ($1, $2, $3)',
    [usuarioId, dispositivo, sucesso]
  ).catch(error => logError('historico de acesso nao gravado', error));
}

async function createEmpresaParaNovoUsuario(db, nomeUsuario) {
  const { rows } = await db.query('INSERT INTO empresa (razao_social) VALUES ($1) RETURNING id', [nomeUsuario]);
  const empresaId = rows[0].id;

  await db.query('INSERT INTO configuracao_empresa (empresa_id) VALUES ($1)', [empresaId]);
  await db.query(
    `INSERT INTO empresa_modulo (empresa_id, modulo_id, ativo)
     SELECT $1, id, TRUE FROM modulo_sistema`,
    [empresaId]
  );
  return empresaId;
}

function sessionPayload(user) {
  return {
    id: user.id,
    user_id: user.id,
    name: user.nome,
    email: user.email,
    phone: user.telefone || '',
    role: user.papel,
    created: user.criado_em
  };
}

async function register(req, res) {
  const body = await readBody(req);
  const name = requiredText(body.name, 'o seu nome', 120);
  const email = normalizeEmail(body.email);
  const phone = optionalText(body.phone, 'o telefone', 20);
  const cpf = optionalText(body.cpf, 'o CPF', 14);

  if (!isValidEmail(email)) throw new HttpError(400, 'invalid_request', 'Informe um e-mail válido.');
  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, 'weak_password', problem);

  await consume(limits.registerByIp, clientIp(req));
  const senhaHash = await passwordHash(body.password);

  const { user, cookie } = await withTransaction(async db => {
    const existing = await db.query('SELECT 1 FROM usuario WHERE email = $1', [email]);
    if (existing.rows.length) throw new HttpError(409, 'email_already_exists', 'Este e-mail já está cadastrado.');

    const empresaId = await createEmpresaParaNovoUsuario(db, name);
    const { rows } = await db.query(
      `INSERT INTO usuario (empresa_id, nome, email, senha_hash, telefone, cpf, papel)
       VALUES ($1, $2, $3, $4, $5, $6, 'admin')
       RETURNING id, nome, email, telefone, papel, criado_em`,
      [empresaId, name, email, senhaHash, phone, cpf]
    );
    return { user: rows[0], cookie: await createSession(rows[0].id, false, db) };
  });

  await registerAccess(user.id, req, true);
  log('register_success', `id=${user.id}`);
  sendJson(res, 201, sessionPayload(user), { 'Set-Cookie': cookie });
}

async function login(req, res) {
  const ip = clientIp(req);
  await consume(limits.loginByIp, ip);

  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const failureKey = `${email}|${ip}`;

  // A tentativa conta antes de conferir a senha: pedidos simultaneos nao passam todos pela
  // checagem enquanto o scrypt roda. Acertar a senha zera a contagem.
  await consume(limits.loginFailuresByEmailAndIp, failureKey);
  await consume(limits.loginFailuresByEmail, email);

  const { rows } = await query(
    'SELECT id, nome, email, telefone, papel, senha_hash, criado_em FROM usuario WHERE email = $1 AND ativo = TRUE',
    [email]
  );
  const user = rows[0];
  const passwordIsRight = user
    ? await passwordMatches(password, user.senha_hash)
    : (await simulatePasswordCheck(password), false);

  if (!passwordIsRight) {
    if (user) await registerAccess(user.id, req, false);
    throw new HttpError(401, 'invalid_credentials', 'E-mail ou senha incorretos.');
  }

  await limits.loginFailuresByEmailAndIp.reset(failureKey);
  await limits.loginFailuresByEmail.reset(email);
  const cookie = await createSession(user.id, body.remember === true);
  await registerAccess(user.id, req, true);
  log('login_success', `id=${user.id}`);
  sendJson(res, 200, sessionPayload(user), { 'Set-Cookie': cookie });
}

async function logout(req, res) {
  const token = sessionToken(req);
  if (token) {
    await query('UPDATE sessao SET revogado_em = now() WHERE token_hash = $1 AND revogado_em IS NULL', [hashToken(token)]);
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedSessionCookie() });
}

async function createResetToken(usuarioId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_MINUTES * MINUTE);

  await withTransaction(async db => {
    await db.query('UPDATE redefinicao_senha SET utilizado = TRUE WHERE usuario_id = $1 AND utilizado = FALSE', [usuarioId]);
    await db.query(
      'INSERT INTO redefinicao_senha (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)',
      [usuarioId, hashToken(token), expiresAt]
    );
  });
  return token;
}

// O token vai depois do "#": nao chega ao servidor nem aparece em logs de acesso.
const resetLink = token => `${APP_URL}/index.html#redefinir=${token}`;

async function forgotPassword(req, res) {
  const body = await readBody(req);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new HttpError(400, 'invalid_request', 'Informe um e-mail válido.');

  await consume(limits.forgotByIp, clientIp(req));
  await consume(limits.forgotByEmail, email);

  const status = mailer.mailStatus();
  if (status.mode === 'disabled') {
    throw new HttpError(
      503,
      'email_not_configured',
      'A recuperação de senha por e-mail ainda não está ativa neste servidor. Fale com quem administra o sistema.'
    );
  }

  const { rows } = await query('SELECT id, nome FROM usuario WHERE email = $1 AND ativo = TRUE', [email]);
  const user = rows[0];

  // O servidor de e-mail e consultado com ou sem conta: a resposta nao revela se o
  // e-mail esta cadastrado, e uma falha de envio nunca vira "sucesso".
  try {
    if (user) {
      const token = await createResetToken(user.id);
      await mailer.sendPasswordResetEmail({ to: email, name: user.nome, link: resetLink(token), minutes: RESET_MINUTES });
      log('password_reset_requested', `id=${user.id}`);
    } else {
      await mailer.checkMailServer();
    }
  } catch (error) {
    logError('envio do e-mail de redefinicao', error);
    if (user) {
      await query('UPDATE redefinicao_senha SET utilizado = TRUE WHERE usuario_id = $1 AND utilizado = FALSE', [user.id]);
    }
    throw new HttpError(
      502,
      'email_delivery_failed',
      'Não foi possível enviar o e-mail agora. Tente novamente em alguns minutos.'
    );
  }

  const message = status.mode === 'console'
    ? 'Modo de desenvolvimento: nenhum e-mail foi enviado. Se a conta existir, o link aparece no terminal do servidor.'
    : FORGOT_PASSWORD_MESSAGE;
  sendJson(res, 200, { ok: true, delivery: status.mode, message, expiresInMinutes: RESET_MINUTES });
}

const VALID_RESET_TOKEN_SQL =
  `SELECT r.id, r.usuario_id, u.email
     FROM redefinicao_senha r
     JOIN usuario u ON u.id = r.usuario_id
    WHERE r.token_hash = $1 AND r.utilizado = FALSE AND r.expira_em > now() AND u.ativo = TRUE`;

const invalidResetLink = () =>
  new HttpError(400, 'invalid_token', 'Este link de redefinição é inválido ou já expirou. Peça um novo link.');

async function validateResetToken(req, res) {
  await consume(limits.resetByIp, clientIp(req));
  const body = await readBody(req);
  const token = typeof body.token === 'string' ? body.token : '';
  const { rows } = await query(VALID_RESET_TOKEN_SQL, [hashToken(token)]);
  sendJson(res, 200, { valid: rows.length > 0 });
}

async function resetPassword(req, res) {
  await consume(limits.resetByIp, clientIp(req));

  const body = await readBody(req);
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) throw invalidResetLink();

  const problem = passwordProblem(body.password);
  if (problem) throw new HttpError(400, 'weak_password', problem);
  const senhaHash = await passwordHash(body.password);

  // FOR UPDATE impede que duas requisicoes simultaneas usem o mesmo link.
  const { usuario_id: usuarioId, email } = await withTransaction(async db => {
    const { rows } = await db.query(`${VALID_RESET_TOKEN_SQL} FOR UPDATE OF r`, [hashToken(token)]);
    const reset = rows[0];
    if (!reset) throw invalidResetLink();

    await db.query('UPDATE usuario SET senha_hash = $1, atualizado_em = now() WHERE id = $2', [senhaHash, reset.usuario_id]);
    await db.query('UPDATE redefinicao_senha SET utilizado = TRUE WHERE usuario_id = $1', [reset.usuario_id]);
    await db.query('UPDATE sessao SET revogado_em = now() WHERE usuario_id = $1 AND revogado_em IS NULL', [reset.usuario_id]);
    return reset;
  });

  // O bloqueio por e-mail (tentativas de muitos IPs) tambem bloqueia a dona da conta; quem
  // recebeu o link provou ser ela, entao a redefinicao libera esse bloqueio.
  await limits.loginFailuresByEmail.reset(email);

  log('password_reset', `id=${usuarioId}`);
  sendJson(res, 200, { ok: true, message: 'Senha alterada. Entre com a nova senha.' });
}

// As perguntas e respostas de contas antigas continuam no banco, mas nenhuma rota as usa.
function securityQuestionRetired() {
  throw new HttpError(
    410,
    'security_question_retired',
    'A recuperação por pergunta de segurança foi desativada. Use "Esqueci minha senha" para receber o link por e-mail.'
  );
}

const ROUTES = {
  'POST /api/auth/register': register,
  'POST /api/auth/login': login,
  'POST /api/auth/logout': logout,
  'POST /api/auth/forgot-password': forgotPassword,
  'POST /api/auth/reset-password': resetPassword,
  'POST /api/auth/reset-password/validate': validateResetToken,
  'POST /api/auth/answer-question': securityQuestionRetired
};

async function handleAuthRoutes(req, res, pathname) {
  const handler = ROUTES[`${req.method} ${pathname}`];
  if (!handler) return false;
  await handler(req, res);
  return true;
}

module.exports = { handleAuthRoutes };
