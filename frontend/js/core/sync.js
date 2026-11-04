// /api/sync traz a primeira pagina de transacoes e de movimentacoes de estoque; as seguintes
// sao pedidas pelo cursor. Os totais vem prontos em state.summary.
const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 500;

function pageQuery(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  return search.toString();
}

const FLUXY_SYNC = {
  transactionFilters: { q: '', tipo: 'all' },
  // Cada busca invalida respostas pendentes: uma resposta lenta nao sobrescreve a lista certa.
  transactionRequest: 0,

  async loadAll() {
    if (FLUXY_API.localOnly) return 'skipped';

    let data;
    try {
      data = await FLUXY_API.get('/api/sync');
    } catch (error) {
      if (error.code === 'API_401') return 'skipped';
      console.warn('[Fluxy] sincronizacao falhou:', error.message);
      state.offline = true;
      return 'offline';
    }

    state.clients = data.clients;
    state.suppliers = data.suppliers;
    state.products = data.products;
    state.stockHistory = data.stockHistory;
    state.transactions = data.transactions;
    state.accounts = data.accounts;
    state.services = data.services;
    state.events = data.events;
    state.summary = data.summary;
    state.pagination = data.pagination;
    this.transactionFilters = { q: '', tipo: 'all' };
    state.modules = { ...MODULES_DEFAULT, ...data.modules };
    if (data.company) state.company = { ...state.company, ...data.company };
    if (data.settings?.notifications) state.notifications = data.settings.notifications;
    if (data.profile) {
      state.profile = { ...state.profile, ...data.profile, logins: data.logins || [] };
      state.user = { ...state.user, name: data.profile.name, email: data.profile.email, phone: data.profile.phone };
      set('fp_user', state.user);
    }

    state.offline = false;
    persist();
    return 'synced';
  },

  // false quando a resposta chegou atrasada e foi descartada.
  async searchTransactions(filters) {
    this.transactionFilters = { ...this.transactionFilters, ...filters };
    const request = ++this.transactionRequest;
    const page = await FLUXY_API.get(`/api/transacoes?${pageQuery({ limit: PAGE_SIZE, ...this.transactionFilters })}`);
    if (request !== this.transactionRequest) return false;
    state.transactions = page.items;
    state.pagination.transactions.nextCursor = page.nextCursor;
    persist();
    return true;
  },

  async loadMoreTransactions() {
    const cursor = state.pagination.transactions.nextCursor;
    if (!cursor) return false;
    const request = this.transactionRequest;
    const page = await FLUXY_API.get(`/api/transacoes?${pageQuery({ limit: PAGE_SIZE, cursor, ...this.transactionFilters })}`);
    if (request !== this.transactionRequest) return false;
    const known = new Set(state.transactions.map(item => item.id));
    state.transactions.push(...page.items.filter(item => !known.has(item.id)));
    state.pagination.transactions.nextCursor = page.nextCursor;
    persist();
    return true;
  },

  async loadMoreStock() {
    const cursor = state.pagination.stockHistory.nextCursor;
    if (!cursor) return;
    const page = await FLUXY_API.get(`/api/movimentacoes-estoque?${pageQuery({ limit: PAGE_SIZE, cursor })}`);
    const known = new Set(state.stockHistory.map(item => item.id));
    state.stockHistory.push(...page.items.filter(item => !known.has(item.id)));
    state.pagination.stockHistory.nextCursor = page.nextCursor;
    persist();
  },

  async refreshStock() {
    try {
      const page = await FLUXY_API.get(`/api/movimentacoes-estoque?${pageQuery({ limit: PAGE_SIZE })}`);
      state.stockHistory = page.items;
      state.pagination.stockHistory.nextCursor = page.nextCursor;
      persist();
    } catch (_error) {
      // mantem a lista atual; a proxima sincronizacao corrige
    }
  },

  async refreshSummary() {
    try {
      state.summary = await FLUXY_API.get('/api/resumo');
      persist();
    } catch (_error) {
      // mantem o resumo atual; a proxima sincronizacao corrige
    }
  },

  // Usado so nas exportacoes (CSV e backup), que precisam de todos os registros.
  async fetchAllPages(path) {
    const items = [];
    let cursor = null;
    do {
      const page = await FLUXY_API.get(`${path}?${pageQuery({ limit: EXPORT_PAGE_SIZE, cursor })}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }
};
window.FLUXY_SYNC = FLUXY_SYNC;
