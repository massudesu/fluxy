// Com servidor, busca, filtro e paginacao rodam no backend; no modo local a paginacao e so visual.
const TRANSACTIONS_PAGE_SIZE = 100;
const SEARCH_DELAY_MS = 300;
let transactionsShown = TRANSACTIONS_PAGE_SIZE;
let searchTimer = null;

function removeButton(kind, id) {
  return `<button class="table-action" data-action="remove" data-kind="${kind}" data-id="${Number(id)}" aria-label="Remover" title="Remover"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`;
}

function transactionFilterValues() {
  return {
    q: ($('#transaction-search')?.value || '').trim(),
    tipo: $('#transaction-filter')?.value || 'all'
  };
}

// Mesma regra da busca do servidor: descricao + categoria, sem diferenciar maiusculas.
function transactionMatches(transaction, { q, tipo }) {
  const text = `${transaction.descricao} ${transaction.categoria || ''}`.toLowerCase();
  return (tipo === 'all' || transaction.tipo === tipo) && text.includes(q.toLowerCase());
}

const newestFirst = (a, b) => String(b.data).localeCompare(String(a.data)) || b.id - a.id;

function renderTransactions() {
  const filters = transactionFilterValues();
  let visible = state.transactions;
  let hasMore = Boolean(state.pagination.transactions.nextCursor);
  let remaining = 0;
  if (!hasApi()) {
    const rows = state.transactions.filter(t => transactionMatches(t, filters)).sort(newestFirst);
    visible = rows.slice(0, transactionsShown);
    remaining = rows.length - visible.length;
    hasMore = remaining > 0;
  }
  const filtering = Boolean(filters.q) || filters.tipo !== 'all';
  const emptyMessage = filtering || (!hasApi() && state.transactions.length)
    ? 'Nenhuma movimentação encontrada com esse filtro.'
    : 'Nenhuma movimentação cadastrada.';

  $('#transactions-table').innerHTML = visible.length
    ? visible.map(t => `
      <tr>
        <td>${date(t.data)}</td>
        <td><strong>${esc(t.descricao)}</strong></td>
        <td>${esc(t.categoria || 'Geral')}</td>
        <td><span class="type-pill ${t.tipo === 'entrada' ? 'in' : 'out'}">${t.tipo === 'entrada' ? 'Entrada' : 'Saída'}</span></td>
        <td><strong class="${t.tipo === 'entrada' ? 'positive' : 'negative'}">${t.tipo === 'entrada' ? '+' : '-'} ${money(t.valor)}</strong></td>
        <td>${removeButton('transaction', t.id)}</td>
      </tr>
    `).join('')
    : `<tr><td colspan="6" class="muted">${emptyMessage}</td></tr>`;

  const moreButton = $('#transactions-more');
  moreButton.classList.toggle('hidden', !hasMore);
  moreButton.textContent = remaining ? `Mostrar mais (${remaining} restantes)` : 'Mostrar mais';
}

async function showMoreTransactions(event) {
  if (!hasApi()) {
    transactionsShown += TRANSACTIONS_PAGE_SIZE;
    renderTransactions();
    return;
  }
  if (blockedByOffline()) return;
  await withBusyButton(event?.currentTarget, 'Carregando...', async () => {
    try {
      if (await FLUXY_SYNC.loadMoreTransactions()) renderTransactions();
    } catch (error) {
      toast(apiErrorMessage(error, 'Não foi possível carregar mais movimentações.'), 'error');
    }
  });
}

async function searchTransactionsOnServer() {
  try {
    if (await FLUXY_SYNC.searchTransactions(transactionFilterValues())) renderTransactions();
  } catch (error) {
    toast(apiErrorMessage(error, 'Não foi possível buscar as movimentações.'), 'error');
  }
}

function resetTransactionsPage(event) {
  transactionsShown = TRANSACTIONS_PAGE_SIZE;
  if (!hasApi()) {
    renderTransactions();
    return;
  }
  clearTimeout(searchTimer);
  if (event?.type === 'input') searchTimer = setTimeout(searchTransactionsOnServer, SEARCH_DELAY_MS);
  else searchTransactionsOnServer();
}

// Lancamento mais antigo que a ultima linha carregada aparece pelo "Mostrar mais".
function placeNewTransaction(created) {
  if (!transactionMatches(created, transactionFilterValues())) return;
  const last = state.transactions[state.transactions.length - 1];
  if (state.pagination.transactions.nextCursor && last && newestFirst(created, last) > 0) return;
  state.transactions.push(created);
  state.transactions.sort(newestFirst);
}

function renderAccounts() {
  const accounts = [...state.accounts].sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));

  $('#accounts-grid').innerHTML = accounts.length
    ? accounts.map(account => `
      <article class="account-card">
        <div class="account-top">
          <span class="type-pill ${account.tipo === 'pagar' ? 'out' : 'in'}">${account.tipo === 'pagar' ? 'A pagar' : 'A receber'}</span>
          ${removeButton('account', account.id)}
        </div>
        <h3>${esc(account.descricao)}</h3>
        <strong>${money(account.valor)}</strong>
        <div class="account-footer">
          <small><i class="fa-regular fa-calendar"></i> ${date(account.vencimento)}</small>
          <span class="status-pill ${account.status === 'pago' ? 'paid' : 'pending'}">${account.status === 'pago' ? 'Pago' : 'Pendente'}</span>
        </div>
        <button class="text-btn" data-action="toggle-account" data-id="${Number(account.id)}">${account.status === 'pago' ? 'Marcar pendente' : 'Marcar como pago'}</button>
      </article>
    `).join('')
    : '<p class="muted">Nenhuma conta cadastrada.</p>';
}
