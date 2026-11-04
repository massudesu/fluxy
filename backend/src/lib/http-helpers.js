const zlib = require('zlib');
const { TRUST_PROXY } = require('../config');

const MAX_BODY_BYTES = 100 * 1024;
const GZIP_MIN_BYTES = 1024;

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

function writeBody(res, status, headers, body) {
  if (res.destroyed) return;
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

// gzip assincrono; res.responding impede uma segunda resposta enquanto a compressao nao termina.
function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.responding) return;
  res.responding = true;

  if (status === 204) {
    res.writeHead(204, { 'Cache-Control': 'no-store', ...extraHeaders });
    res.end();
    return;
  }

  const body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  };

  if (!res.acceptsGzip || body.length < GZIP_MIN_BYTES) {
    writeBody(res, status, headers, body);
    return;
  }

  // writeHead substituiria o "Vary: Origin" gravado pelo CORS.
  const vary = [res.getHeader('Vary'), headers.Vary, 'Accept-Encoding'].filter(Boolean).join(', ');
  headers.Vary = vary;
  zlib.gzip(body, (error, compressed) => {
    if (error) return writeBody(res, status, headers, body);
    headers['Content-Encoding'] = 'gzip';
    return writeBody(res, status, headers, compressed);
  });
}

function sendError(res, error) {
  const extraHeaders = error.extra?.retryAfter ? { 'Retry-After': String(error.extra.retryAfter) } : {};
  sendJson(res, error.status, { error: error.code, message: error.message }, extraHeaders);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    const interrupted = () => {
      if (rejected || req.complete) return;
      rejected = true;
      reject(new HttpError(400, 'invalid_request', 'Não foi possível ler os dados enviados.'));
    };

    if (req.destroyed && !req.complete) return interrupted();
    req.on('close', interrupted);

    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new HttpError(413, 'payload_too_large', 'Os dados enviados são grandes demais.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch (_error) {
        reject(new HttpError(400, 'invalid_json', 'Os dados enviados estão em formato inválido.'));
      }
    });

    req.on('error', () => {
      if (!rejected) reject(new HttpError(400, 'invalid_request', 'Não foi possível ler os dados enviados.'));
    });
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    // O ultimo item e o que o proxy confiavel acrescentou; os anteriores vem do visitante.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'desconhecido';
}

module.exports = { HttpError, sendJson, sendError, readBody, clientIp };
