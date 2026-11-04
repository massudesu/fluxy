# Testes do Fluxy

Rode com `npm test` (no PowerShell do Windows: `npm.cmd test`).

Os testes sobem o servidor de verdade em uma porta livre e falam com ele por
HTTP, gravando no PostgreSQL configurado em `backend/.env`. O envio de e-mail
é testado contra um servidor SMTP de mentira que roda na própria máquina —
nenhum e-mail sai para a internet. As contas criadas usam o domínio
`@teste.fluxy.invalid` e são apagadas no final. Antes de rodar, `npm test` e `npm run verify` zeram os contadores de
limite de tentativas por IP do próprio computador (`127.0.0.1`), que ficam no
banco e, somados de uma execução para outra, bloqueariam a seguinte.

| Arquivo | O que cobre | Precisa do PostgreSQL |
|---|---|---|
| `unidade.test.js` | regra de senha, hash, tokens, validações, limite de tentativas | não |
| `smtp.test.js` | cliente SMTP: entrega, login, STARTTLS, TLS direto, falhas e tempo esgotado | não (os 3 testes de TLS pedem o `openssl` instalado) |
| `api.test.js` | cadastro sem pergunta de segurança, login, proteção das rotas, isolamento entre empresas, dados, estoque, configurações, perfil, troca de senha, sessões, exclusão de conta | sim |
| `recuperacao-senha.test.js` | pedido do link, e-mail recebido, token com hash, validade, uso único, uso simultâneo, resposta igual com e sem conta, falhas do provedor | sim |
| `backend-c.test.js` | backend em C compilado na hora: cookie de sessão, scrypt compatível com o Node, migração do hash antigo, JSON inválido e campos longos, sessões cheias, logout de uma sessão só, cliente parado, 413, gravação segura do arquivo de usuários, arquivos estáticos | não (pula se faltar gcc ou OpenSSL) |
| `correcoes.test.js` | regressão das correções da revisão técnica: `/health` 503, cadastros simultâneos sem duplicidade e união de repetidos na migração, cookie `HttpOnly` e CSRF, limite de tentativas no banco (vale entre instâncias), paginação por cursor, resumo em centavos, gzip assíncrono | sim |
| `seguranca.test.js` | cabeçalhos, CSP, CORS, endereços malformados, arquivos fora da pasta do site, cache, bloqueio por tentativas, banco fora do ar | sim |

Sem banco configurado, `npm test` roda só os arquivos que não dependem dele
e lista os demais como "não executados".

Outros comandos:

- `npm run verify` — conferência rápida (cadastra, entra, confere a sessão e
  apaga a conta de teste).
- `npm run check` — sintaxe de todos os arquivos JavaScript.
- `npm run mail:test -- voce@exemplo.com` — envia um e-mail real pelo SMTP do
  `backend/.env`. É o único teste que confirma a entrega de verdade.

## O que não é coberto por testes automáticos

- **Entrega real de e-mail:** depende das credenciais do seu provedor. Use
  `npm run mail:test`.
- **Telas no navegador:** não há suíte automática de interface dentro do
  projeto; confira cadastro, login, recuperação, painel e modais à mão.
- **Backend em C:** sem testes automáticos; compile com `./build.sh` (ou
  `build.bat`) e confira as rotas com `curl`.
