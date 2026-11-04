const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { FRONTEND_DIR, MIME_TYPES } = require('./config');

const gzip = promisify(zlib.gzip);

const ROOT = path.resolve(FRONTEND_DIR) + path.sep;
const COMPRESSIBLE = ['.html', '.js', '.css', '.json', '.svg', '.map'];
const GZIP_MIN_BYTES = 1024;
const NOT_FOUND_PAGE = '<h1>404</h1><p>Arquivo não encontrado. <a href="/index.html">Voltar ao início</a></p>';

const fileCache = new Map();

function sendPlain(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// Leitura e compressao assincronas: o primeiro acesso a um arquivo grande (ex.: Chart.js)
// nao trava as outras requisicoes. Depois disso o arquivo sai do cache.
async function loadFile(filePath, stat) {
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

  const extension = path.extname(filePath).toLowerCase();
  const raw = await fs.promises.readFile(filePath);
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    raw,
    gzip: COMPRESSIBLE.includes(extension) && raw.length >= GZIP_MIN_BYTES ? await gzip(raw, { level: 9 }) : null,
    etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    contentType: MIME_TYPES[extension] || 'application/octet-stream'
  };
  fileCache.set(filePath, entry);
  return entry;
}

function cacheControlFor(relativePath) {
  return relativePath.startsWith('/vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendPlain(res, 405, '<h1>405</h1><p>Método não permitido.</p>', { Allow: 'GET, HEAD' });
  }

  const relativePath = pathname === '/' ? '/index.html' : pathname;
  // Byte nulo no caminho faz o fs lancar excecao e derrubaria o processo.
  if (relativePath.includes('\0') || relativePath.includes('\\')) return sendPlain(res, 404, NOT_FOUND_PAGE);

  const filePath = path.resolve(FRONTEND_DIR, `.${relativePath}`);
  if (!filePath.startsWith(ROOT)) return sendPlain(res, 403, '<h1>403</h1><p>Acesso negado.</p>');

  fs.stat(filePath, async (error, stat) => {
    if (error || !stat.isFile()) return sendPlain(res, 404, NOT_FOUND_PAGE);

    let file;
    try {
      file = await loadFile(filePath, stat);
    } catch (_error) {
      return sendPlain(res, 404, NOT_FOUND_PAGE);
    }
    if (res.destroyed) return undefined;

    const headers = {
      'Content-Type': file.contentType,
      'Cache-Control': cacheControlFor(relativePath),
      ETag: file.etag,
      Vary: 'Accept-Encoding'
    };

    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    const useGzip = file.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const body = useGzip ? file.gzip : file.raw;
    if (useGzip) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = body.length;

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

module.exports = { serveStatic };
