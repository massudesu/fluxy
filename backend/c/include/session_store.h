#ifndef FLUXY_SESSION_STORE_H
#define FLUXY_SESSION_STORE_H

#include "crypto.h"

#ifndef SESSION_STORE_MAX
#define SESSION_STORE_MAX 2000
#endif
#define SESSION_DEFAULT_SECONDS (12L * 3600)
#define SESSION_REMEMBER_SECONDS (30L * 24 * 3600)

typedef enum {
    SESSION_CREATED,
    SESSION_STORE_FULL,
    SESSION_NO_RANDOMNESS
} SessionCreateResult;

void session_store_init(void);

/* Usa uma posicao livre ou vencida; com todas ocupadas, recusa em vez de derrubar outra sessao. */
SessionCreateResult session_create(int userId, int remember, char tokenOut[SESSION_TOKEN_HEX_LEN + 1]);

/* 0 quando nao ha sessao valida no cookie fluxy_session. */
int session_user_id_from_request(const char *request);

void session_revoke_from_request(const char *request);

#endif
