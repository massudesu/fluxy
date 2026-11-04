#ifndef FLUXY_STATIC_FILES_H
#define FLUXY_STATIC_FILES_H

#include "platform.h"

void serve_static(SOCKET fd, const char *method, const char *urlPath);

#endif
