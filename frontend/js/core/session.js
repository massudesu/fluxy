function authView(view, { focus = true } = {}) {
  $('#login-form').classList.toggle('hidden', view !== 'login');
  $('#register-form').classList.toggle('hidden', view !== 'register');
  $('#forgot-form').classList.toggle('hidden', view !== 'forgot');
  $('.auth-switch').classList.toggle('hidden', view !== 'login');
  if (view === 'forgot') openRecovery();

  const firstField = $(`#${view}-form input`);
  if (focus && firstField) firstField.focus();
}

const ROLE_LABELS = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };

function renderIdentity() {
  const name = state.profile.name || 'Usuário';
  $('#user-name').textContent = name;
  $('#user-avatar').textContent = initials(name);
  $('#greeting-name').textContent = name.split(' ')[0];
  $('#workspace-name').textContent = state.company.trade || state.company.name || 'Minha empresa';
  $('#workspace-avatar').textContent = initials(state.company.trade || state.company.name);
  $('#user-role').textContent = ROLE_LABELS[state.user?.role] || 'Administrador';
  $('#workspace-mode').textContent = FLUXY_API.localOnly ? 'Modo local (só neste navegador)' : 'Painel da empresa';
}

function showConnectionBanner(visible) {
  $('#connection-banner').classList.toggle('hidden', !visible);
}

async function syncAndRender() {
  const result = await FLUXY_SYNC.loadAll();
  showConnectionBanner(result === 'offline');
  if (result === 'synced') {
    applyModules();
    renderAll();
  }
  return result;
}

async function start() {
  if (!state.user) return;

  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');

  applyModules();
  renderAll();

  let target = (location.hash || '#dashboard').slice(1);
  if (!document.getElementById(target)) target = 'dashboard';
  showSection(target);

  await syncAndRender();
}

function goHome() {
  if (state.user && FLUXY_AUTH.isAuthenticated()) {
    location.hash = '#dashboard';
    showSection('dashboard');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  authView('login');
}
window.goHome = goHome;

async function logout() {
  await FLUXY_AUTH.signOut();
  location.hash = '';
  location.reload();
}

const SECTION_TITLES = {
  dashboard: 'Visão geral',
  fornecedores: 'Fornecedores',
  financeiro: 'Movimentações',
  contas: 'Contas a pagar/receber',
  estoque: 'Estoque',
  clientes: 'Clientes',
  servicos: 'Serviços e comprovantes',
  agenda: 'Agenda de serviços',
  calendario: 'Calendário empresarial',
  relatorios: 'Relatórios financeiros',
  configuracoes: 'Configurações',
  perfil: 'Meu perfil'
};

function showSection(id) {
  if (!id || !SECTION_TITLES[id] || !document.getElementById(id)) id = 'dashboard';
  if (!['configuracoes', 'perfil', 'dashboard'].includes(id) && state.modules[id] === false) id = 'dashboard';

  $$('.section').forEach(section => section.classList.toggle('hidden', section.id !== id));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.section === id));

  $('#page-title').textContent = SECTION_TITLES[id];
  $('#page-eyebrow').textContent = id === 'dashboard'
    ? 'PAINEL PRINCIPAL'
    : 'GESTÃO / ' + SECTION_TITLES[id].toUpperCase();

  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (id === 'calendario') renderCalendar();
  if (innerWidth < 760) $('#sidebar').classList.remove('open');
}

const TOGGLEABLE_MODULES = Object.keys(MODULES_DEFAULT);

function applyModules() {
  TOGGLEABLE_MODULES.forEach(moduleKey => {
    if (moduleKey === 'dashboard') return;
    const navButton = $(`#nav [data-section="${moduleKey}"]`);
    if (navButton) navButton.classList.toggle('hidden', state.modules[moduleKey] === false);
  });

  const currentSectionId = $('.section:not(.hidden)')?.id;
  if (currentSectionId && state.modules[currentSectionId] === false) showSection('dashboard');
}
