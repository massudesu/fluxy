const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const pad2 = number => String(number).padStart(2, '0');

// Data no fuso do usuario; toISOString() usa UTC e "vira o dia" as 21h no Brasil.
const toISODate = value => `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
const todayISO = () => toISODate(new Date());

const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);

// Somas de dinheiro em centavos inteiros (0.1 + 0.2 em Number nao da 0.3). Com no maximo duas
// casas por valor, arredondar valor * 100 recupera o centavo exato.
const toCents = value => Math.round((Number(value) || 0) * 100);
const sumCents = (list, pick) => list.reduce((total, item) => total + toCents(pick(item)), 0);
const moneyFromCents = cents => money((Number(cents) || 0) / 100);

const date = value => (value ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '');

const uid = () => Date.now() + Math.floor(Math.random() * 999);

const initials = name => String(name || '').trim().split(/\s+/).map(part => part[0] || '').join('').slice(0, 2).toUpperCase() || 'FX';

function esc(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
}

// Sessao sem "manter conectado" vive so nesta aba; a copia dos dados acompanha a marca da sessao.
const accountStorage = () => (sessionStorage.getItem(SESSION_HINT_KEY) ? sessionStorage : localStorage);

function get(key, fallback, storage = accountStorage()) {
  try {
    return JSON.parse(storage.getItem(key)) ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

function set(key, value, storage = accountStorage()) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (_error) {
    console.warn('[Fluxy] sem espaço no navegador para guardar', key);
  }
}

const MODULES_DEFAULT = {
  dashboard: true,
  financeiro: true,
  contas: true,
  estoque: true,
  clientes: true,
  fornecedores: true,
  servicos: true,
  agenda: true,
  calendario: true,
  relatorios: true
};

const PROFILE_DEFAULT = { name: '', email: '', phone: '', created: '', logins: [] };

const COMPANY_DEFAULT = {
  name: 'Minha empresa',
  trade: '',
  doc: '',
  segment: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  state: '',
  cep: '',
  logo: '',
  timezone: 'America/Sao_Paulo'
};

const DATA_KEYS = {
  suppliers: 'fp_suppliers',
  transactions: 'fp_transactions',
  accounts: 'fp_accounts',
  clients: 'fp_clients',
  services: 'fp_services',
  events: 'fp_events',
  products: 'fp_products',
  stockHistory: 'fp_stock_history'
};

function withNumericValor(list) {
  return list.map(item => ({ ...item, valor: Number(item.valor) || 0 }));
}

// Mesmo formato de /api/resumo, para o modo local (onde todas as transacoes estao no navegador).
function summarizeTransactions(transactions) {
  const monthly = {};
  const categories = {};
  const customers = {};
  const totals = { incomeCents: 0, expenseCents: 0, incomeCount: 0, transactionCount: transactions.length };

  transactions.forEach(transaction => {
    const cents = toCents(transaction.valor);
    const month = String(transaction.data).slice(0, 7);
    const entry = monthly[month] || (monthly[month] = { month, incomeCents: 0, expenseCents: 0 });
    if (transaction.tipo === 'entrada') {
      entry.incomeCents += cents;
      totals.incomeCents += cents;
      totals.incomeCount += 1;
      if (transaction.cliente) customers[transaction.cliente] = (customers[transaction.cliente] || 0) + cents;
    } else {
      entry.expenseCents += cents;
      totals.expenseCents += cents;
      const category = transaction.categoria || 'Geral';
      categories[category] = (categories[category] || 0) + cents;
    }
  });

  return {
    monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)),
    totals,
    expensesByCategory: Object.entries(categories)
      .map(([category, cents]) => ({ category, cents }))
      .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category)),
    incomeByCustomer: Object.entries(customers).map(([customer, cents]) => ({ customer, cents }))
  };
}

const PAGINATION_DEFAULT = { transactions: { nextCursor: null }, stockHistory: { nextCursor: null } };

const state = {
  user: get('fp_user', null),
  transactions: withNumericValor(get('fp_transactions', get('gs_transacoes', []))),
  accounts: withNumericValor(get('fp_accounts', get('gs_contas', []))),
  clients: get('fp_clients', get('gs_clientes', [])),
  services: withNumericValor(get('fp_services', get('gs_servicos', []))),
  events: get('fp_events', []),
  modules: { ...MODULES_DEFAULT, ...get('fp_modules', {}) },
  profile: { ...PROFILE_DEFAULT, ...get('fp_profile', {}) },
  company: { ...COMPANY_DEFAULT, ...get('fp_company', {}) },
  suppliers: get('fp_suppliers', []),
  products: get('fp_products', []),
  stockHistory: get('fp_stock_history', []),
  notifications: get('fp_notifications', { accounts: true, events: true }),
  summary: get('fp_summary', null),
  pagination: { ...PAGINATION_DEFAULT, ...get('fp_pagination', {}) },
  calendarDate: new Date(),
  offline: false
};

function financialSummary() {
  return !FLUXY_API.localOnly && state.summary ? state.summary : summarizeTransactions(state.transactions);
}

function persist() {
  Object.entries(DATA_KEYS).forEach(([collection, key]) => set(key, state[collection]));
  set('fp_summary', state.summary);
  set('fp_pagination', state.pagination);
  set('fp_modules', state.modules);
  set('fp_profile', state.profile);
  set('fp_company', state.company);
  set('fp_notifications', state.notifications);
}

function clearAccountData() {
  const keys = [
    ...Object.values(DATA_KEYS),
    'gs_transacoes', 'gs_contas', 'gs_clientes', 'gs_servicos', 'fp_modules', 'fp_profile', 'fp_company', 'fp_notifications', 'fp_user',
    'fp_summary', 'fp_pagination'
  ];
  keys.forEach(key => {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  });
  Object.keys(DATA_KEYS).forEach(collection => { state[collection] = []; });

  state.user = null;
  state.modules = { ...MODULES_DEFAULT };
  state.profile = { ...PROFILE_DEFAULT };
  state.company = { ...COMPANY_DEFAULT };
  state.notifications = { accounts: true, events: true };
  state.summary = null;
  state.pagination = { ...PAGINATION_DEFAULT };
  state.offline = false;
}

let toastTimer = null;

function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', kind === 'error');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3200);
}

async function withBusyButton(button, busyText, task) {
  if (!button) return task();
  if (button.disabled) return undefined;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

function downloadFile(filename, content, type) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportJSON(filename, data) {
  downloadFile(filename, JSON.stringify(data, null, 2), 'application/json');
}
