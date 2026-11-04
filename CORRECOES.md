# Histórico de correções

## Backend Node

- Sessão em cookie `HttpOnly` (`SameSite=Strict`, `Secure` com HTTPS); o token
  não vai mais no corpo da resposta nem no `localStorage`. Gravações exigem o
  cabeçalho `X-Fluxy-Request: 1` e um `Origin` do próprio site (CSRF).
- Limite de tentativas no PostgreSQL (tabela `limite_tentativa`), compartilhado
  entre instâncias. A tentativa de login é contada antes de conferir a senha,
  para que pedidos simultâneos não passem juntos. Redefinir a senha pelo e-mail
  libera o bloqueio por e-mail (que também atinge a dona da conta).
- Clientes e fornecedores com índice único `(empresa_id, lower(nome))`; a
  migração une repetidos que já existam no cadastro mais antigo.
- Paginação por cursor em `/api/transacoes` e `/api/movimentacoes-estoque`
  (sem parâmetros, o contrato antigo continua). Totais em `/api/resumo`,
  somados no banco e devolvidos em centavos.
- Dinheiro convertido a partir do texto (`1.005` vira `1.01`); nada de soma em
  ponto flutuante.
- `/health` responde 503 com o banco fora do ar; gzip assíncrono.

## Backend em C (experimental)

- Senhas com scrypt do OpenSSL, no mesmo formato do Node; contas no formato
  antigo (SHA-256 iterado) são regravadas no primeiro login.
- Sessões: posições livres ou vencidas são reutilizadas, sem derrubar sessões
  ativas; logout encerra só a sessão atual; token de 32 bytes do OpenSSL.
- Gravação atômica do arquivo de usuários e da empresa; falha preserva o
  arquivo anterior.
- Uma thread por conexão (até 64), timeouts e limites de tamanho.
- cJSON no lugar do parser próprio.
- Dados da empresa em um arquivo por conta (antes todas as contas liam e
  gravavam o mesmo arquivo).
- Limite de tentativas de login e cadastro; com a tabela de contadores cheia,
  nenhum bloqueio ativo é descartado (a tentativa recebe 503).
- Arquivos de dados com permissão `0600` e pasta `0700` no Linux/macOS.

## Ao atualizar

1. Todos entram de novo uma vez (tokens antigos do navegador são apagados).
2. Integrações que usavam `Authorization: Bearer` precisam do cookie e de
   `X-Fluxy-Request: 1` nas gravações.
3. Faça `pg_dump` antes de `npm run db:migrate`: clientes e fornecedores com o
   mesmo nome na mesma empresa são unidos.
4. Backend em C: o antigo `fluxy-company.json` não é mais lido (ver
   `backend/c/LEIA-ME.md`).

## Pendências

- Gerar e versionar o `package-lock.json` (`npm install`) e usar `npm ci` nos
  servidores. Não foi possível gerá-lo aqui: o registro do npm estava bloqueado.
- Rodar `npm test` com o driver `pg` instalado de verdade (aqui os testes de
  banco usaram um substituto mínimo, fora do projeto).
- Compilar o backend em C no Windows (`build.bat`); só foi compilado no Linux.
