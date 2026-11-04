function renderAll() {
  renderIdentity();
  renderSuppliers();
  renderDashboard();
  renderTransactions();
  renderStock();
  renderAccounts();
  renderClients();
  renderServices();
  renderAgenda();
  renderCalendar();
  report();
  if (!isTypingIn('configuracoes')) renderSettings();
  if (!isTypingIn('perfil')) renderProfile();
}

function isTypingIn(sectionId) {
  const focused = document.activeElement;
  return Boolean(focused?.matches('input, select, textarea') && focused.closest(`#${sectionId}`));
}

function togglePasswordVisibility(button) {
  const input = $(button.dataset.toggle);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  button.innerHTML = `<i class="fa-regular ${input.type === 'password' ? 'fa-eye' : 'fa-eye-slash'}" aria-hidden="true"></i>`;
}

function activateTab(tab, tabAttribute, panelAttribute) {
  $$(`[${tabAttribute}]`).forEach(other => other.classList.toggle('active', other === tab));
  $$(`[${panelAttribute}]`).forEach(panel => {
    panel.classList.toggle('hidden', panel.getAttribute(panelAttribute) !== tab.getAttribute(tabAttribute));
  });
}

function bindDelegatedClicks() {
  document.addEventListener('click', event => {
    const target = selector => event.target.closest(selector);

    const passwordToggle = target('[data-toggle]');
    if (passwordToggle) return togglePasswordVisibility(passwordToggle);

    const action = target('[data-action]');
    if (action?.dataset.action === 'remove') return removeItem(action.dataset.kind, Number(action.dataset.id));
    if (action?.dataset.action === 'toggle-account') return payAccount(Number(action.dataset.id));

    const sectionLink = target('[data-section]');
    if (sectionLink) {
      event.preventDefault();
      showSection(sectionLink.dataset.section);
    }

    const authLink = target('[data-auth]');
    if (authLink) authView(authLink.dataset.auth);

    const modalLink = target('[data-modal]');
    if (modalLink) openModal(modalLink.dataset.modal, modalLink.dataset.type);

    const settingsTab = target('[data-settings-tab]');
    if (settingsTab) activateTab(settingsTab, 'data-settings-tab', 'data-settings-content');

    const profileTab = target('[data-profile-tab]');
    if (profileTab) activateTab(profileTab, 'data-profile-tab', 'data-profile-content');

    return undefined;
  });
}

function bindForms() {
  $('#login-form').onsubmit = handleLogin;
  $('#register-form').onsubmit = handleRegister;
  $('#forgot-form').onsubmit = handleRecovery;
}

function bindLayoutControls() {
  $('#logout').onclick = logout;
  $('#menu-toggle').onclick = () => $('#sidebar').classList.add('open');
  $('#close-menu').onclick = () => $('#sidebar').classList.remove('open');
  $('#close-modal').onclick = closeModal;
  $('#modal').onclick = event => {
    if (event.target.id === 'modal') closeModal();
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
  });
  $('#transaction-search').oninput = resetTransactionsPage;
  $('#transaction-filter').onchange = resetTransactionsPage;
  $('#transactions-more').onclick = showMoreTransactions;
  $('#stock-history-more').onclick = showMoreStockHistory;
  $('#chart-period').onchange = drawChart;
  $('#retry-connection').onclick = event => withBusyButton(event.currentTarget, 'Conectando...', async () => {
    const result = await syncAndRender();
    toast(result === 'synced' ? 'Conexão restabelecida.' : 'O servidor ainda não respondeu.', result === 'synced' ? 'info' : 'error');
  });
}

async function saveSettings() {
  if (blockedByOffline()) return;

  const modules = { ...state.modules };
  $$('[data-module-toggle]').forEach(toggle => { modules[toggle.dataset.moduleToggle] = toggle.checked; });
  const company = {
    ...state.company,
    name: $('#company-name').value.trim(),
    doc: $('#company-doc').value.trim(),
    phone: $('#company-phone').value.trim(),
    timezone: $('#company-timezone').value
  };
  const notifications = { accounts: $('#notify-accounts').checked, events: $('#notify-events').checked };

  if (!company.name) return toast('Informe o nome da empresa.', 'error');

  if (hasApi()) {
    try {
      const [savedModules, savedCompany, savedSettings] = await Promise.all([
        FLUXY_API.post('/api/modulos', modules),
        FLUXY_API.post('/api/company', company),
        FLUXY_API.post('/api/configuracoes', { notifications })
      ]);
      state.modules = { ...MODULES_DEFAULT, ...savedModules };
      state.company = { ...state.company, ...savedCompany.company };
      state.notifications = savedSettings.notifications;
    } catch (error) {
      // As tres gravacoes sao independentes: uma pode ter entrado e outra nao. Recarrega o que esta no banco.
      toast(apiErrorMessage(error, 'Não foi possível salvar as configurações.'), 'error');
      await syncAndRender();
      return undefined;
    }
  } else {
    state.modules = modules;
    state.company = company;
    state.notifications = notifications;
  }

  persist();
  applyModules();
  renderAll();
  toast('Configurações salvas.');
}

async function saveProfile() {
  if (blockedByOffline()) return;

  const name = $('#profile-name').value.trim();
  const phone = $('#profile-phone').value.trim();
  if (!name) return toast('Informe o seu nome.', 'error');

  if (hasApi()) {
    try {
      const saved = await FLUXY_API.post('/api/me', { name, phone });
      state.profile = { ...state.profile, name: saved.name, phone: saved.phone };
    } catch (error) {
      return toast(apiErrorMessage(error, 'Não foi possível salvar o perfil.'), 'error');
    }
  } else {
    state.profile = { ...state.profile, name, phone };
    const users = localUsers();
    const user = users.find(candidate => candidate.email === state.profile.email);
    if (user) {
      Object.assign(user, { name, phone });
      saveLocalUsers(users);
    }
  }

  state.user = { ...state.user, name: state.profile.name, phone: state.profile.phone };
  set('fp_user', state.user);
  persist();
  renderAll();
  toast('Perfil atualizado.');
}

async function endOtherSessions() {
  if (!hasApi()) return toast('No modo local não existem sessões em outros dispositivos.');

  try {
    const { ended } = await FLUXY_API.post('/api/auth/logout-others');
    toast(ended
      ? `${ended} ${ended === 1 ? 'outra sessão foi encerrada' : 'outras sessões foram encerradas'}.`
      : 'Não havia outras sessões abertas.');
  } catch (error) {
    toast(apiErrorMessage(error, 'Não foi possível encerrar as sessões.'), 'error');
  }
}

async function exportableData() {
  const { calendarDate, offline, pagination, ...data } = state;
  if (hasApi()) {
    data.transactions = await FLUXY_SYNC.fetchAllPages('/api/transacoes');
    data.stockHistory = await FLUXY_SYNC.fetchAllPages('/api/movimentacoes-estoque');
  }
  return { exportadoEm: new Date().toISOString(), ...data };
}

async function exportWithAllData(build, filename) {
  try {
    exportJSON(filename, await build());
  } catch (error) {
    toast(apiErrorMessage(error, 'Não foi possível exportar os dados.'), 'error');
  }
}

function bindSettingsAndProfileActions() {
  const withButton = (busyText, task) => event => withBusyButton(event.currentTarget, busyText, task);

  $('#save-settings').onclick = withButton('Salvando...', saveSettings);
  $('#save-profile').onclick = withButton('Salvando...', saveProfile);
  $('#end-sessions').onclick = withButton('Encerrando...', endOtherSessions);
  $('#delete-account').onclick = () => openModal('delete-account');

  $('#export-data').onclick = withButton('Exportando...', () => exportWithAllData(async () => ({
    profile: state.profile,
    transactions: await allTransactions(),
    accounts: state.accounts,
    clients: state.clients,
    services: state.services,
    events: state.events
  }), 'fluxy-dados.json'));
  $('#backup-data').onclick = withButton('Exportando...', () => exportWithAllData(exportableData, `fluxy-backup-${todayISO()}.json`));
  $('#export-report').onclick = withButton('Gerando...', exportTransactionsCsv);
}

function bindBrandLinksToHome() {
  $$('.brand').forEach(brand => {
    brand.style.cursor = 'pointer';
    brand.setAttribute('role', 'button');
    brand.setAttribute('tabindex', '0');
    brand.title = 'Voltar para a tela inicial';
    brand.onclick = goHome;
    brand.onkeydown = event => {
      if (event.key === 'Enter') goHome();
    };
  });
}

function bindHashNavigation() {
  window.addEventListener('hashchange', () => {
    const tokenFromLink = takeResetTokenFromUrl();
    if (tokenFromLink) return openResetLink(tokenFromLink);
    if ($('#app').classList.contains('hidden')) return undefined;
    return showSection((location.hash || '#dashboard').slice(1));
  });
}

function showLocalModeNotice() {
  if (!FLUXY_API.localOnly) return;

  const note = $('#auth-mode-note');
  note.classList.remove('hidden');

  if (!localModeAllowed()) {
    note.textContent = LOCAL_MODE_DISABLED_MESSAGE;
    note.classList.add('error');
    $$('#login-form button, #register-form button, #login-form input, #register-form input, .auth-switch button')
      .forEach(control => { control.disabled = true; });
    return;
  }

  note.textContent =
    'Modo de demonstração: contas e dados ficam apenas neste navegador, sem a proteção do servidor. ' +
    'Não use com dados reais de clientes.';

  if (FLUXY_API.isFile) {
    const banner = document.createElement('div');
    banner.className = 'file-banner';
    banner.textContent =
      'Você abriu o Fluxy direto pelo arquivo (file://). Para usar o banco de dados, feche esta janela, ' +
      'execute o INICIAR-FLUXY e acesse http://localhost:8080.';
    document.body.appendChild(banner);
  }
}

function bootstrap() {
  bindDelegatedClicks();
  bindForms();
  bindLayoutControls();
  bindSettingsAndProfileActions();
  bindBrandLinksToHome();
  bindHashNavigation();
  showLocalModeNotice();

  const tokenFromLink = takeResetTokenFromUrl();
  if (tokenFromLink) {
    openResetLink(tokenFromLink);
    return;
  }

  if (FLUXY_AUTH.isAuthenticated()) {
    state.user = get('fp_user', null);
    start();
    return;
  }

  showLoginOrResumeSession();
}

function showLogin() {
  $('#auth').classList.remove('hidden');
  $('#app').classList.add('hidden');
  authView('login', { focus: false });
  showPendingNotice();
}

// Sem a marca nesta aba o cookie ainda pode valer (aba nova): o servidor e consultado antes do login.
async function showLoginOrResumeSession() {
  if (FLUXY_API.localOnly || sessionStorage.getItem(NOTICE_KEY)) {
    if (!FLUXY_API.localOnly) clearAccountData();
    showLogin();
    return;
  }

  const profile = await FLUXY_AUTH.resumeServerSession();
  if (!profile) {
    clearAccountData();
    showLogin();
    return;
  }

  state.user = { name: profile.name, email: profile.email, phone: profile.phone || '', role: profile.role || 'admin' };
  state.profile = { ...state.profile, name: profile.name, email: profile.email, phone: profile.phone || '', created: profile.created };
  set('fp_user', state.user);
  persist();
  start();
}

document.addEventListener('DOMContentLoaded', bootstrap);
