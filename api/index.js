const { applySecurityHeaders, applyCors, resolvePathname } = require('../backend/src/server');
const { handleApi } = require('../backend/src/routes');
const { sendJson } = require('../backend/src/lib/http-helpers');
const { csrfRejected } = require('../backend/src/lib/session-cookie');
const { logError } = require('../backend/src/lib/logger');

module.exports = async function handler(req, res) {
  try {
    applySecurityHeaders(req, res);

    let pathname = resolvePathname(req);
    if (pathname === null) {
      return sendJson(res, 400, { error: 'invalid_request', message: 'Endereço inválido.' });
    }

    // Se o runtime da Vercel entregar sem o prefixo /api, garante o prefixo correto
    if (!pathname.startsWith('/api') && pathname !== '/health') {
      pathname = `/api${pathname.startsWith('/') ? '' : '/'}${pathname}`;
    }

    applyCors(req, res);
    res.acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));

    if (csrfRejected(req)) {
      return sendJson(res, 403, {
        error: 'csrf_rejected',
        message: 'Requisição bloqueada por segurança. Recarregue a página e tente de novo.'
      });
    }

    return await handleApi(req, res, pathname);
  } catch (error) {
    logError('erro na rota api serverless', error);
    return sendJson(res, 500, { error: 'internal_error', message: 'Ocorreu um erro interno. Tente novamente.' });
  }
};
