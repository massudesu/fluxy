#include "app_paths.h"
#include "http_response.h"
#include "json_util.h"
#include "rate_limit.h"
#include "platform.h"
#include "routes.h"
#include "session_store.h"
#include "static_files.h"
#include "user_store.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_HEADER_BYTES (16 * 1024)
#define MAX_BODY_BYTES (100 * 1024)
#define MAX_REQUEST_BYTES (MAX_HEADER_BYTES + MAX_BODY_BYTES)
#define MAX_CONNECTIONS 64
#define SOCKET_TIMEOUT_SECONDS 10
#define REQUEST_DEADLINE_SECONDS 15

static fluxy_mutex connections_lock;
static int active_connections = 0;

typedef enum { READ_OK, READ_CLOSED, READ_TOO_LARGE, READ_BAD_REQUEST } ReadResult;

/* Le cabecalhos e corpo respeitando os limites. O prazo total impede que um cliente que manda
   um byte por vez segure a thread indefinidamente. */
static ReadResult read_request(SOCKET fd, char *request, size_t *headerLengthOut, size_t *bodyLengthOut) {
    time_t deadline = time(NULL) + REQUEST_DEADLINE_SECONDS;
    size_t total = 0;
    char *headerEnd = NULL;

    while (!headerEnd) {
        if (time(NULL) > deadline) return READ_CLOSED;
        if (total >= MAX_HEADER_BYTES) return READ_TOO_LARGE;
        int received = recv(fd, request + total, (int)(MAX_HEADER_BYTES - total), 0);
        if (received <= 0) return READ_CLOSED;
        total += (size_t)received;
        request[total] = 0;
        headerEnd = strstr(request, "\r\n\r\n");
    }

    size_t headerLength = (size_t)(headerEnd - request) + 4;
    size_t bodyLength = 0;
    char value[32];
    if (header_get(request, "Content-Length", value, sizeof value)) {
        char *end = NULL;
        long parsed = strtol(value, &end, 10);
        if (end == value || *end || parsed < 0) return READ_BAD_REQUEST;
        if (parsed > MAX_BODY_BYTES) return READ_TOO_LARGE;
        bodyLength = (size_t)parsed;
    }

    while (total < headerLength + bodyLength) {
        if (time(NULL) > deadline) return READ_CLOSED;
        int received = recv(fd, request + total, (int)(headerLength + bodyLength - total), 0);
        if (received <= 0) return READ_CLOSED;
        total += (size_t)received;
    }
    request[headerLength + bodyLength] = 0;

    *headerLengthOut = headerLength;
    *bodyLengthOut = bodyLength;
    return READ_OK;
}

static int reserve_connection(void) {
    MUTEX_LOCK(&connections_lock);
    int allowed = active_connections < MAX_CONNECTIONS;
    if (allowed) active_connections++;
    MUTEX_UNLOCK(&connections_lock);
    return allowed;
}

static void release_connection(void) {
    MUTEX_LOCK(&connections_lock);
    active_connections--;
    MUTEX_UNLOCK(&connections_lock);
}

typedef struct {
    SOCKET fd;
    char ip[16];
} Connection;

static void handle_connection(void *arg) {
    Connection connection = *(Connection *)arg;
    free(arg);
    SOCKET fd = connection.fd;
    char *request = malloc(MAX_REQUEST_BYTES + 1);

    if (request) {
        size_t headerLength = 0, bodyLength = 0;
        ReadResult result = read_request(fd, request, &headerLength, &bodyLength);

        if (result == READ_TOO_LARGE) {
            send_error(fd, "413 Payload Too Large", "payload_too_large", "Os dados enviados sao grandes demais.");
        } else if (result == READ_BAD_REQUEST) {
            send_error(fd, "400 Bad Request", "invalid_request", "Requisicao invalida.");
        } else if (result == READ_OK) {
            char method[16] = {0};
            char path[1024] = {0};
            if (sscanf(request, "%15s %1023s", method, path) != 2) {
                send_error(fd, "400 Bad Request", "invalid_request", "Requisicao invalida.");
            } else {
                char *queryString = strchr(path, '?');
                if (queryString) *queryString = 0;

                if (!strncmp(path, "/api/", 5) || !strcmp(path, "/health")) {
                    handle_api(fd, connection.ip, method, path, request, request + headerLength, bodyLength);
                } else {
                    serve_static(fd, method, path);
                }
            }
        }
        free(request);
    }

    CLOSESOCK(fd);
    release_connection();
}

int main(int argc, char **argv) {
    app_paths_init(argc, argv);
    MUTEX_INIT(&connections_lock);
    session_store_init();
    routes_init();
    rate_limit_init();
    json_util_init();

    if (user_store_load() != 0) {
        /* Seguir com a lista vazia faria a proxima gravacao apagar os usuarios do arquivo. */
        fprintf(stderr, "[Fluxy-C] nao foi possivel ler %s; o servidor nao foi iniciado\n", app_db_path());
        return 1;
    }

    SOCKET serverSocket = socket(AF_INET, SOCK_STREAM, 0);
    if (serverSocket == INVALID_SOCKET) {
        fprintf(stderr, "[Fluxy-C] falha ao criar socket\n");
        return 1;
    }

    int reuseAddr = 1;
    setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuseAddr, sizeof reuseAddr);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    addr.sin_port = htons((unsigned short)app_port());

    if (bind(serverSocket, (struct sockaddr *)&addr, sizeof addr) != 0) {
        fprintf(stderr, "[Fluxy-C] a porta %d ja esta em uso.\n", app_port());
        return 1;
    }

    listen(serverSocket, 64);

    printf("[Fluxy-C] API em C ONLINE\n");
    printf("[Fluxy-C] site ......: http://localhost:%d/index.html\n", app_port());
    printf("[Fluxy-C] banco .....: %s (%d usuarios)\n", app_db_path(), user_store_count());
    printf("[Fluxy-C] encerrar ..: Ctrl+C\n");
    fflush(stdout);

    for (;;) {
        struct sockaddr_in clientAddr;
        socklen_t clientLen = sizeof clientAddr;
        SOCKET clientFd = accept(serverSocket, (struct sockaddr *)&clientAddr, &clientLen);
        if (clientFd == INVALID_SOCKET) continue;

        set_socket_timeouts(clientFd, SOCKET_TIMEOUT_SECONDS);
        if (!reserve_connection()) {
            send_error(clientFd, "503 Service Unavailable", "server_busy", "Servidor ocupado. Tente novamente em instantes.");
            CLOSESOCK(clientFd);
            continue;
        }
        Connection *connection = malloc(sizeof *connection);
        if (connection) {
            const unsigned char *b = (const unsigned char *)&clientAddr.sin_addr;
            connection->fd = clientFd;
            snprintf(connection->ip, sizeof connection->ip, "%u.%u.%u.%u", b[0], b[1], b[2], b[3]);
        }
        if (!connection || start_detached_thread(handle_connection, connection) != 0) {
            free(connection);
            release_connection();
            CLOSESOCK(clientFd);
        }
    }
}
