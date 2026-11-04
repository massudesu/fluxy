#ifndef FLUXY_HTTP_RESPONSE_H
#define FLUXY_HTTP_RESPONSE_H

#include <stddef.h>
#include "platform.h"
#include "cJSON.h"

/* extraHeaders: linhas completas terminadas em \r\n, ou NULL. headOnly omite o corpo (HEAD). */
void send_response(SOCKET fd, const char *status, const char *contentType,
                   const char *body, size_t len, const char *extraHeaders, int headOnly);

void send_raw(SOCKET fd, const char *status, const char *contentType, const char *body, size_t len);

/* Libera value. */
void send_json_value(SOCKET fd, const char *status, cJSON *value, const char *extraHeaders);

void send_error(SOCKET fd, const char *status, const char *code, const char *message);

/* Monta "Set-Cookie: ..." para a sessao (token vazio apaga o cookie). maxAgeSeconds 0 = cookie de sessao. */
void session_cookie_header(char *out, size_t size, const char *token, long maxAgeSeconds);

int header_get(const char *request, const char *name, char *out, size_t size);

const char *mime_of(const char *path);

#endif
