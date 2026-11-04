#include "app_paths.h"
#include "atomic_file.h"
#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char project_root[480];
static char web_root[512];
static char db_path[576];
static char legacy_db_path[576];
static char data_dir[540];
static int port = APP_PORT_DEFAULT;

static int cookie_secure = 0;

static void ensure_dir_exists(const char *path) {
    MKDIR(path);
}

static int env_is_true(const char *name) {
    const char *value = getenv(name);
    if (!value) return 0;
    return !strcmp(value, "1") || !strcmp(value, "true") || !strcmp(value, "yes")
        || !strcmp(value, "sim") || !strcmp(value, "on");
}

/* Copia skina-users.db para fluxy-users.db uma unica vez, sem nunca gravar um arquivo pela metade. */
static void migrate_legacy_db_if_needed(void) {
    FILE *current = fopen(db_path, "r");
    if (current) { fclose(current); return; }

    const size_t maxBytes = 8 * 1024 * 1024;
    char *buffer = malloc(maxBytes);
    if (!buffer) return;

    long length = read_whole_file(legacy_db_path, buffer, maxBytes);
    if (length > 0 && atomic_write_file(db_path, buffer, (size_t)length) != 0) {
        fprintf(stderr, "[Fluxy-C] nao foi possivel migrar %s; o arquivo antigo foi mantido\n", legacy_db_path);
    }
    free(buffer);
}

void app_paths_init(int argc, char **argv) {
    const char *envPort = getenv("API_PORT");
    if (envPort) port = atoi(envPort);
    if (argc > 1) port = atoi(argv[1]);
    if (port <= 0) port = APP_PORT_DEFAULT;

    const char *root = getenv("FLUXY_ROOT");
    if (!root) root = getenv("SKINA_ROOT");
    snprintf(project_root, sizeof project_root, "%s", root ? root : "../..");

    snprintf(web_root, sizeof web_root, "%s/frontend", project_root);

    snprintf(data_dir, sizeof data_dir, "%s/backend/database/data", project_root);
    snprintf(db_path, sizeof db_path, "%s/fluxy-users.db", data_dir);
    snprintf(legacy_db_path, sizeof legacy_db_path, "%s/skina-users.db", data_dir);

    char backendDir[520];
    snprintf(backendDir, sizeof backendDir, "%s/backend", project_root);
    ensure_dir_exists(backendDir);
    char databaseDir[540];
    snprintf(databaseDir, sizeof databaseDir, "%s/backend/database", project_root);
    ensure_dir_exists(databaseDir);
    ensure_dir_exists(data_dir);
#ifndef _WIN32
    chmod(data_dir, 0700); /* pasta criada por versoes anteriores com 0755 */
#endif

    migrate_legacy_db_if_needed();

    const char *appUrl = getenv("APP_URL");
    cookie_secure = env_is_true("COOKIE_SECURE") || (appUrl && !strncmp(appUrl, "https://", 8));

#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#else
    signal(SIGPIPE, SIG_IGN);
#endif
}

const char *app_web_root(void) { return web_root; }
const char *app_db_path(void) { return db_path; }
int app_company_path(int userId, char *out, size_t size) {
    int n = snprintf(out, size, "%s/fluxy-company-%d.json", data_dir, userId);
    return n > 0 && (size_t)n < size ? 0 : -1;
}
int app_port(void) { return port; }
int app_cookie_secure(void) { return cookie_secure; }
