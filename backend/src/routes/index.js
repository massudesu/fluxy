const { query } = require('../lib/db');
const { HttpError, sendJson, sendError } = require('../lib/http-helpers');
const { logError } = require('../lib/logger');
const { handleAuthRoutes } = require('./auth');
const { handleAccountRoutes } = require('./account');
const { handleCompanyRoute, handleModulesRoute, handleSettingsRoute } = require('./company');
const { handleSyncRoute } = require('./sync');
const { handleDataRoutes } = require('./data');

const DUPLICATE_MESSAGES = {
  usuario_email_key: 'Este e-mail já está cadastrado.',
  empresa_cnpj_key: 'Este CNPJ já está cadastrado em outra empresa.',
  produto_empresa_id_codigo_key: 'Já existe um produto com este código.',
  uq_cliente_empresa_nome: 'Já existe um cliente com este nome.',
  uq_fornecedor_empresa_nome: 'Já existe um fornecedor com este nome.'
};

const INVALID_DATA_CODES = ['22001', '22003', '22007', '22008', '22021', '22P02', '23502', '23514'];
const CONNECTION_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', '57P01', '57P03', '53300', '3D000', '28P01'];

function toHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === '23505') {
    return new HttpError(409, 'conflict', DUPLICATE_MESSAGES[error.constraint] || 'Já existe um registro com esses dados.');
  }
  if (error?.code === '23503') return new HttpError(409, 'conflict', 'Este registro está em uso por outro cadastro.');
  if (INVALID_DATA_CODES.includes(error?.code)) {
    return new HttpError(400, 'invalid_request', 'Revise os dados informados: há um valor inválido ou grande demais.');
  }
  if (CONNECTION_CODES.includes(error?.code) || String(error?.code || '').startsWith('08')) {
    logError('banco de dados indisponivel', error);
    return new HttpError(503, 'database_unavailable', 'O banco de dados não está respondendo. Tente novamente em instantes.');
  }
  logError('erro interno', error);
  return new HttpError(500, 'internal_error', 'Ocorreu um erro interno. Tente novamente.');
}

// 503 quando o banco cai: monitores e balanceadores leem o codigo HTTP, nao o corpo.
async function health(res) {
  try {
    await query('SELECT 1');
    sendJson(res, 200, { status: 'ok', database: 'connected' });
  } catch (error) {
    logError('health: banco de dados indisponivel', error);
    sendJson(res, 503, { status: 'degraded', database: 'unavailable' }, { 'Retry-After': '10' });
  }
}

async function route(req, res, pathname) {
  if (req.method === 'OPTIONS') return sendJson(res, 204);
  if (pathname === '/health' || pathname === '/api/health') return health(res);

  if (await handleAuthRoutes(req, res, pathname)) return;
  if (await handleAccountRoutes(req, res, pathname)) return;
  if (await handleSyncRoute(req, res, pathname)) return;
  if (await handleCompanyRoute(req, res, pathname)) return;
  if (await handleModulesRoute(req, res, pathname)) return;
  if (await handleSettingsRoute(req, res, pathname)) return;
  if (await handleDataRoutes(req, res, pathname)) return;

  throw new HttpError(404, 'not_found', 'Rota não encontrada.');
}

async function handleApi(req, res, pathname) {
  try {
    await route(req, res, pathname);
  } catch (error) {
    sendError(res, toHttpError(error));
  }
}

module.exports = { handleApi };
