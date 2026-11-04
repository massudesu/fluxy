# Fluxy — como abrir no VS Code

O Fluxy grava tudo (clientes, fornecedores, produtos, financeiro, agenda...)
num banco **PostgreSQL**. São 3 passos: instalar o PostgreSQL, configurar o
`.env`, rodar o projeto.

> **Windows (PowerShell):** se aparecer o erro "npm.ps1 não está assinado
> digitalmente", use `npm.cmd` no lugar de `npm` em todos os comandos abaixo
> (ex.: `npm.cmd install`, `npm.cmd start`).

## 1. Instalar o PostgreSQL (se ainda não tiver)

- Windows/macOS: https://www.postgresql.org/download/ (instalador oficial,
  marque "pgAdmin" se quiser uma interface gráfica).
- Linux (Debian/Ubuntu): `sudo apt install postgresql`

Anote a senha que você definir para o usuário `postgres` durante a instalação.

## 2. Configurar o projeto

No terminal do VS Code, dentro da pasta `fluxy/`:

```bash
npm install
cp backend/.env.example backend/.env      # Windows: copy backend\.env.example backend\.env
```

Abra `backend/.env` e troque `SUA_SENHA` pela senha do PostgreSQL:

```
DATABASE_URL=postgres://postgres:SUA_SENHA@localhost:5432/fluxy_db
```

Crie o banco (uma vez só):

```bash
createdb -U postgres fluxy_db
```

Se `createdb` não for reconhecido, abra o **pgAdmin** ou o **SQL Shell
(psql)** que vêm com o instalador e rode `CREATE DATABASE fluxy_db;`.

## 3. Criar as tabelas e rodar

```bash
npm run db:migrate    # cria as tabelas (pode rodar de novo sem problema)
npm run db:seed       # opcional: adiciona uma empresa de teste com dados (não duplica se rodar de novo)
npm start             # sobe o Fluxy em http://localhost:8080
```

O navegador abre sozinho. Se você rodou `npm run db:seed`, já existe uma
conta de teste (use só no seu computador, a senha é pública):

- e-mail: `mariana@padariasaojose.com.br`
- senha: `Senha1234`

Ou clique em **Cadastre-se** e crie sua própria conta — cada conta nova já
ganha sua empresa e todos os módulos ligados.

> **Nunca abra `frontend/index.html` com dois cliques.** Isso usa `file://`
> e o Fluxy entra no modo local, sem banco de dados. Sempre use `npm start`
> e acesse `http://localhost:8080`.

## Recuperação de senha por e-mail

Em "Esqueci minha senha" a pessoa informa o e-mail e recebe um link para
criar uma nova senha. O link vale por 30 minutos, funciona uma única vez e,
ao ser usado, encerra todas as sessões abertas da conta. A tela responde a
mesma coisa para e-mails com e sem cadastro.

Para o envio funcionar, preencha no `backend/.env` os dados do seu provedor
de e-mail (o `.env.example` explica cada variável):

```
APP_URL=http://localhost:8080
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=seu-email@seudominio.com.br
SMTP_PASS=sua-senha-ou-senha-de-app
MAIL_FROM=Fluxy <seu-email@seudominio.com.br>
```

No Gmail, `SMTP_HOST=smtp.gmail.com` e `SMTP_PASS` precisa ser uma "senha de
app" (a senha normal da conta não funciona). Para conferir o envio de
verdade:

```bash
npm run mail:test -- seu-email@exemplo.com
```

Sem SMTP configurado, a tela avisa que a recuperação está indisponível —
nunca mostra "enviado" sem o provedor ter aceitado a mensagem. Para testar o
fluxo no seu computador sem provedor, use `MAIL_MODE=console`: nada é
enviado e o link aparece no terminal do servidor.

A antiga pergunta de segurança foi desativada. Contas criadas antes
continuam entrando normalmente e os dados antigos permanecem no banco, mas
não são mais usados.

## Estrutura do projeto

```
fluxy/
├── frontend/              # aplicação (SPA) servida ao navegador
│   ├── index.html
│   ├── css/
│   ├── vendor/              # Chart.js (versão fixa, servida pelo próprio Fluxy)
│   └── js/
│       ├── core/            # API, estado, login, sessão, sincronização, modal
│       └── modules/         # uma tela por módulo (dashboard, financeiro, ...)
├── backend/
│   ├── src/                # API Node.js
│   │   ├── routes/           # auth, conta, empresa/módulos, carga inicial, dados
│   │   └── lib/              # banco, segurança, validação, e-mail, limite de tentativas
│   ├── scripts/             # teste de envio de e-mail
│   ├── c/                   # API de autenticação em C (opcional, para estudo)
│   ├── database/
│   │   ├── schema.sql         # cria todas as tabelas (idempotente)
│   │   ├── seed.sql           # dados de exemplo (opcional)
│   │   └── migrate.js         # script que aplica os dois acima
│   ├── .env.example
│   └── logs/
├── docs/                   # convenções de nomes e outras decisões do projeto
└── tests/                  # testes automatizados contra o servidor real
```

## O que o sistema guarda no banco

Todas as telas do Fluxy leem e gravam no PostgreSQL: empresa, usuários e
sessões, clientes, fornecedores, produtos e movimentações de estoque,
transações (entradas/saídas), contas a pagar/receber, serviços prestados,
eventos da agenda, categorias, módulos ativos e preferências. Cada empresa só
enxerga os próprios dados (`empresa_id` em cada tabela).

O navegador guarda apenas uma cópia dos dados para a tela abrir rápido. Se o
servidor não responder, o Fluxy mostra essa cópia com um aviso e **bloqueia
gravações** até a conexão voltar — nada é salvo "só na tela". Ao sair, a cópia
é apagada.

Transações e movimentações de estoque, que crescem sem parar, chegam em
páginas de 100 (o botão **Mostrar mais** busca a próxima pelo servidor) e a
busca da tela de movimentações roda no banco. Os totais do painel, dos
relatórios e de cada cliente são calculados no PostgreSQL sobre **todos** os
registros (`/api/resumo`) e chegam em centavos inteiros, sem erro de
arredondamento. A exportação em CSV e o backup buscam todas as páginas.

## Segurança da sessão

- O token da sessão fica num **cookie `HttpOnly`** (`fluxy_session`): o
  JavaScript da página não consegue lê-lo, então um script malicioso não tem
  como copiar a sessão. Nada de token no `localStorage`.
- `SameSite=Strict` e, com HTTPS (`APP_URL` com `https://` ou produção),
  `Secure`. Sem "manter conectado" o cookie some ao fechar o navegador; com a
  opção, dura 30 dias. A validade real é sempre a do banco: sessão encerrada
  ou vencida é recusada mesmo que o cookie exista.
- **CSRF:** toda gravação precisa do cabeçalho `X-Fluxy-Request: 1` (o
  frontend envia sozinho) e, quando vem de um navegador, de um `Origin` do
  próprio site ou listado em `CORS_ORIGINS`. Formulários e links de outros
  sites não conseguem cumprir isso.
- Sair, trocar a senha ou redefinir a senha encerram as sessões no banco.

## Limite de tentativas

Login, cadastro, "esqueci minha senha" e a confirmação da senha atual têm
limite de tentativas. Os contadores ficam na tabela `limite_tentativa` do
PostgreSQL: reiniciar o servidor não zera os limites e várias instâncias
enxergam os mesmos números. A chave é um hash, sem e-mail nem IP gravado.

O limite de 20 senhas erradas por e-mail (vindas de qualquer IP) também
bloqueia a dona da conta por até 15 minutos. Redefinir a senha pelo link do
e-mail libera esse bloqueio na hora, já que só quem recebe o e-mail consegue.

## Requisitos

- Node.js 18.17 ou superior (recomendado: 20 ou mais recente): https://nodejs.org
- PostgreSQL 14 ou superior: https://www.postgresql.org/download/

## Comandos úteis

```
npm install          # instala o driver do PostgreSQL e gera o package-lock.json (versione esse arquivo)
npm ci               # em servidores e na integração contínua: instala exatamente o que está no package-lock.json
npm run db:migrate   # cria/atualiza as tabelas
npm run db:seed      # cria as tabelas + insere uma empresa de exemplo
npm start            # inicia o Fluxy (frontend + API), porta 8080
npm test             # suíte completa de testes (precisa do PostgreSQL configurado)
npm run verify       # conferência rápida: sobe, cadastra, entra e apaga a conta de teste
npm run check        # confere a sintaxe de todos os arquivos JavaScript
npm run mail:test -- voce@exemplo.com   # envia um e-mail de teste pelo SMTP configurado
```

Senha válida: de 8 a 128 caracteres, com maiúscula, minúscula e número (ex.:
`Senha1234`). A regra é conferida no navegador e no servidor.

## Testes

`npm test` sobe o servidor de verdade em uma porta livre, usa o PostgreSQL
do `backend/.env` e um servidor de e-mail de mentira (nada sai para a
internet). As contas criadas pelos testes usam o domínio
`@teste.fluxy.invalid` e são apagadas no final. Se o banco não estiver
configurado, só os testes que não dependem dele rodam e o resumo avisa quais
ficaram de fora.

## Publicar em produção

- `NODE_ENV=production`, `DATABASE_URL` e `APP_URL` (endereço público com
  `https://`) são obrigatórios; `SMTP_*` e `MAIL_FROM` ativam a recuperação
  de senha.
- O Fluxy fala HTTP. Coloque-o atrás de um proxy ou plataforma com HTTPS
  (Nginx, Render, Railway...) e ligue `TRUST_PROXY=true`.
- Por padrão o servidor só aceita conexões do próprio computador
  (`API_HOST=127.0.0.1`). Em plataformas que encaminham o tráfego para o
  processo (Render, Railway, Docker), use `API_HOST=0.0.0.0`; a porta pode vir
  de `API_PORT` ou `PORT`.
- O limite de tentativas já é compartilhado pelo PostgreSQL, então pode
  haver mais de uma instância atrás do balanceador.
- Com o site em outro domínio (`CORS_ORIGINS`), o cookie da sessão usa
  `SameSite=None; Secure`, o que exige HTTPS — em produção o servidor se recusa
  a iniciar sem isso.
- O `/health` responde **503** quando o banco está fora do ar (e 200 quando
  está tudo certo): aponte o monitoramento e o balanceador para ele.
- No `frontend/index.html`, troque `<meta name="fluxy-local-mode" content="demo">`
  por `content="off"`: assim ninguém usa o modo local (sem servidor) por engano.
- Faça backup do PostgreSQL (`pg_dump fluxy_db > backup.sql`) antes de
  atualizar. O `schema.sql` só cria o que falta, com uma exceção: clientes ou
  fornecedores **repetidos** (mesmo nome na mesma empresa, ignorando
  maiúsculas) são unidos no cadastro mais antigo antes de criar o índice que
  impede novas repetições. Os campos vazios do mais antigo são completados com
  os dos repetidos, as observações são somadas e vendas, serviços e produtos
  passam a apontar para ele. O terminal mostra quantos foram unidos.
- Nunca rode `npm run db:seed` em produção.

## Apagar todos os dados

```bash
psql -U postgres -c "DROP DATABASE fluxy_db;" -c "CREATE DATABASE fluxy_db;"
npm run db:migrate
```

Para apagar só uma conta, use **Meu perfil → Conta → Excluir conta
permanentemente**: a conta, a empresa e todos os registros dela são
removidos do banco (pede a senha para confirmar).

## Modo local (sem servidor) — só demonstração

Aberto por `file://` ou em hospedagem só de arquivos (GitHub Pages), o Fluxy
funciona como **demonstração**: contas e dados ficam apenas naquele navegador,
com a senha protegida por PBKDF2. Não há servidor garantindo nada — quem usa o
navegador pode ler e alterar os dados —, então **não use com dados reais de
clientes**. A tela avisa isso. Nesse modo não há envio de e-mail nem
recuperação de senha.

Contas locais antigas com a senha em texto puro são convertidas para PBKDF2
assim que a página abre. Para desativar o modo de vez (recomendado em
instalações comerciais), use `<meta name="fluxy-local-mode" content="off">` no
`frontend/index.html`: sem servidor, a tela recusa cadastro e login.

## Backend em C

A pasta `backend/c/` é **experimental, para estudo**: reimplementa só a
autenticação e os dados da empresa, com usuários gravados em arquivo
(`backend/c/LEIA-ME.md` explica a estrutura). Não substitui o backend Node:
clientes, estoque, financeiro e agenda não existem nele. Precisa do OpenSSL para compilar (scrypt, o mesmo formato de
senha do backend Node); o cJSON já vem incluído. Ela não usa o PostgreSQL, não tem as rotas de dados nem envio
de e-mail — é uma versão independente, só para estudo. O backend Node é o
recomendado para uso normal.

## Migração automática (se você já usava o nome antigo)

O projeto se chamava "Skina" antes desta reorganização. A chave antiga
`skina_api_url` do `localStorage` continua sendo copiada para `fluxy_api_url`.
Tokens de sessão guardados no navegador por versões anteriores
(`skina_token`, `fluxy_token`) são apagados: a sessão agora fica no cookie
`HttpOnly`, e quem estava logado entra de novo uma vez.
