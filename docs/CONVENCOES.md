# Convenções de nomes

O projeto mistura português e inglês por razões históricas. Renomear tudo de
uma vez quebraria o frontend, os dados já guardados no navegador e
integrações. A regra é por camada:

| Camada | Idioma |
|---|---|
| Funções e variáveis (backend e frontend) | inglês |
| Banco de dados, endereços da API e campos JSON | como estão (português, contrato) |
| Mensagens para a pessoa usuária | português |

Mudar um campo JSON exige aceitar o nome antigo e o novo por um tempo,
migrar o frontend e só depois remover o antigo — um campo por vez.

## Dinheiro

`NUMERIC(12,2)` no banco, texto entre o driver e o código, somas no
PostgreSQL ou em centavos inteiros no navegador. Campos terminados em `Cents`
são sempre centavos inteiros.
