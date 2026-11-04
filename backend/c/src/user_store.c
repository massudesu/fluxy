#include "user_store.h"
#include "app_paths.h"
#include "atomic_file.h"
#include "platform.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_LINE_BYTES 1024

static User users[USER_STORE_MAX_USERS];
static int user_count = 0;
static int next_id = 1;
static fluxy_mutex lock;

static void trim_newline(char *s) {
    size_t n = strlen(s);
    while (n && (s[n - 1] == '\n' || s[n - 1] == '\r')) s[--n] = 0;
}

static void copy_field(char *dst, size_t size, const char *src) {
    size_t i = 0;
    for (; src[i] && i < size - 1; i++) {
        dst[i] = (src[i] == '\t' || src[i] == '\n' || src[i] == '\r') ? ' ' : src[i];
    }
    dst[i] = 0;
}

static int split_tab_fields(char *line, char *fields[], int max_fields) {
    int count = 0;
    fields[count++] = line;
    for (char *c = line; *c && count < max_fields; c++) {
        if (*c == '\t') {
            *c = 0;
            fields[count++] = c + 1;
        }
    }
    for (int j = 0; j < count; j++) {
        if (!strcmp(fields[j], "-")) fields[j] = (char *)"";
    }
    return count;
}

static User parse_user_line(char *line) {
    User user;
    memset(&user, 0, sizeof user);

    char *fields[16];
    int fieldCount = split_tab_fields(line, fields, 16);
    if (fieldCount < 7) return user;

    user.id = atoi(fields[0]);
    copy_field(user.name, sizeof user.name, fields[1]);
    copy_field(user.email, sizeof user.email, fields[2]);
    copy_field(user.phone, sizeof user.phone, fields[3]);
    copy_field(user.cpf, sizeof user.cpf, fields[4]);
    copy_field(user.salt, sizeof user.salt, fields[5]);
    copy_field(user.hash, sizeof user.hash, fields[6]);
    if (fieldCount > 7) copy_field(user.question, sizeof user.question, fields[7]);
    if (fieldCount > 8) copy_field(user.asalt, sizeof user.asalt, fields[8]);
    if (fieldCount > 9) copy_field(user.ahash, sizeof user.ahash, fields[9]);
    if (fieldCount > 10) copy_field(user.created, sizeof user.created, fields[10]);

    return user;
}

int user_store_load(void) {
    MUTEX_INIT(&lock);

    FILE *file = fopen(app_db_path(), "r");
    if (!file) return errno == ENOENT ? 0 : -1;
#ifndef _WIN32
    chmod(app_db_path(), S_IRUSR | S_IWUSR); /* arquivo gravado por versoes anteriores com 0644 */
#endif

    char line[2048];
    while (fgets(line, sizeof line, file) && user_count < USER_STORE_MAX_USERS) {
        trim_newline(line);
        if (!line[0]) continue;

        User user = parse_user_line(line);
        if (user.id > 0 && user.email[0]) {
            users[user_count++] = user;
            if (user.id >= next_id) next_id = user.id + 1;
        }
    }
    int failed = ferror(file);
    fclose(file);
    return failed ? -1 : 0;
}

/* Chamado com o bloqueio ja adquirido. */
static int save_locked(void) {
    char *buffer = malloc((size_t)(user_count + 1) * MAX_LINE_BYTES);
    if (!buffer) return -1;

    size_t used = 0;
    for (int i = 0; i < user_count; i++) {
        const User *u = &users[i];
#define FLD(x) ((x)[0] ? (x) : "-")
        int n = snprintf(buffer + used, MAX_LINE_BYTES, "%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
                         u->id, FLD(u->name), FLD(u->email), FLD(u->phone), FLD(u->cpf),
                         FLD(u->salt), FLD(u->hash), FLD(u->question), FLD(u->asalt),
                         FLD(u->ahash), FLD(u->created));
#undef FLD
        if (n < 0 || n >= MAX_LINE_BYTES) {
            free(buffer);
            return -1;
        }
        used += (size_t)n;
    }

    int result = atomic_write_file(app_db_path(), buffer, used);
    free(buffer);
    if (result != 0) fprintf(stderr, "[Fluxy-C] falha ao gravar %s; o arquivo anterior foi mantido\n", app_db_path());
    return result;
}

static User *find_by_email_locked(const char *email) {
    for (int i = 0; i < user_count; i++) {
        if (strcmp(users[i].email, email) == 0) return &users[i];
    }
    return NULL;
}

static User *find_by_id_locked(int id) {
    for (int i = 0; i < user_count; i++) {
        if (users[i].id == id) return &users[i];
    }
    return NULL;
}

int user_store_count(void) {
    MUTEX_LOCK(&lock);
    int count = user_count;
    MUTEX_UNLOCK(&lock);
    return count;
}

int user_store_get_by_email(const char *email, User *out) {
    MUTEX_LOCK(&lock);
    User *found = find_by_email_locked(email);
    if (found) *out = *found;
    MUTEX_UNLOCK(&lock);
    return found != NULL;
}

int user_store_get_by_id(int id, User *out) {
    MUTEX_LOCK(&lock);
    User *found = find_by_id_locked(id);
    if (found) *out = *found;
    MUTEX_UNLOCK(&lock);
    return found != NULL;
}

UserAddResult user_store_add(User *user) {
    UserAddResult result = USER_ADD_OK;
    MUTEX_LOCK(&lock);

    if (find_by_email_locked(user->email)) {
        result = USER_ADD_EXISTS;
    } else if (user_count >= USER_STORE_MAX_USERS) {
        result = USER_ADD_FULL;
    } else {
        user->id = next_id;
        users[user_count++] = *user;
        if (save_locked() == 0) {
            next_id++;
        } else {
            user_count--;
            result = USER_ADD_IO_ERROR;
        }
    }

    MUTEX_UNLOCK(&lock);
    return result;
}

int user_store_update_password(int id, const char *salt, const char *hash) {
    int result = -1;
    MUTEX_LOCK(&lock);

    User *user = find_by_id_locked(id);
    if (user) {
        User previous = *user;
        snprintf(user->salt, sizeof user->salt, "%s", salt);
        snprintf(user->hash, sizeof user->hash, "%s", hash);
        result = save_locked();
        if (result != 0) *user = previous;
    }

    MUTEX_UNLOCK(&lock);
    return result;
}
