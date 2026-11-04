#include "http_response.h"
#include "app_paths.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Mesma politica do backend Node (backend/src/server.js). */
#define CONTENT_SECURITY_POLICY \
    "default-src 'self'; script-src 'self'; " \
    "style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " \
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " \
    "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; " \
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

/* send() pode aceitar so parte dos bytes; sem o laco, arquivos grandes chegavam cortados. */
static int send_all(SOCKET fd, const char *data, size_t len) {
    while (len > 0) {
        int chunk = len > 65536 ? 65536 : (int)len;
        int sent = send(fd, data, chunk, 0);
        if (sent <= 0) return -1;
        data += sent;
        len -= (size_t)sent;
    }
    return 0;
}

void send_response(SOCKET fd, const char *status, const char *contentType,
                   const char *body, size_t len, const char *extraHeaders, int headOnly) {
    char head[2048];
    int n = snprintf(head, sizeof head,
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "X-Content-Type-Options: nosniff\r\n"
        "X-Frame-Options: DENY\r\n"
        "Referrer-Policy: no-referrer\r\n"
        "Content-Security-Policy: " CONTENT_SECURITY_POLICY "\r\n"
        "Cache-Control: no-store\r\n"
        "%s"
        "Connection: close\r\n\r\n",
        status, contentType, len, extraHeaders ? extraHeaders : "");
    if (n < 0 || n >= (int)sizeof head) return;

    if (send_all(fd, head, (size_t)n) != 0) return;
    if (len && !headOnly) send_all(fd, body, len);
}

void send_raw(SOCKET fd, const char *status, const char *contentType, const char *body, size_t len) {
    send_response(fd, status, contentType, body, len, NULL, 0);
}

void send_json_value(SOCKET fd, const char *status, cJSON *value, const char *extraHeaders) {
    char *text = cJSON_PrintUnformatted(value);
    cJSON_Delete(value);
    if (!text) return; /* sem memoria: a conexao fecha sem resposta */
    send_response(fd, status, "application/json; charset=utf-8", text, strlen(text), extraHeaders, 0);
    cJSON_free(text);
}

void send_error(SOCKET fd, const char *status, const char *code, const char *message) {
    cJSON *error = cJSON_CreateObject();
    cJSON_AddStringToObject(error, "error", code);
    cJSON_AddStringToObject(error, "message", message);
    send_json_value(fd, status, error, NULL);
}

void session_cookie_header(char *out, size_t size, const char *token, long maxAgeSeconds) {
    const char *secure = app_cookie_secure() ? "; Secure" : "";
    if (!token || !token[0]) {
        snprintf(out, size, "Set-Cookie: fluxy_session=; Path=/; HttpOnly; SameSite=Strict%s; Max-Age=0\r\n", secure);
    } else if (maxAgeSeconds > 0) {
        snprintf(out, size, "Set-Cookie: fluxy_session=%s; Path=/; HttpOnly; SameSite=Strict%s; Max-Age=%ld\r\n",
                 token, secure, maxAgeSeconds);
    } else {
        snprintf(out, size, "Set-Cookie: fluxy_session=%s; Path=/; HttpOnly; SameSite=Strict%s\r\n", token, secure);
    }
}

static int same_letter(char a, char b) {
    if (a >= 'A' && a <= 'Z') a += 32;
    if (b >= 'A' && b <= 'Z') b += 32;
    return a == b;
}

/* Busca o cabecalho sem diferenciar maiusculas e so no bloco de cabecalhos, nunca no corpo. */
int header_get(const char *request, const char *name, char *out, size_t size) {
    const char *end = strstr(request, "\r\n\r\n");
    const char *line = strstr(request, "\r\n");
    size_t nameLen = strlen(name);
    if (!size) return 0;
    out[0] = 0;

    while (line && (!end || line < end)) {
        line += 2;
        size_t i = 0;
        while (i < nameLen && line[i] && same_letter(line[i], name[i])) i++;
        if (i == nameLen && line[i] == ':') {
            const char *value = line + i + 1;
            while (*value == ' ' || *value == '\t') value++;
            size_t j = 0;
            while (value[j] && value[j] != '\r' && value[j] != '\n' && j + 1 < size) {
                out[j] = value[j];
                j++;
            }
            out[j] = 0;
            return 1;
        }
        line = strstr(line, "\r\n");
    }
    return 0;
}

const char *mime_of(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";

    if (!strcmp(dot, ".html")) return "text/html; charset=utf-8";
    if (!strcmp(dot, ".js"))   return "text/javascript; charset=utf-8";
    if (!strcmp(dot, ".css"))  return "text/css; charset=utf-8";
    if (!strcmp(dot, ".json")) return "application/json; charset=utf-8";
    if (!strcmp(dot, ".png"))  return "image/png";
    if (!strcmp(dot, ".jpg") || !strcmp(dot, ".jpeg")) return "image/jpeg";
    if (!strcmp(dot, ".svg"))  return "image/svg+xml";
    if (!strcmp(dot, ".ico"))  return "image/x-icon";
    if (!strcmp(dot, ".woff2")) return "font/woff2";
    if (!strcmp(dot, ".map"))  return "application/json; charset=utf-8";

    return "application/octet-stream";
}
