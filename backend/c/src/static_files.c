#include "static_files.h"
#include "app_paths.h"
#include "http_response.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_STATIC_FILE_BYTES (16L * 1024 * 1024)

static const char NOT_FOUND_PAGE[] = "<h1>404</h1><p>Arquivo nao encontrado. <a href=\"/index.html\">Voltar ao inicio</a></p>";

static void send_not_found(SOCKET fd) {
    send_raw(fd, "404 Not Found", "text/html; charset=utf-8", NOT_FOUND_PAGE, sizeof NOT_FOUND_PAGE - 1);
}

void serve_static(SOCKET fd, const char *method, const char *urlPath) {
    int headOnly = !strcmp(method, "HEAD");
    if (!headOnly && strcmp(method, "GET")) {
        send_response(fd, "405 Method Not Allowed", "text/plain", "Method Not Allowed", 18, "Allow: GET, HEAD\r\n", 0);
        return;
    }
    if (strstr(urlPath, "..") || strchr(urlPath, '\\') || strchr(urlPath, '%')) {
        send_raw(fd, "403 Forbidden", "text/plain", "Forbidden", 9);
        return;
    }

    char path[1024];
    int written = snprintf(path, sizeof path, "%s%s", app_web_root(), strcmp(urlPath, "/") ? urlPath : "/index.html");
    if (written < 0 || written >= (int)sizeof path) {
        send_not_found(fd);
        return;
    }

    FILE *file = fopen(path, "rb");
    if (!file) {
        send_not_found(fd);
        return;
    }

    long size = fseek(file, 0, SEEK_END) == 0 ? ftell(file) : -1;
    /* Pastas e arquivos ilegiveis devolvem tamanho invalido e caem no 404. */
    char *buffer = (size >= 0 && size < MAX_STATIC_FILE_BYTES) ? malloc(size ? (size_t)size : 1) : NULL;
    size_t bytesRead = 0;
    if (buffer && fseek(file, 0, SEEK_SET) == 0) bytesRead = fread(buffer, 1, (size_t)size, file);
    fclose(file);

    if (!buffer || bytesRead != (size_t)size) {
        free(buffer);
        send_not_found(fd);
        return;
    }

    send_response(fd, "200 OK", mime_of(path), buffer, bytesRead, NULL, headOnly);
    free(buffer);
}
