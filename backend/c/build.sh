#!/bin/sh
# Compila o backend em C (Linux/macOS). Gera o executavel fluxy-api nesta pasta.
# Requer o OpenSSL (scrypt e numeros aleatorios):
#   Debian/Ubuntu: sudo apt install libssl-dev   ·   macOS: brew install openssl@3
# Uso: ./build.sh && ./fluxy-api
set -e

cd "$(dirname "$0")"

OPENSSL_FLAGS=""
if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists libcrypto; then
    OPENSSL_FLAGS="$(pkg-config --cflags --libs libcrypto)"
elif command -v brew >/dev/null 2>&1 && [ -d "$(brew --prefix openssl@3 2>/dev/null)" ]; then
    OPENSSL_PREFIX="$(brew --prefix openssl@3)"
    OPENSSL_FLAGS="-I$OPENSSL_PREFIX/include -L$OPENSSL_PREFIX/lib -lcrypto"
else
    OPENSSL_FLAGS="-lcrypto"
fi

gcc -Wall -Wextra -std=c11 -O2 -D_POSIX_C_SOURCE=200809L -pthread \
    -Iinclude -Ivendor/cjson \
    src/*.c vendor/cjson/cJSON.c \
    $OPENSSL_FLAGS \
    -o fluxy-api

echo "Build concluido: backend/c/fluxy-api"
