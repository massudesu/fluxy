function renderClients() {
  const totalsByClient = {};
  financialSummary().incomeByCustomer.forEach(({ customer, cents }) => {
    const key = customer.toLowerCase();
    totalsByClient[key] = (totalsByClient[key] || 0) + cents;
  });

  $('#clients-table').innerHTML = state.clients.length
    ? state.clients.map(client => `
      <tr>
        <td><strong>${esc(client.nome)}</strong></td>
        <td>${esc(client.email || '')}<br><small class="muted">${esc(client.telefone || '')}</small></td>
        <td>${date(client.created || todayISO())}</td>
        <td>${moneyFromCents(totalsByClient[String(client.nome).toLowerCase()] || 0)}</td>
        <td>${removeButton('client', client.id)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" class="muted">Nenhum cliente cadastrado.</td></tr>';
}

function renderStock() {
  const isLow = product => Number(product.quantity) <= Number(product.minimum || 0);

  $('#stock-total').textContent = state.products.length;
  $('#stock-low').textContent = state.products.filter(isLow).length;

  $('#products-table').innerHTML = state.products.length
    ? state.products.map(product => `
      <tr>
        <td>${esc(product.code || '—')}</td>
        <td><strong>${esc(product.name)}</strong><br><small class="muted">${esc(product.barcode || '')}</small></td>
        <td>${esc(product.category || 'Geral')}</td>
        <td>
          <strong class="${isLow(product) ? 'negative' : ''}">${Number(product.quantity) || 0}</strong>
          <br><small class="muted">mín. ${Number(product.minimum) || 0}</small>
        </td>
        <td>${money(product.salePrice)}</td>
        <td>${esc(product.supplier || '—')}</td>
        <td>${removeButton('product', product.id)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="7" class="muted">Nenhum produto cadastrado.</td></tr>';

  const history = [...state.stockHistory].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
  $('#stock-history-more').classList.toggle('hidden', !(hasApi() && state.pagination.stockHistory.nextCursor));

  $('#stock-history-table').innerHTML = history.map(entry => `
    <tr>
      <td>${date(entry.date)}</td>
      <td>${esc(entry.productName)}</td>
      <td><span class="type-pill ${entry.movement === 'entrada' ? 'in' : 'out'}">${entry.movement === 'entrada' ? 'Entrada' : 'Saída'}</span></td>
      <td>${Number(entry.quantity) || 0}</td>
      <td>${esc(entry.note || '')}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="muted">Nenhuma movimentação.</td></tr>';
}

function renderServices() {
  $('#services-table').innerHTML = state.services.length
    ? state.services.map(service => `
      <tr>
        <td>${date(service.date)}</td>
        <td>${esc(service.client || '—')}</td>
        <td><strong>${esc(service.description)}</strong></td>
        <td>${money(service.valor)}</td>
        <td><span class="status-pill paid">Concluído</span></td>
        <td>${removeButton('service', service.id)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="6" class="muted">Nenhum serviço cadastrado.</td></tr>';
}

function renderSuppliers() {
  $('#suppliers-list').innerHTML = state.suppliers.length
    ? state.suppliers.map(supplier => `
      <div class="supplier-row">
        <span class="list-icon"><i class="fa-solid fa-truck-field"></i></span>
        <div>
          <b>${esc(supplier.nome)}</b>
          <small>
            ${esc(supplier.categoria || 'Sem categoria')}
            ${supplier.cidade ? ' &middot; ' + esc(supplier.cidade) : ''}
            ${supplier.estado ? '/' + esc(supplier.estado) : ''}
          </small>
          <small>${esc(supplier.telefone || '')}${supplier.telefone && supplier.email ? ' &middot; ' : ''}${esc(supplier.email || '')}</small>
        </div>
        ${removeButton('supplier', supplier.id)}
      </div>
    `).join('')
    : '<p class="muted">Nenhum fornecedor cadastrado ainda. Clique em "Novo fornecedor" para começar.</p>';
}

async function showMoreStockHistory(event) {
  if (blockedByOffline()) return;
  await withBusyButton(event?.currentTarget, 'Carregando...', async () => {
    try {
      await FLUXY_SYNC.loadMoreStock();
      renderStock();
    } catch (error) {
      toast(apiErrorMessage(error, 'Não foi possível carregar mais movimentações.'), 'error');
    }
  });
}
