#!/usr/bin/env bash
# Inicia o Fluxy (site + API Node.js na mesma porta). Uso: ./iniciar-fluxy.sh
cd "$(dirname "$0")" || exit 1
if [ ! -d node_modules/pg ]; then
  echo '[Fluxy] Dependencias nao instaladas. Rode "npm install" nesta pasta uma vez.'
  exit 1
fi
exec node backend/src/index.js
