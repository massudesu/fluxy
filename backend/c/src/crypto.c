#include "crypto.h"

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

#include <string.h>

#define SCRYPT_N 16384
#define SCRYPT_R 8
#define SCRYPT_P 1
#define SCRYPT_MAX_MEM (64UL * 1024 * 1024)
#define SCRYPT_KEY_BYTES 64

#define LEGACY_HASH_HEX_LEN 64
#define LEGACY_ROUNDS 120000

static void to_hex(const unsigned char *in, size_t n, char *out) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[i * 2] = digits[in[i] >> 4];
        out[i * 2 + 1] = digits[in[i] & 15];
    }
    out[n * 2] = 0;
}

int random_hex(char *out, size_t bytes) {
    unsigned char raw[64];
    if (bytes > sizeof raw || RAND_bytes(raw, (int)bytes) != 1) return -1;
    to_hex(raw, bytes, out);
    OPENSSL_cleanse(raw, sizeof raw);
    return 0;
}

int constant_time_equals(const char *a, const char *b, size_t len) {
    return CRYPTO_memcmp(a, b, len) == 0;
}

/* O salt entra como texto hex (e nao como os bytes decodificados), igual ao crypto.scrypt do Node. */
static int scrypt_hex(const char *password, const char *salt_hex, char out_hex[PASSWORD_HASH_HEX_LEN + 1]) {
    unsigned char key[SCRYPT_KEY_BYTES];
    int ok = EVP_PBE_scrypt(password, strlen(password),
                            (const unsigned char *)salt_hex, strlen(salt_hex),
                            SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_MAX_MEM,
                            key, sizeof key);
    if (ok != 1) return -1;
    to_hex(key, sizeof key, out_hex);
    OPENSSL_cleanse(key, sizeof key);
    return 0;
}

/* Formato das versoes anteriores: sha256(salt ":" senha) e 120.000 rodadas de sha256(digest || salt). */
static int legacy_hash_hex(const char *password, const char *salt_hex, char out_hex[LEGACY_HASH_HEX_LEN + 1]) {
    unsigned char digest[32];
    unsigned int length = 0;
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    if (!ctx) return -1;

    int ok = EVP_DigestInit_ex(ctx, EVP_sha256(), NULL)
        && EVP_DigestUpdate(ctx, salt_hex, strlen(salt_hex))
        && EVP_DigestUpdate(ctx, ":", 1)
        && EVP_DigestUpdate(ctx, password, strlen(password))
        && EVP_DigestFinal_ex(ctx, digest, &length);

    for (int i = 0; ok && i < LEGACY_ROUNDS; i++) {
        ok = EVP_DigestInit_ex(ctx, EVP_sha256(), NULL)
            && EVP_DigestUpdate(ctx, digest, sizeof digest)
            && EVP_DigestUpdate(ctx, salt_hex, strlen(salt_hex))
            && EVP_DigestFinal_ex(ctx, digest, &length);
    }
    EVP_MD_CTX_free(ctx);
    if (!ok) return -1;

    to_hex(digest, sizeof digest, out_hex);
    return 0;
}

int password_hash(const char *password, char salt_hex[PASSWORD_SALT_HEX_LEN + 1],
                  char hash_hex[PASSWORD_HASH_HEX_LEN + 1]) {
    if (random_hex(salt_hex, PASSWORD_SALT_HEX_LEN / 2) != 0) return -1;
    return scrypt_hex(password, salt_hex, hash_hex);
}

int password_needs_rehash(const char *hash_hex) {
    return strlen(hash_hex) == LEGACY_HASH_HEX_LEN;
}

int password_verify(const char *password, const char *salt_hex, const char *hash_hex) {
    size_t stored = strlen(hash_hex);
    if (!salt_hex[0]) return 0;

    if (stored == PASSWORD_HASH_HEX_LEN) {
        char computed[PASSWORD_HASH_HEX_LEN + 1];
        return scrypt_hex(password, salt_hex, computed) == 0
            && constant_time_equals(computed, hash_hex, PASSWORD_HASH_HEX_LEN);
    }
    if (stored == LEGACY_HASH_HEX_LEN) {
        char computed[LEGACY_HASH_HEX_LEN + 1];
        return legacy_hash_hex(password, salt_hex, computed) == 0
            && constant_time_equals(computed, hash_hex, LEGACY_HASH_HEX_LEN);
    }
    return 0;
}

void password_simulate_check(const char *password) {
    char ignored[PASSWORD_HASH_HEX_LEN + 1];
    scrypt_hex(password, "fluxy-conta-inexistente", ignored);
}
