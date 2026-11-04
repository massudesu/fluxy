function supplierOptionsHtml() {
  return state.suppliers.map(supplier => `<option value="${esc(supplier.nome)}"></option>`).join('');
}

function productOptionsHtml() {
  return state.products
    .map(product => `<option value="${Number(product.id)}">${esc(product.name)} (${Number(product.quantity) || 0})</option>`)
    .join('');
}

const selectedIf = condition => (condition ? ' selected' : '');

const MODAL_FORMS = {
  transaction: (type) => ({
    title: 'Nova movimentação',
    html: `
      <label>Tipo
        <select name="tipo">
          <option value="entrada"${selectedIf(type !== 'saida')}>Entrada</option>
          <option value="saida"${selectedIf(type === 'saida')}>Saída</option>
        </select>
      </label>
      <label>Descrição<input name="descricao" required maxlength="200" placeholder="Ex.: Venda de produtos"></label>
      <label>Valor<input name="valor" type="number" step="0.01" min="0.01" required></label>
      <label>Data<input name="data" type="date" value="${todayISO()}" required></label>
      <label>Categoria<input name="categoria" maxlength="80" placeholder="Ex.: Vendas"></label>
      <label>Cliente (opcional)<input name="cliente" maxlength="150"></label>
    `
  }),

  account: () => ({
    title: 'Agendar conta',
    html: `
      <label>Tipo
        <select name="tipo">
          <option value="pagar">Conta a pagar</option>
          <option value="receber">Conta a receber</option>
        </select>
      </label>
      <label>Descrição<input name="descricao" required maxlength="200"></label>
      <label>Valor<input name="valor" type="number" step="0.01" min="0.01" required></label>
      <label>Vencimento<input name="vencimento" type="date" value="${todayISO()}" required></label>
    `
  }),

  supplier: () => ({
    title: 'Novo fornecedor',
    html: `
      <label>Nome / razão social<input name="nome" required maxlength="150" placeholder="Ex.: Distribuidora São Paulo"></label>
      <div class="form-grid">
        <label>CNPJ / CPF<input name="documento" maxlength="18"></label>
        <label>Telefone<input name="telefone" type="tel" maxlength="20"></label>
      </div>
      <label>E-mail<input name="email" type="email" maxlength="150"></label>
      <div class="form-grid">
        <label>Cidade<input name="cidade" maxlength="100"></label>
        <label>Estado<input name="estado" maxlength="2" pattern="[A-Za-z]{2}" title="Sigla com duas letras, ex.: SP"></label>
      </div>
      <label>Produtos / categoria fornecida<input name="categoria" maxlength="100" placeholder="Ex.: Embalagens"></label>
      <label>Observações<textarea name="observacoes" maxlength="2000"></textarea></label>
    `
  }),

  client: () => ({
    title: 'Novo cliente',
    html: `
      <label>Nome completo<input name="nome" required maxlength="150"></label>
      <label>E-mail<input name="email" type="email" maxlength="150"></label>
      <label>Telefone<input name="telefone" type="tel" maxlength="20"></label>
      <label>Observações<textarea name="observacoes" maxlength="2000"></textarea></label>
    `
  }),

  service: () => ({
    title: 'Registrar serviço',
    html: `
      <label>Cliente<input name="client" maxlength="150"></label>
      <label>Serviço realizado<input name="description" required maxlength="200"></label>
      <label>Valor<input name="valor" type="number" step="0.01" min="0.01" required></label>
      <label>Data<input name="date" type="date" value="${todayISO()}" required></label>
    `
  }),

  product: () => ({
    title: 'Novo produto',
    html: `
      <div class="form-grid">
        <label>Código do produto<input name="code" required maxlength="50"></label>
        <label>Código de barras<input name="barcode" maxlength="50"></label>
      </div>
      <label>Nome<input name="name" required maxlength="150"></label>
      <div class="form-grid">
        <label>Categoria<input name="category" maxlength="100"></label>
        <label>Fornecedor
          <input name="supplier" list="supplier-options" maxlength="150">
          <datalist id="supplier-options">${supplierOptionsHtml()}</datalist>
        </label>
      </div>
      <div class="form-grid">
        <label>Quantidade<input name="quantity" type="number" min="0" step="1" value="0" required></label>
        <label>Quantidade mínima<input name="minimum" type="number" min="0" step="1" value="0" required></label>
        <label>Preço de custo<input name="costPrice" type="number" step="0.01" min="0" value="0" required></label>
        <label>Preço de venda<input name="salePrice" type="number" step="0.01" min="0" value="0" required></label>
      </div>
    `
  }),

  'stock-move': () => ({
    title: 'Movimentação de estoque',
    html: `
      <label>Produto
        <select name="productId" required>${productOptionsHtml()}</select>
      </label>
      <label>Tipo
        <select name="movement">
          <option value="entrada">Entrada</option>
          <option value="saida">Saída</option>
        </select>
      </label>
      <label>Quantidade<input name="quantity" type="number" min="1" step="1" required></label>
      <label>Observação<input name="note" maxlength="200"></label>
    `
  }),

  event: () => ({
    title: 'Novo evento no calendário',
    html: `
      <label>Título<input name="title" required maxlength="150" placeholder="Ex.: Entrega para cliente"></label>
      <label>Tipo
        <select name="type">
          <option value="entrega">Entrega</option>
          <option value="compra">Compra</option>
          <option value="fornecedor">Fornecedor</option>
          <option value="reuniao">Reunião</option>
          <option value="compromisso">Compromisso</option>
          <option value="feriado">Feriado</option>
          <option value="importante">Data importante</option>
        </select>
      </label>
      <label>Data<input name="date" type="date" value="${todayISO()}" required></label>
      <label>Horário<input name="time" type="time"></label>
      <label>Descrição<input name="description" maxlength="300"></label>
    `
  }),

  password: () => ({
    title: 'Alterar senha',
    successMessage: 'Senha alterada com sucesso.',
    html: `
      <label>Senha atual<input name="current" type="password" autocomplete="current-password" required></label>
      <label>Nova senha
        <input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
        <small class="field-hint">Mínimo de 8 caracteres, com letra maiúscula, minúscula e número.</small>
      </label>
      <label>Confirmar nova senha<input name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
    `
  }),

  'delete-account': () => ({
    title: 'Excluir conta',
    submitLabel: 'Excluir definitivamente',
    submitClass: 'danger-btn',
    html: `
      <p class="form-message error">
        Esta ação não pode ser desfeita. A conta, a empresa e todos os registros (clientes, estoque,
        movimentações, contas e agenda) serão apagados.
      </p>
      <label>Digite a sua senha para confirmar
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
    `
  })
};

function hasApi() {
  return !FLUXY_API.localOnly;
}

const SAVE_ENDPOINTS = {
  client: '/api/clientes',
  supplier: '/api/fornecedores',
  transaction: '/api/transacoes',
  account: '/api/contas',
  service: '/api/servicos',
  event: '/api/eventos',
  product: '/api/produtos',
  'stock-move': '/api/movimentacoes-estoque'
};

const COLLECTIONS = {
  transaction: 'transactions',
  account: 'accounts',
  client: 'clients',
  service: 'services',
  event: 'events',
  supplier: 'suppliers',
  product: 'products'
};

const RELATED_LISTS = {
  transaction: { collection: 'clients', endpoint: '/api/clientes', typedName: data => data.cliente },
  service: { collection: 'clients', endpoint: '/api/clientes', typedName: data => data.client },
  product: { collection: 'suppliers', endpoint: '/api/fornecedores', typedName: data => data.supplier }
};

// O servidor cadastra na hora o cliente ou fornecedor digitado; a lista da tela acompanha.
async function refreshRelatedList(kind, data) {
  const related = RELATED_LISTS[kind];
  const name = related ? String(related.typedName(data) || '').trim() : '';
  if (!name || state[related.collection].some(item => item.nome === name)) return;

  try {
    state[related.collection] = await FLUXY_API.get(related.endpoint);
  } catch (_error) {
    return;
  }
}

function blockedByOffline() {
  if (!hasApi() || !state.offline) return false;
  toast('Sem conexão com o servidor. Aguarde a conexão voltar para salvar.', 'error');
  return true;
}

async function saveOnServer(kind, data) {
  if (blockedByOffline()) return false;

  try {
    const created = await FLUXY_API.post(SAVE_ENDPOINTS[kind], data);

    if (kind === 'stock-move') {
      const product = state.products.find(item => String(item.id) === String(data.productId));
      if (product) product.quantity += created.movement === 'entrada' ? created.quantity : -created.quantity;
      state.stockHistory.unshift(created);
    } else if (kind === 'transaction') {
      placeNewTransaction(created);
      await FLUXY_SYNC.refreshSummary();
      await refreshRelatedList(kind, data);
    } else {
      state[COLLECTIONS[kind]].push(created);
      if (kind === 'product') await FLUXY_SYNC.refreshStock();
      await refreshRelatedList(kind, data);
    }
    return true;
  } catch (error) {
    toast(apiErrorMessage(error, 'Não foi possível salvar o registro.'), 'error');
    return false;
  }
}

function saveInBrowser(kind, data) {
  if (kind === 'product') {
    const quantity = Number(data.quantity) || 0;
    if (data.code && state.products.some(product => product.code === data.code)) {
      toast('Já existe um produto com este código.', 'error');
      return false;
    }
    state.products.push({
      ...data, id: uid(), quantity, minimum: Number(data.minimum) || 0,
      costPrice: Number(data.costPrice) || 0, salePrice: Number(data.salePrice) || 0
    });
    if (quantity > 0) {
      state.stockHistory.unshift({ id: uid(), date: todayISO(), productName: data.name, movement: 'entrada', quantity, note: 'Cadastro inicial' });
    }
    return true;
  }

  if (kind === 'stock-move') {
    const product = state.products.find(item => String(item.id) === String(data.productId));
    const quantity = Number(data.quantity);
    if (!product) {
      toast('Cadastre um produto antes de movimentar o estoque.', 'error');
      return false;
    }
    if (data.movement === 'saida' && product.quantity < quantity) {
      toast('Quantidade insuficiente em estoque.', 'error');
      return false;
    }
    product.quantity += data.movement === 'entrada' ? quantity : -quantity;
    state.stockHistory.unshift({ id: uid(), date: todayISO(), productName: product.name, movement: data.movement, quantity, note: data.note });
    return true;
  }

  const record = { ...data, id: uid() };
  if ('valor' in record) record.valor = Number(record.valor);
  if (kind === 'account') record.status = 'pendente';
  if (kind === 'supplier' || kind === 'client') record.created = todayISO();
  state[COLLECTIONS[kind]].push(record);
  return true;
}

async function changePassword(data) {
  if (!strongPassword(data.password)) {
    toast(PASSWORD_RULE, 'error');
    return false;
  }
  if (data.password !== data.confirm) {
    toast('As senhas não conferem.', 'error');
    return false;
  }

  try {
    if (hasApi()) {
      await FLUXY_API.post('/api/auth/change-password', { currentPassword: data.current, newPassword: data.password });
    } else {
      await changeLocalPassword(state.user.email, data.current, data.password);
    }
    return true;
  } catch (error) {
    toast(hasApi() ? apiErrorMessage(error, 'Não foi possível alterar a senha.') : error.message, 'error');
    return false;
  }
}

async function deleteAccount(data) {
  try {
    if (hasApi()) {
      await FLUXY_API.send('DELETE', '/api/me', { password: data.password });
      FLUXY_API.clearSession();
      clearAccountData();
    } else {
      const users = localUsers();
      const user = users.find(candidate => candidate.email === state.user.email);
      if (!user || !(await localPasswordMatches(user, data.password))) throw new Error('A senha não confere.');
      // Apaga so esta conta; outras contas locais do mesmo navegador continuam.
      saveLocalUsers(users.filter(candidate => candidate !== user));
      clearAccountData();
    }
  } catch (error) {
    toast(hasApi() ? apiErrorMessage(error, 'Não foi possível excluir a conta.') : error.message, 'error');
    return false;
  }

  sessionStorage.setItem(NOTICE_KEY, 'Conta excluída. Todos os dados foram apagados.');
  location.hash = '';
  location.reload();
  return true;
}

function saveModalRecord(kind, data) {
  if (kind === 'password') return changePassword(data);
  if (kind === 'delete-account') return deleteAccount(data);
  return hasApi() ? saveOnServer(kind, data) : saveInBrowser(kind, data);
}

let modalOpener = null;

function openModal(kind, type) {
  const buildForm = MODAL_FORMS[kind];
  if (!buildForm) return;
  if (kind === 'stock-move' && !state.products.length) {
    toast('Cadastre um produto antes de movimentar o estoque.', 'error');
    return;
  }

  const form = buildForm(type);
  modalOpener = document.activeElement;
  $('#modal-title').textContent = form.title;
  $('#modal-form').innerHTML = form.html +
    '<div class="modal-actions">' +
    '<button type="button" class="btn secondary" id="cancel-modal">Cancelar</button>' +
    `<button type="submit" class="btn ${form.submitClass || 'primary'}" id="save-modal">${form.submitLabel || 'Salvar'}</button>` +
    '</div>';
  $('#modal').classList.remove('hidden');

  $('#modal-form').onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    withBusyButton($('#save-modal'), 'Salvando...', async () => {
      const saved = await saveModalRecord(kind, data);
      if (saved === false || kind === 'delete-account') return;
      persist();
      closeModal();
      renderAll();
      toast(form.successMessage || 'Registro salvo com sucesso.');
    });
  };

  $('#cancel-modal').onclick = closeModal;
  const firstField = $('#modal-form input, #modal-form select, #modal-form textarea');
  if (firstField) firstField.focus();
}

function closeModal() {
  if ($('#modal').classList.contains('hidden')) return;
  $('#modal').classList.add('hidden');
  $('#modal-form').innerHTML = '';
  if (modalOpener && document.contains(modalOpener)) modalOpener.focus();
  modalOpener = null;
}

async function payAccount(id) {
  const account = state.accounts.find(item => item.id === id);
  if (!account || blockedByOffline()) return;

  if (hasApi()) {
    try {
      Object.assign(account, await FLUXY_API.post(`/api/contas/${id}/status`));
    } catch (error) {
      toast(apiErrorMessage(error, 'Não foi possível atualizar a conta.'), 'error');
      return;
    }
  } else {
    account.status = account.status === 'pago' ? 'pendente' : 'pago';
  }

  persist();
  renderAll();
  toast(account.status === 'pago' ? 'Conta marcada como paga.' : 'Conta marcada como pendente.');
}

async function removeItem(kind, id) {
  const collection = COLLECTIONS[kind];
  if (!collection || blockedByOffline()) return;
  if (!confirm(kind === 'product' ? 'Remover este produto?' : 'Remover este registro?')) return;

  if (hasApi()) {
    try {
      await FLUXY_API.send('DELETE', `${SAVE_ENDPOINTS[kind]}/${id}`);
    } catch (error) {
      if (error.code !== 'API_404') {
        toast(apiErrorMessage(error, 'Não foi possível remover. Tente novamente.'), 'error');
        return;
      }
    }
  }

  state[collection] = state[collection].filter(item => item.id !== id);
  if (hasApi() && kind === 'transaction') await FLUXY_SYNC.refreshSummary();
  persist();
  renderAll();
  // No banco, produtos e movimentações perdem o vínculo com o cadastro removido; a tela acompanha.
  if (hasApi() && (kind === 'supplier' || kind === 'client')) syncAndRender();
  toast(kind === 'product' ? 'Produto removido.' : 'Registro removido.');
}
