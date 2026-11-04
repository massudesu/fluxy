#ifndef FLUXY_JSON_UTIL_H
#define FLUXY_JSON_UTIL_H

#include <stddef.h>
#include "cJSON.h"

void json_util_init(void);

/* NULL se o corpo nao for JSON valido ou nao for um objeto. O chamador libera com cJSON_Delete. */
cJSON *json_parse_object(const char *body, size_t length);

typedef enum {
    JSON_FIELD_MISSING,   /* ausente ou null */
    JSON_FIELD_OK,
    JSON_FIELD_INVALID    /* nao e texto, ou nao cabe em out (nunca e truncado) */
} JsonFieldResult;

JsonFieldResult json_get_string(const cJSON *object, const char *key, char *out, size_t size);

#endif
