const { sendJson } = require('../lib/http-helpers');
const { requireUser } = require('../lib/auth-middleware');
const { mapProfile, listAccessHistory } = require('./account');
const { getCompany, getModules, getSettings } = require('./company');
const data = require('./data');

// Transacoes e movimentacoes de estoque vem so com a primeira pagina; os totais de todas
// chegam em "summary". O restante vem completo.
async function handleSyncRoute(req, res, pathname) {
  if (pathname !== '/api/sync' || req.method !== 'GET') return false;

  const user = await requireUser(req);
  const companyId = user.empresa_id;

  const [
    logins, company, modules, settings,
    customers, suppliers, products, stockPage, transactionPage, bills, services, events, summary
  ] = await Promise.all([
    listAccessHistory(user.id),
    getCompany(companyId),
    getModules(companyId),
    getSettings(companyId),
    data.listCustomers(companyId),
    data.listSuppliers(companyId),
    data.listProducts(companyId),
    data.listStockMovementsPage(companyId),
    data.listTransactionsPage(companyId),
    data.listBills(companyId),
    data.listServices(companyId),
    data.listEvents(companyId),
    data.financialSummary(companyId)
  ]);

  sendJson(res, 200, {
    profile: mapProfile(user),
    logins,
    company,
    modules,
    settings,
    clients: customers,
    suppliers,
    products,
    stockHistory: stockPage.items,
    transactions: transactionPage.items,
    pagination: {
      stockHistory: { nextCursor: stockPage.nextCursor },
      transactions: { nextCursor: transactionPage.nextCursor }
    },
    summary,
    accounts: bills,
    services,
    events
  });
  return true;
}

module.exports = { handleSyncRoute };
