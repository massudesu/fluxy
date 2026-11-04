#include "session_store.h"
#include "http_response.h"
#include "platform.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

typedef struct {
    char token[SESSION_TOKEN_HEX_LEN + 1];
    int user_id;
    time_t expires;
} Session;

static Session sessions[SESSION_STORE_MAX];
static fluxy_mutex lock;

void session_store_init(void) {
    MUTEX_INIT(&lock);
}

static int is_active(const Session *session, time_t now) {
    return session->user_id && session->expires > now;
}

SessionCreateResult session_create(int userId, int remember, char tokenOut[SESSION_TOKEN_HEX_LEN + 1]) {
    if (random_hex(tokenOut, SESSION_TOKEN_HEX_LEN / 2) != 0) return SESSION_NO_RANDOMNESS;

    SessionCreateResult result = SESSION_STORE_FULL;
    time_t now = time(NULL);
    MUTEX_LOCK(&lock);

    for (int i = 0; i < SESSION_STORE_MAX; i++) {
        if (is_active(&sessions[i], now)) continue;
        snprintf(sessions[i].token, sizeof sessions[i].token, "%s", tokenOut);
        sessions[i].user_id = userId;
        sessions[i].expires = now + (remember ? SESSION_REMEMBER_SECONDS : SESSION_DEFAULT_SECONDS);
        result = SESSION_CREATED;
        break;
    }

    MUTEX_UNLOCK(&lock);
    return result;
}

static int is_token(const char *value) {
    size_t i = 0;
    for (; value[i]; i++) {
        char c = value[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    }
    return i == SESSION_TOKEN_HEX_LEN;
}

static int session_token_from_request(const char *request, char tokenOut[SESSION_TOKEN_HEX_LEN + 1]) {
    char cookies[2048];
    if (!header_get(request, "Cookie", cookies, sizeof cookies)) return 0;

    for (char *part = cookies; part; ) {
        char *next = strchr(part, ';');
        if (next) *next++ = 0;
        while (*part == ' ') part++;
        if (strncmp(part, "fluxy_session=", 14) == 0) {
            char *value = part + 14;
            char *end = value + strlen(value);
            while (end > value && end[-1] == ' ') *--end = 0;
            if (!is_token(value)) return 0;
            memcpy(tokenOut, value, SESSION_TOKEN_HEX_LEN + 1);
            return 1;
        }
        part = next;
    }
    return 0;
}

/* Chamado com o bloqueio ja adquirido. */
static Session *find_active_locked(const char *token) {
    time_t now = time(NULL);
    for (int i = 0; i < SESSION_STORE_MAX; i++) {
        if (is_active(&sessions[i], now) && constant_time_equals(sessions[i].token, token, SESSION_TOKEN_HEX_LEN)) {
            return &sessions[i];
        }
    }
    return NULL;
}

int session_user_id_from_request(const char *request) {
    char token[SESSION_TOKEN_HEX_LEN + 1];
    if (!session_token_from_request(request, token)) return 0;

    MUTEX_LOCK(&lock);
    Session *session = find_active_locked(token);
    int userId = session ? session->user_id : 0;
    MUTEX_UNLOCK(&lock);
    return userId;
}

void session_revoke_from_request(const char *request) {
    char token[SESSION_TOKEN_HEX_LEN + 1];
    if (!session_token_from_request(request, token)) return;

    MUTEX_LOCK(&lock);
    Session *session = find_active_locked(token);
    if (session) memset(session, 0, sizeof *session);
    MUTEX_UNLOCK(&lock);
}
