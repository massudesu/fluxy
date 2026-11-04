(function migrateLegacyStorageKeys() {
  const RENAMED_KEYS = { skina_api_url: 'fluxy_api_url' };

  Object.entries(RENAMED_KEYS).forEach(([oldKey, newKey]) => {
    const oldValue = localStorage.getItem(oldKey);
    if (oldValue !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, oldValue);
    }
    localStorage.removeItem(oldKey);
  });

  // Tokens guardados por versoes anteriores; a sessao agora fica num cookie HttpOnly.
  ['skina_token', 'fluxy_token', 'skina_api_logs', 'fluxy_api_logs'].forEach(key => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  });
})();

function isStaticOnlyHost() {
  if (localStorage.getItem('fluxy_api_url')) return false;
  return /\.github\.io$/i.test(location.hostname);
}

function resolveApiBaseUrl() {
  const saved = localStorage.getItem('fluxy_api_url');
  if (saved) return saved.replace(/\/$/, '');
  if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  return 'http://localhost:8080';
}

const API_TIMEOUT_MS = 20000;

// Marca sem segredo de sessao aberta. Ficar em sessionStorage ou localStorage define onde
// a copia dos dados e guardada ("manter conectado").
const SESSION_HINT_KEY = 'fluxy_session_open';

function apiError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data || null;
  return error;
}

window.FLUXY_API = {
  isFile: location.protocol === 'file:',
  isStaticHost: isStaticOnlyHost(),
  baseUrl: resolveApiBaseUrl(),

  onSessionExpired: null,

  get localOnly() {
    return this.isFile || this.isStaticHost;
  },

  hasSession() {
    return Boolean(sessionStorage.getItem(SESSION_HINT_KEY) || localStorage.getItem(SESSION_HINT_KEY));
  },

  markSession(remember) {
    this.clearSession();
    localStorage.removeItem('fluxy_logout_pending');
    (remember ? localStorage : sessionStorage).setItem(SESSION_HINT_KEY, '1');
  },

  clearSession() {
    sessionStorage.removeItem(SESSION_HINT_KEY);
    localStorage.removeItem(SESSION_HINT_KEY);
  },

  async online() {
    try {
      await this.request('/health', { skipAuth: true });
      return true;
    } catch (_error) {
      return false;
    }
  },

  get(path) {
    return this.request(path);
  },

  send(method, path, payload) {
    return this.request(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
  },

  post(path, payload) {
    return this.send('POST', path, payload);
  },

  // skipAuth: rotas publicas, onde um 401 e resposta normal e nao encerra a sessao da tela.
  async request(path, options = {}) {
    if (this.localOnly) {
      throw apiError('API_UNAVAILABLE', 'Modo local: este endereço não tem servidor.');
    }

    const { skipAuth, ...fetchOptions } = options;
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json', ...(fetchOptions.headers || {}) };
    if (fetchOptions.body !== undefined) headers['Content-Type'] = 'application/json';
    // Protecao contra CSRF exigida pelo servidor.
    if (method !== 'GET' && method !== 'HEAD') headers['X-Fluxy-Request'] = '1';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    let response;
    let rawBody;
    try {
      response = await fetch(this.baseUrl + path, {
        ...fetchOptions,
        method,
        headers,
        // Necessario quando a API esta em outro endereco (CORS_ORIGINS).
        credentials: 'include',
        signal: controller.signal
      });
      rawBody = await response.text();
    } catch (_error) {
      throw apiError('API_UNAVAILABLE', 'Não foi possível conectar ao servidor do Fluxy.');
    } finally {
      clearTimeout(timer);
    }

    let data = {};
    try {
      data = rawBody ? JSON.parse(rawBody) : {};
    } catch (_error) {
      throw apiError('API_UNAVAILABLE', 'O servidor respondeu em um formato inesperado.');
    }

    if (!response.ok) {
      if (response.status === 401 && !skipAuth && this.onSessionExpired) this.onSessionExpired();
      throw apiError(`API_${response.status}`, data.message || `Erro ${response.status}`, data);
    }
    return data;
  }
};

function isConnectionError(error) {
  return error?.code === 'API_UNAVAILABLE' || /^API_5/.test(String(error?.code || ''));
}

function apiErrorMessage(error, fallback) {
  if (error?.code === 'API_UNAVAILABLE') {
    return 'Sem conexão com o servidor. Nada foi salvo. Confira se o Fluxy está em execução e tente de novo.';
  }
  return error?.data?.message || fallback || 'Não foi possível concluir. Tente novamente.';
}
