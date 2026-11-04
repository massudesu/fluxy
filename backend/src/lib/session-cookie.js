const { APP_URL, COOKIE_SECURE, COOKIE_SAME_SITE, CORS_ORIGINS, TRUST_PROXY } = require('../config');

// Cookie HttpOnly: um script injetado na pagina (XSS) nao consegue ler o token.
const SESSION_COOKIE = 'fluxy_session';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

// Protecao contra CSRF: formularios de outros sites nao enviam cabecalhos proprios, e scripts
// de outro dominio so conseguem se o CORS permitir.
const CSRF_HEADER = 'x-fluxy-request';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach(part => {
    const separator = part.indexOf('=');
    if (separator === -1) return;
    const name = part.slice(0, separator).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(separator + 1).trim();
  });
  return cookies;
}

function sessionToken(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  return TOKEN_PATTERN.test(token) ? token : '';
}

function cookieAttributes() {
  return ['Path=/', 'HttpOnly', `SameSite=${COOKIE_SAME_SITE}`, ...(COOKIE_SECURE ? ['Secure'] : [])];
}

// maxAgeMs 0 = cookie de sessao do navegador. A validade que vale e sempre a do banco.
function sessionCookie(token, maxAgeMs) {
  const attributes = cookieAttributes();
  if (maxAgeMs) attributes.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return [`${SESSION_COOKIE}=${token}`, ...attributes].join('; ');
}

function clearedSessionCookie() {
  return [`${SESSION_COOKIE}=`, ...cookieAttributes(), 'Max-Age=0'].join('; ');
}

const PUBLIC_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch (_error) {
    return '';
  }
})();

// "O proprio site": APP_URL, o Host recebido ou, com TRUST_PROXY, o X-Forwarded-Host
// (proxies costumam reescrever o Host para o endereco interno).
function originAllowed(req, origin) {
  if (CORS_ORIGINS.includes(origin) || origin === PUBLIC_ORIGIN) return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (_error) {
    return false;
  }
  const hosts = [req.headers.host];
  if (TRUST_PROXY) hosts.push(String(req.headers['x-forwarded-host'] || '').split(',').pop().trim());
  return hosts.some(host => host && originHost === String(host));
}

function csrfRejected(req) {
  if (!UNSAFE_METHODS.has(req.method)) return false;
  if (req.headers[CSRF_HEADER] !== '1') return true;

  // Sem Origin a chamada nao veio de uma pagina e o cabecalho basta; "null" vem de iframes isolados e file://.
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return false;
  if (origin === 'null') return true;
  return !originAllowed(req, origin);
}

module.exports = {
  SESSION_COOKIE,
  CSRF_HEADER,
  sessionToken,
  sessionCookie,
  clearedSessionCookie,
  csrfRejected
};
