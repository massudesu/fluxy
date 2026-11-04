#ifndef FLUXY_ROUTES_H
#define FLUXY_ROUTES_H

#include <stddef.h>
#include "platform.h"

void routes_init(void);

void handle_api(SOCKET fd, const char *clientIp, const char *method, const char *path, const char *headers,
                const char *body, size_t bodyLength);

#endif
