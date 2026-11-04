#ifndef FLUXY_APP_PATHS_H
#define FLUXY_APP_PATHS_H

#include <stddef.h>

#define APP_PORT_DEFAULT 8080

void app_paths_init(int argc, char **argv);

const char *app_web_root(void);
const char *app_db_path(void);
/* Um arquivo por conta: cada cadastro e dono da propria empresa, como no backend Node. */
int app_company_path(int userId, char *out, size_t size);
int app_port(void);

/* Cookie com Secure quando o site e servido por HTTPS (proxy na frente): COOKIE_SECURE=1 ou APP_URL https. */
int app_cookie_secure(void);

#endif
