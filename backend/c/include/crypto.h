#ifndef FLUXY_CRYPTO_H
#define FLUXY_CRYPTO_H

#include <stddef.h>

#define PASSWORD_SALT_HEX_LEN 32
#define PASSWORD_HASH_HEX_LEN 128
#define SESSION_TOKEN_HEX_LEN 64

/* 0 em sucesso; out precisa de 2 * bytes + 1 posicoes. */
int random_hex(char *out, size_t bytes);

/* scrypt no mesmo formato do backend Node (o hash confere nos dois). 0 em sucesso. */
int password_hash(const char *password, char salt_hex[PASSWORD_SALT_HEX_LEN + 1],
                  char hash_hex[PASSWORD_HASH_HEX_LEN + 1]);

/* 1 = confere. Aceita tambem o formato antigo (SHA-256 iterado), para migrar no login. */
int password_verify(const char *password, const char *salt_hex, const char *hash_hex);

int password_needs_rehash(const char *hash_hex);

/* Login com e-mail inexistente gasta o mesmo tempo, para nao revelar quem tem conta. */
void password_simulate_check(const char *password);

int constant_time_equals(const char *a, const char *b, size_t len);

#endif
