#ifndef FLUXY_USER_STORE_H
#define FLUXY_USER_STORE_H

#include "crypto.h"

#define USER_STORE_MAX_USERS 2000

typedef struct {
    int id;
    char name[128];
    char email[160];
    char phone[40];
    char cpf[40];
    char salt[PASSWORD_SALT_HEX_LEN + 1];
    char hash[PASSWORD_HASH_HEX_LEN + 1];
    /* Pergunta de seguranca desativada: os campos so preservam os dados de contas antigas. */
    char question[200];
    char asalt[33];
    char ahash[65];
    char created[32];
} User;

typedef enum {
    USER_ADD_OK,
    USER_ADD_EXISTS,
    USER_ADD_FULL,
    USER_ADD_IO_ERROR
} UserAddResult;

/* Retorna -1 se o arquivo existe mas nao pode ser lido (o servidor nao deve sobrescreve-lo). */
int user_store_load(void);
int user_store_count(void);

/* Copiam o usuario para out: nenhum ponteiro para o vetor interno escapa do bloqueio. */
int user_store_get_by_email(const char *email, User *out);
int user_store_get_by_id(int id, User *out);

/* Confere e-mail repetido, atribui o id e grava, sob o mesmo bloqueio; desfaz se a gravacao falhar. */
UserAddResult user_store_add(User *user);

int user_store_update_password(int id, const char *salt, const char *hash);

#endif
