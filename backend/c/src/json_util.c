#include "json_util.h"
#include "platform.h"

#include <string.h>

/* cJSON grava a posicao do ultimo erro numa variavel global a cada parse; com uma thread por
   conexao isso seria uma corrida de dados. So o parse e serializado (corpos sao pequenos). */
static fluxy_mutex parse_lock;

void json_util_init(void) {
    MUTEX_INIT(&parse_lock);
}

cJSON *json_parse_object(const char *body, size_t length) {
    MUTEX_LOCK(&parse_lock);
    cJSON *parsed = cJSON_ParseWithLength(body, length);
    MUTEX_UNLOCK(&parse_lock);

    if (parsed && !cJSON_IsObject(parsed)) {
        cJSON_Delete(parsed);
        return NULL;
    }
    return parsed;
}

JsonFieldResult json_get_string(const cJSON *object, const char *key, char *out, size_t size) {
    out[0] = 0;
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, key);
    if (!item || cJSON_IsNull(item)) return JSON_FIELD_MISSING;
    if (!cJSON_IsString(item) || !item->valuestring) return JSON_FIELD_INVALID;

    size_t length = strlen(item->valuestring);
    if (length >= size) return JSON_FIELD_INVALID;
    memcpy(out, item->valuestring, length + 1);
    return JSON_FIELD_OK;
}
