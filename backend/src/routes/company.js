const { query } = require('../lib/db');
const { sendJson, readBody } = require('../lib/http-helpers');
const { requireUser } = require('../lib/auth-middleware');
const {
  invalid, requiredText, optionalText, optionalEmail, stateCode, optionalBoolean
} = require('../lib/validation');

function mapEmpresa(row) {
  if (!row) return null;
  return {
    name: row.razao_social || '',
    trade: row.nome_fantasia || '',
    doc: row.cnpj || '',
    segment: row.segmento || '',
    phone: row.telefone || '',
    email: row.email || '',
    address: row.endereco || '',
    city: row.cidade || '',
    state: row.estado || '',
    cep: row.cep || '',
    logo: row.logotipo_url || '',
    timezone: row.fuso_horario || 'America/Sao_Paulo'
  };
}

function logoUrl(value) {
  const url = optionalText(value, 'o endereço do logotipo', 300);
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw invalid('O logotipo precisa ser um endereço http(s).');
  return url;
}

function timezone(value) {
  const zone = requiredText(value, 'o fuso horário', 50);
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(zone)) throw invalid('Informe um fuso horário válido (ex.: America/Sao_Paulo).');
  return zone;
}

// Texto vazio vira NULL: o CNPJ e UNIQUE e duas empresas com '' colidiriam.
const EMPRESA_FIELDS = {
  name: ['razao_social', value => requiredText(value, 'o nome da empresa', 150)],
  trade: ['nome_fantasia', value => optionalText(value, 'o nome fantasia', 150)],
  doc: ['cnpj', value => optionalText(value, 'o CNPJ', 18)],
  segment: ['segmento', value => optionalText(value, 'o segmento', 100)],
  phone: ['telefone', value => optionalText(value, 'o telefone', 20)],
  email: ['email', value => optionalEmail(value, 'e-mail da empresa')],
  address: ['endereco', value => optionalText(value, 'o endereço', 200)],
  city: ['cidade', value => optionalText(value, 'a cidade', 100)],
  state: ['estado', stateCode],
  cep: ['cep', value => optionalText(value, 'o CEP', 9)],
  logo: ['logotipo_url', logoUrl],
  timezone: ['fuso_horario', timezone]
};

async function getCompany(empresaId) {
  const { rows } = await query('SELECT * FROM empresa WHERE id = $1', [empresaId]);
  return mapEmpresa(rows[0]);
}

async function updateCompany(empresaId, body) {
  const setClauses = [];
  const values = [];

  Object.entries(EMPRESA_FIELDS).forEach(([frontendKey, [column, clean]]) => {
    if (body[frontendKey] === undefined) return;
    values.push(clean(body[frontendKey]));
    setClauses.push(`${column} = $${values.length}`);
  });
  if (!setClauses.length) return;

  values.push(empresaId);
  await query(
    `UPDATE empresa SET ${setClauses.join(', ')}, atualizado_em = now() WHERE id = $${values.length}`,
    values
  );
}

async function handleCompanyRoute(req, res, pathname) {
  if (pathname !== '/api/company') return false;
  if (!['GET', 'POST', 'PUT'].includes(req.method)) return false;

  const user = await requireUser(req);
  if (req.method === 'GET') {
    sendJson(res, 200, { company: await getCompany(user.empresa_id) });
    return true;
  }

  await updateCompany(user.empresa_id, await readBody(req));
  sendJson(res, 200, { ok: true, company: await getCompany(user.empresa_id) });
  return true;
}

async function getModules(empresaId) {
  const { rows } = await query(
    `SELECT m.chave, em.ativo
       FROM modulo_sistema m
       LEFT JOIN empresa_modulo em ON em.modulo_id = m.id AND em.empresa_id = $1`,
    [empresaId]
  );
  const modules = {};
  rows.forEach(row => { modules[row.chave] = row.ativo !== false; });
  return modules;
}

async function updateModules(empresaId, body) {
  const entries = Object.entries(body).filter(([, value]) => typeof value === 'boolean');
  if (!entries.length) return;

  await query(
    `INSERT INTO empresa_modulo (empresa_id, modulo_id, ativo)
     SELECT $1, m.id, enviado.ativo
       FROM unnest($2::text[], $3::boolean[]) AS enviado(chave, ativo)
       JOIN modulo_sistema m ON m.chave = enviado.chave
     ON CONFLICT (empresa_id, modulo_id) DO UPDATE SET ativo = EXCLUDED.ativo, atualizado_em = now()`,
    [empresaId, entries.map(([chave]) => chave), entries.map(([, ativo]) => ativo)]
  );
}

async function handleModulesRoute(req, res, pathname) {
  if (pathname !== '/api/modulos') return false;
  if (!['GET', 'POST', 'PUT'].includes(req.method)) return false;

  const user = await requireUser(req);
  if (req.method !== 'GET') await updateModules(user.empresa_id, await readBody(req));
  sendJson(res, 200, await getModules(user.empresa_id));
  return true;
}

async function getSettings(empresaId) {
  const { rows } = await query('SELECT * FROM configuracao_empresa WHERE empresa_id = $1', [empresaId]);
  const settings = rows[0];
  return {
    moeda: settings?.moeda || 'BRL',
    tema: settings?.tema || 'claro',
    notifications: {
      accounts: settings?.notificar_contas ?? true,
      events: settings?.notificar_eventos ?? true
    }
  };
}

async function updateSettings(empresaId, body) {
  const notifications = body.notifications && typeof body.notifications === 'object' ? body.notifications : {};
  const moeda = optionalText(body.moeda, 'a moeda', 3);
  const tema = optionalText(body.tema, 'o tema', 20);
  const notifyAccounts = optionalBoolean(notifications.accounts, 'alerta de contas');
  const notifyEvents = optionalBoolean(notifications.events, 'alerta de eventos');

  await query(
    `INSERT INTO configuracao_empresa (empresa_id, moeda, tema, notificar_contas, notificar_eventos)
     VALUES ($1, COALESCE($2, 'BRL'), COALESCE($3, 'claro'), COALESCE($4, TRUE), COALESCE($5, TRUE))
     ON CONFLICT (empresa_id) DO UPDATE SET
       moeda = COALESCE($2, configuracao_empresa.moeda),
       tema = COALESCE($3, configuracao_empresa.tema),
       notificar_contas = COALESCE($4, configuracao_empresa.notificar_contas),
       notificar_eventos = COALESCE($5, configuracao_empresa.notificar_eventos),
       atualizado_em = now()`,
    [empresaId, moeda, tema, notifyAccounts, notifyEvents]
  );
}

async function handleSettingsRoute(req, res, pathname) {
  if (pathname !== '/api/configuracoes') return false;
  if (!['GET', 'POST', 'PUT'].includes(req.method)) return false;

  const user = await requireUser(req);
  if (req.method !== 'GET') await updateSettings(user.empresa_id, await readBody(req));
  sendJson(res, 200, await getSettings(user.empresa_id));
  return true;
}

module.exports = {
  handleCompanyRoute,
  handleModulesRoute,
  handleSettingsRoute,
  getCompany,
  getModules,
  getSettings
};
