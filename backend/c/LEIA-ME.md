# Backend Fluxy em C (experimental)

Versao de estudo das rotas de autenticacao do backend Node (`backend/src/`).
Tambem serve o frontend, mas **nao substitui o Node**: sem as rotas de dados, o
painel abre avisando que nao conseguiu carregar clientes, estoque, financeiro
e agenda (veja as diferencas no final).

```
backend/c/
├── include/        # cabecalhos (.h) - a interface publica de cada modulo
│   ├── platform.h       # abstracao Windows/POSIX (sockets, threads, mutex)
│   ├── crypto.h          # senhas (scrypt), tokens e comparacao segura - via OpenSSL
│   ├── json_util.h       # leitura de JSON sobre o cJSON
│   ├── atomic_file.h     # gravacao segura em arquivo (sem perder o anterior)
│   ├── app_paths.h       # onde ficam o frontend e os dados; porta; cookie Secure
│   ├── user_store.h      # cadastro de usuarios (arquivo em disco)
│   ├── session_store.h   # sessoes (em memoria)
│   ├── rate_limit.h      # limite de tentativas de login e cadastro (em memoria)
│   ├── http_response.h   # respostas HTTP, cookies e cabecalhos
│   ├── static_files.h    # servidor de arquivos estaticos
│   └── routes.h          # rotas da API
├── src/             # implementacao (.c) de cada modulo acima, mais main.c
└── vendor/cjson/    # cJSON 1.7.18 (MIT), copiado sem alteracoes
```

## Dependencias

- **OpenSSL 1.1.1 ou 3.x** (`libcrypto`): scrypt para as senhas,
  `RAND_bytes` para os tokens e `CRYPTO_memcmp` para comparar sem vazar tempo.
  Substitui o SHA-256 escrito a mao das versoes anteriores.
- **cJSON 1.7.18**, ja incluido em `vendor/cjson` (dois arquivos, licenca MIT
  em `vendor/cjson/LICENSE`). Nao precisa instalar nada.

## Compilar

**Windows** — MinGW-w64 pelo MSYS2 (https://www.msys2.org/), no terminal
"UCRT64":

```
pacman -S mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-openssl
build.bat
```

**Linux / macOS**

```
sudo apt install build-essential libssl-dev    # Debian/Ubuntu
brew install openssl@3                         # macOS
./build.sh
```

## Rodar

Windows: `iniciar-fluxy-c.bat` (ou `fluxy-api.exe`) · Linux/macOS: `./fluxy-api`

Sobe em http://localhost:8080, aceitando so conexoes do proprio computador.
Para outra porta: `./fluxy-api 9090` (ou a variavel `API_PORT`).

Cada conexao e atendida numa thread propria, com no maximo 64 ao mesmo
tempo (as excedentes recebem 503). Cada uma tem 10 s de espera por leitura
ou escrita e 15 s no total para enviar a requisicao, entao um cliente lento
ou parado nao trava os outros. Cabecalhos ate 16 KB e corpo ate 100 KB (acima
disso, 413).

## Onde ficam os dados

`../database/data/fluxy-users.db` — texto, um usuario por linha, campos
separados por TAB: id, nome, e-mail, telefone, CPF, salt, hash, pergunta,
salt da resposta, hash da resposta, data.

No Linux/macOS a pasta de dados e criada com `0700` e os arquivos com `0600`
(so o dono le); um `fluxy-users.db` de versoes anteriores com `0644` e
corrigido ao iniciar. No Windows valem as permissoes herdadas da pasta.

A gravacao vai para `fluxy-users.db.tmp`, confere cada etapa (escrita, envio
ao disco, fechamento) e so entao substitui o arquivo original numa unica
operacao. Se algo falhar, o arquivo anterior fica intacto e o cadastro e
recusado com erro, sem abrir sessao. Se o arquivo existir mas nao puder ser
lido, o servidor nao inicia (seguir com a lista vazia apagaria os usuarios
na proxima gravacao).

Instalacoes antigas com dados em `skina-users.db` sao migradas
automaticamente (uma unica vez) para `fluxy-users.db`.

Os dados da empresa ficam em um arquivo por conta,
`fluxy-company-<id da conta>.json`. Versoes anteriores gravavam um unico
`fluxy-company.json` compartilhado por todas as contas; ele e mantido intacto,
mas nao e mais lido, porque nao ha como saber de qual conta ele era. Para
aproveita-lo, renomeie-o para `fluxy-company-<id>.json` (o id esta na primeira
coluna de `fluxy-users.db`).

## Senhas

Senhas novas usam **scrypt** (N=16384, r=8, p=1, 64 bytes, salt aleatorio de
16 bytes), exatamente o formato do backend Node: o mesmo hash confere nos dois.

Contas gravadas pelas versoes anteriores (SHA-256 com 120.000 rodadas) nao
precisam de nada: no primeiro login certo, a senha e conferida no formato
antigo e regravada em scrypt na hora. Contas que nunca mais entrarem ficam no
formato antigo; para elimina-lo de vez, peca que essas pessoas entrem uma vez
ou cadastrem uma nova senha.

## Rotas

`GET /health` · `POST /api/auth/register` · `POST /api/auth/login` ·
`POST /api/auth/logout` · `GET /api/me` · `GET|POST /api/company` (exige login)

As rotas de recuperacao de senha respondem que o recurso nao existe nesta
versao (501) e a antiga rota da pergunta de seguranca foi desativada (410).
Corpos que nao sao um objeto JSON valido recebem 400 (`invalid_json`); campos
de tipo errado ou maiores que o limite sao recusados, nunca cortados.

## Sessao

Igual ao backend Node: o token (32 bytes aleatorios) vai no cookie
`fluxy_session` (`HttpOnly`, `SameSite=Strict`), nunca no corpo da resposta, e
toda requisicao que altera dados precisa do cabecalho `X-Fluxy-Request: 1`
(protecao contra CSRF). O frontend ja envia esse cabecalho.

- Sem "manter conectado": cookie de sessao do navegador, valido por 12 horas no
  servidor. Com a opcao: 30 dias (`Max-Age`).
- Logout encerra so a sessao atual; os outros aparelhos continuam conectados.
- `Secure` e acrescentado quando o site e servido por HTTPS (um proxy na
  frente): defina `COOKIE_SECURE=1` ou `APP_URL=https://...`. Em
  `http://localhost` fica sem `Secure`, senao o navegador descartaria o cookie.
- Ate 2000 sessoes ativas. Posicoes livres ou vencidas sao reutilizadas; com
  todas ocupadas por sessoes validas, o login responde 503 em vez de derrubar
  a sessao de outra pessoa.

```
curl -i -X POST -H 'X-Fluxy-Request: 1' http://localhost:8080/api/auth/login \
     -d '{"email":"voce@exemplo.com","password":"Senha1234"}'
curl -H 'Cookie: fluxy_session=<valor do Set-Cookie>' http://localhost:8080/api/me
```

## Limite de tentativas

Os mesmos limites do backend Node, contados por IP e por e-mail numa janela de
tempo, em memoria compartilhada entre as threads (reiniciar o servidor zera
os contadores, como as sessoes):

- 50 tentativas de login por IP a cada 15 minutos;
- 5 senhas erradas por e-mail e IP, e 20 por e-mail vindas de qualquer IP, a cada
  15 minutos — e-mails inexistentes contam igual, para nao revelar quem tem conta;
- 20 cadastros por IP por hora (o Node permite 10; aqui todo acesso vem do proprio
  computador, entao o limite vale para a maquina inteira).

A tentativa e contada antes de conferir a senha: pedidos enviados ao mesmo
tempo nao passam juntos pelo limite. Acertar a senha zera a contagem daquele
e-mail. Bloqueado, o login responde 429 com `Retry-After`.

Cabem 4096 contadores. Um contador ativo nunca e descartado para abrir espaco
(isso deixaria zerar o bloqueio de outra conta criando chaves novas): com a
tabela cheia, a tentativa recebe 503 ate algum contador vencer.

O limite de 20 falhas por e-mail tambem bloqueia a dona da conta enquanto
durar a janela de 15 minutos. No backend Node, redefinir a senha pelo e-mail
libera esse bloqueio; aqui nao ha recuperacao por e-mail, entao e preciso
esperar a janela.

## Testes

`npm test` (na raiz do projeto) compila este backend numa pasta temporaria e
roda `tests/backend-c.test.js` contra o executavel. Sem gcc ou OpenSSL na
maquina, esse arquivo e pulado com aviso.

## Diferencas em relacao ao backend Node

- Sessoes ficam em memoria: ao reiniciar o servidor, e preciso logar de
  novo (os usuarios continuam salvos em disco).
- Nao envia e-mail, entao nao ha recuperacao de senha (ela existe apenas
  no backend Node). O cadastro nao pede mais pergunta de seguranca; as
  colunas antigas do arquivo de usuarios sao mantidas, sem uso.
- Nao tem as rotas de dados (clientes, estoque, financeiro, agenda...). Use
  apenas para estudo, no proprio computador.
