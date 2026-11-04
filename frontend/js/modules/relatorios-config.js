function report() {
  const { totals, expensesByCategory } = financialSummary();

  $('#report-result').textContent = moneyFromCents(totals.incomeCents - totals.expenseCents);
  $('#report-ticket').textContent = moneyFromCents(totals.incomeCount ? Math.round(totals.incomeCents / totals.incomeCount) : 0);

  const maxCategoryCents = Math.max(...expensesByCategory.map(item => item.cents), 1);

  $('#category-report').innerHTML = expensesByCategory
    .map(({ category, cents }) => `
      <div class="category-row">
        <span>${esc(category)}</span>
        <div class="bar"><i></i></div>
        <strong>${moneyFromCents(cents)}</strong>
      </div>
    `).join('') || '<p class="muted">Registre saídas para visualizar categorias.</p>';

  $$('#category-report .bar i').forEach((bar, index) => {
    bar.style.width = `${(expensesByCategory[index].cents / maxCategoryCents) * 100}%`;
  });
}

// O apostrofo impede o Excel de executar como formula um texto que comece com = + - ou @.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function allTransactions() {
  return hasApi() ? FLUXY_SYNC.fetchAllPages('/api/transacoes') : state.transactions;
}

async function exportTransactionsCsv() {
  let transactions;
  try {
    transactions = await allTransactions();
  } catch (error) {
    toast(apiErrorMessage(error, 'Não foi possível gerar o relatório.'), 'error');
    return;
  }

  const header = ['Data', 'Descrição', 'Categoria', 'Cliente', 'Tipo', 'Valor'].join(';');
  const lines = transactions.map(t => {
    const cents = toCents(t.valor);
    return [
      csvCell(date(t.data)),
      csvCell(t.descricao),
      csvCell(t.categoria || ''),
      csvCell(t.cliente || ''),
      csvCell(t.tipo === 'entrada' ? 'Entrada' : 'Saída'),
      `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`
    ].join(';');
  });

  downloadFile('relatorio-fluxy.csv', '\ufeff' + [header, ...lines].join('\r\n'), 'text/csv;charset=utf-8');
}

const SETTINGS_MODULE_LABELS = {
  financeiro: 'Movimentações',
  contas: 'Contas a pagar e receber',
  estoque: 'Estoque',
  clientes: 'Clientes',
  fornecedores: 'Fornecedores',
  servicos: 'Serviços',
  agenda: 'Agenda de serviços',
  calendario: 'Calendário',
  relatorios: 'Relatórios'
};

function renderSettings() {
  $('#module-toggles').innerHTML = Object.entries(SETTINGS_MODULE_LABELS).map(([key, label]) => `
    <label class="toggle-row">
      <span><b>${label}</b><small>Exibir este módulo no menu e no sistema.</small></span>
      <input data-module-toggle="${key}" type="checkbox" ${state.modules[key] !== false ? 'checked' : ''}>
      <i></i>
    </label>
  `).join('');

  $('#company-name').value = state.company.name || '';
  $('#company-doc').value = state.company.doc || '';
  $('#company-phone').value = state.company.phone || '';
  $('#company-timezone').value = state.company.timezone || 'America/Sao_Paulo';
  $('#notify-accounts').checked = state.notifications.accounts !== false;
  $('#notify-events').checked = state.notifications.events !== false;
}

function lastLoginText(logins) {
  const last = (logins || []).find(login => login.success !== false);
  if (!last) return 'Nenhum acesso registrado.';
  const when = new Date(last.date);
  return `Último acesso: ${when.toLocaleDateString('pt-BR')} às ${when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${last.device}`;
}

function renderProfile() {
  const profile = state.profile;
  $('#profile-name').value = profile.name || '';
  $('#profile-email').value = profile.email || '';
  $('#profile-phone').value = profile.phone || '';
  $('#profile-created').value = profile.created ? new Date(profile.created).toLocaleDateString('pt-BR') : '';
  $('#profile-name-card').textContent = profile.name || 'Seu perfil';
  $('#profile-email-card').textContent = profile.email || '';
  $('#profile-avatar').textContent = initials(profile.name);
  $('#login-history').textContent = lastLoginText(profile.logins);
}
