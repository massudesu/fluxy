#include "rate_limit.h"
#include "platform.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#ifndef RATE_LIMIT_MAX_KEYS
#define RATE_LIMIT_MAX_KEYS 4096
#endif

typedef struct {
    char key[200];
    int count;
    time_t reset_at;
} Counter;

static Counter counters[RATE_LIMIT_MAX_KEYS];
static fluxy_mutex lock;

void rate_limit_init(void) {
    MUTEX_INIT(&lock);
}

static int seconds_left(const Counter *counter, time_t now) {
    long left = (long)(counter->reset_at - now);
    return left > 0 ? (int)left : 1;
}

/* Chamado com o bloqueio ja adquirido. */
static Counter *find_locked(const char *key, time_t now) {
    for (int i = 0; i < RATE_LIMIT_MAX_KEYS; i++) {
        if (counters[i].key[0] && counters[i].reset_at > now && !strcmp(counters[i].key, key)) return &counters[i];
    }
    return NULL;
}

/* Contadores ativos nunca sao descartados: liberar espaco expulsando um deles deixaria um
   atacante zerar o bloqueio de outra conta criando chaves novas. NULL = tabela cheia. */
static Counter *slot_for_new_key_locked(time_t now) {
    for (int i = 0; i < RATE_LIMIT_MAX_KEYS; i++) {
        if (!counters[i].key[0] || counters[i].reset_at <= now) return &counters[i];
    }
    return NULL;
}

static Counter *hit_locked(const char *key, int windowSeconds, time_t now) {
    Counter *counter = find_locked(key, now);
    if (!counter) {
        counter = slot_for_new_key_locked(now);
        if (!counter) return NULL;
        snprintf(counter->key, sizeof counter->key, "%s", key);
        counter->count = 0;
        counter->reset_at = now + windowSeconds;
    }
    counter->count++;
    return counter;
}

int rate_limit_consume(const char *key, int max, int windowSeconds) {
    time_t now = time(NULL);
    MUTEX_LOCK(&lock);
    Counter *counter = hit_locked(key, windowSeconds, now);
    int seconds = !counter ? RATE_LIMIT_FULL : counter->count > max ? seconds_left(counter, now) : 0;
    MUTEX_UNLOCK(&lock);
    return seconds;
}

void rate_limit_reset(const char *key) {
    time_t now = time(NULL);
    MUTEX_LOCK(&lock);
    Counter *counter = find_locked(key, now);
    if (counter) memset(counter, 0, sizeof *counter);
    MUTEX_UNLOCK(&lock);
}
