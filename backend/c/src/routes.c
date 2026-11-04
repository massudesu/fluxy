#include "routes.h"
#include "app_paths.h"
#include "atomic_file.h"
#include "crypto.h"
#include "http_response.h"
#include "json_util.h"
#include "rate_limit.h"
#include "session_store.h"
#include "user_store.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#define MAX_COMPANY_JSON_BYTES 4000
#define PASSWORD_MAX_LENGTH 128

/* Mesmos limites do backend Node (backend/src/routes/auth.js). */
#define LOGIN_WINDOW_SECONDS (15 * 60)
#define LOGIN_MAX_PER_IP 50
#define LOGIN_MAX_FAILURES_PER_EMAIL_AND_IP 5
#define LOGIN_MAX_FAILURES_PER_EMAIL 20
#define REGISTER_WINDOW_SECONDS 3600
/* O Node permite 10 por IP; aqui o servidor so aceita conexoes locais, entao todo cadastro vem
   do mesmo IP e o limite vale para a maquina inteira. */
#define REGISTER_MAX_PER_IP 20

static fluxy_mutex company_lock;

void routes_init(void) {
    MUTEX_INIT(&company_lock);
}

static void lower_str(char *s) {
    for (; *s; s++) {
        if (*s >= 'A' && *s <= 'Z') *s += 32;
    }
}

/* Mesmos caracteres recusados pelo backend Node: evita injecao de cabecalhos em e-mails. */
static int valid_email(const char *email) {
    const char *at = strchr(email, '@');
    if (!at || at == email || strchr(at + 1, '@') || strlen(email) > 150) return 0;
    if (strpbrk(email, " \t\r\n<>\"',;:\\")) return 0;
    const char *dot = strrchr(at, '.');
    return dot && dot > at + 1 && strlen(dot + 1) >= 2;
}

static int strong_password(const char *password) {
    int upper = 0, lower = 0, digit = 0;
    size_t length = strlen(password);
    for (const char *c = password; *c; c++) {
        if (*c >= 'A' && *c <= 'Z') upper = 1;
        else if (*c >= 'a' && *c <= 'z') lower = 1;
        else if (*c >= '0' && *c <= '9') digit = 1;
    }
    return length >= 8 && length <= PASSWORD_MAX_LENGTH && upper && lower && digit;
}

static void now_iso(char out[32]) {
    time_t t = time(NULL);
#ifdef _WIN32
    struct tm utc = *gmtime(&t); /* no Windows o resultado fica em memoria propria de cada thread */
#else
    struct tm utc;
    gmtime_r(&t, &utc);
#endif
    strftime(out, 32, "%Y-%m-%dT%H:%M:%SZ", &utc);
}

static cJSON *profile_json(const User *user) {
    cJSON *profile = cJSON_CreateObject();
    cJSON_AddNumberToObject(profile, "id", user->id);
    cJSON_AddStringToObject(profile, "name", user->name);
    cJSON_AddStringToObject(profile, "email", user->email);
    cJSON_AddStringToObject(profile, "phone", user->phone);
    cJSON_AddStringToObject(profile, "role", "admin");
    cJSON_AddStringToObject(profile, "created", user->created);
    return profile;
}

static cJSON *parse_body_or_fail(SOCKET fd, const char *body, size_t bodyLength) {
    cJSON *parsed = json_parse_object(body, bodyLength);
    if (!parsed) send_error(fd, "400 Bad Request", "invalid_json", "Os dados enviados estao em formato invalido.");
    return parsed;
}

/* Abre a sessao e responde com o cookie; se nao houver como criar a sessao, avisa sem fingir sucesso. */
static void respond_with_session(SOCKET fd, const char *status, const User *user, int remember) {
    char token[SESSION_TOKEN_HEX_LEN + 1];
    SessionCreateResult created = session_create(user->id, remember, token);
    if (created != SESSION_CREATED) {
        send_error(fd, "503 Service Unavailable", "session_unavailable",
                   "Nao foi possivel abrir a sessao agora. Tente entrar novamente em instantes.");
        return;
    }

    char cookie[256];
    session_cookie_header(cookie, sizeof cookie, token, remember ? SESSION_REMEMBER_SECONDS : 0);
    cJSON *payload = profile_json(user);
    cJSON_AddNumberToObject(payload, "user_id", user->id);
    send_json_value(fd, status, payload, cookie);
}

static void send_too_many_requests(SOCKET fd, int seconds) {
    if (seconds == RATE_LIMIT_FULL) {
        send_error(fd, "503 Service Unavailable", "server_busy", "Servidor ocupado. Tente novamente em instantes.");
        return;
    }
    int minutes = (seconds + 59) / 60;
    char message[96], retryAfter[48];
    if (minutes > 1) snprintf(message, sizeof message, "Muitas tentativas. Aguarde %d minutos e tente de novo.", minutes);
    else snprintf(message, sizeof message, "Muitas tentativas. Aguarde 1 minuto e tente de novo.");
    snprintf(retryAfter, sizeof retryAfter, "Retry-After: %d\r\n", seconds);

    cJSON *error = cJSON_CreateObject();
    cJSON_AddStringToObject(error, "error", "too_many_requests");
    cJSON_AddStringToObject(error, "message", message);
    send_json_value(fd, "429 Too Many Requests", error, retryAfter);
}

static void route_health(SOCKET fd) {
    cJSON *health = cJSON_CreateObject();
    cJSON_AddStringToObject(health, "status", "ok");
    cJSON_AddStringToObject(health, "engine", "c");
    send_json_value(fd, "200 OK", health, NULL);
}

static void route_register(SOCKET fd, const char *clientIp, const char *body, size_t bodyLength) {
    cJSON *input = parse_body_or_fail(fd, body, bodyLength);
    if (!input) return;

    User user;
    char password[PASSWORD_MAX_LENGTH + 1];
    memset(&user, 0, sizeof user);

    JsonFieldResult fields[] = {
        json_get_string(input, "name", user.name, 121),
        json_get_string(input, "email", user.email, sizeof user.email),
        json_get_string(input, "password", password, sizeof password),
        json_get_string(input, "phone", user.phone, 21),
        json_get_string(input, "cpf", user.cpf, 15)
    };
    cJSON_Delete(input);
    lower_str(user.email);

    if (fields[0] != JSON_FIELD_OK || fields[1] != JSON_FIELD_OK || fields[3] == JSON_FIELD_INVALID
        || fields[4] == JSON_FIELD_INVALID || !valid_email(user.email)) {
        send_error(fd, "400 Bad Request", "invalid_request", "Informe nome e um e-mail valido.");
        return;
    }
    if (fields[2] != JSON_FIELD_OK || !strong_password(password)) {
        send_error(fd, "400 Bad Request", "weak_password",
                   "A senha precisa de 8 a 128 caracteres, com letra maiuscula, minuscula e numero.");
        return;
    }

    char limitKey[64];
    snprintf(limitKey, sizeof limitKey, "cadastro-ip:%s", clientIp);
    int wait = rate_limit_consume(limitKey, REGISTER_MAX_PER_IP, REGISTER_WINDOW_SECONDS);
    if (wait) {
        send_too_many_requests(fd, wait);
        return;
    }

    if (password_hash(password, user.salt, user.hash) != 0) {
        send_error(fd, "500 Internal Server Error", "internal_error", "Nao foi possivel proteger a senha.");
        return;
    }
    now_iso(user.created);

    switch (user_store_add(&user)) {
    case USER_ADD_EXISTS:
        send_error(fd, "409 Conflict", "email_already_exists", "Este e-mail ja esta cadastrado.");
        return;
    case USER_ADD_FULL:
        send_error(fd, "500 Internal Server Error", "full", "Limite de usuarios atingido.");
        return;
    case USER_ADD_IO_ERROR:
        send_error(fd, "500 Internal Server Error", "internal_error", "Nao foi possivel salvar o cadastro. Tente novamente.");
        return;
    case USER_ADD_OK:
        break;
    }

    printf("[Fluxy-C] register_success id=%d\n", user.id);
    fflush(stdout);
    respond_with_session(fd, "201 Created", &user, 0);
}

static void route_login(SOCKET fd, const char *clientIp, const char *body, size_t bodyLength) {
    char ipKey[64];
    snprintf(ipKey, sizeof ipKey, "login-ip:%s", clientIp);
    int wait = rate_limit_consume(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_SECONDS);
    if (wait) {
        send_too_many_requests(fd, wait);
        return;
    }

    cJSON *input = parse_body_or_fail(fd, body, bodyLength);
    if (!input) return;

    char email[160], password[PASSWORD_MAX_LENGTH + 1];
    JsonFieldResult emailField = json_get_string(input, "email", email, sizeof email);
    JsonFieldResult passwordField = json_get_string(input, "password", password, sizeof password);
    int remember = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(input, "remember"));
    cJSON_Delete(input);
    if (emailField != JSON_FIELD_OK) email[0] = 0;
    if (passwordField != JSON_FIELD_OK) password[0] = 0;
    lower_str(email);

    /* A tentativa conta antes do scrypt: pedidos simultaneos nao passam todos pela checagem.
       E-mails inexistentes tambem contam, para o bloqueio nao revelar quem tem conta. */
    char failuresKey[220], emailKey[180];
    snprintf(failuresKey, sizeof failuresKey, "login-falha:%s|%s", email, clientIp);
    snprintf(emailKey, sizeof emailKey, "login-falha-email:%s", email);
    wait = rate_limit_consume(failuresKey, LOGIN_MAX_FAILURES_PER_EMAIL_AND_IP, LOGIN_WINDOW_SECONDS);
    if (!wait) wait = rate_limit_consume(emailKey, LOGIN_MAX_FAILURES_PER_EMAIL, LOGIN_WINDOW_SECONDS);
    if (wait) {
        send_too_many_requests(fd, wait);
        return;
    }

    User user;
    int found = email[0] && user_store_get_by_email(email, &user);
    int passwordIsRight = found && password_verify(password, user.salt, user.hash);
    if (!found) password_simulate_check(password);

    if (!passwordIsRight) {
        send_error(fd, "401 Unauthorized", "invalid_credentials", "E-mail ou senha invalidos.");
        return;
    }
    rate_limit_reset(failuresKey);
    rate_limit_reset(emailKey);

    if (password_needs_rehash(user.hash)) {
        char salt[PASSWORD_SALT_HEX_LEN + 1], hash[PASSWORD_HASH_HEX_LEN + 1];
        if (password_hash(password, salt, hash) == 0 && user_store_update_password(user.id, salt, hash) == 0) {
            printf("[Fluxy-C] password_rehashed id=%d\n", user.id);
        }
    }

    printf("[Fluxy-C] login_success id=%d\n", user.id);
    fflush(stdout);
    respond_with_session(fd, "200 OK", &user, remember);
}

static void route_logout(SOCKET fd, const char *headers) {
    session_revoke_from_request(headers);

    char cookie[256];
    session_cookie_header(cookie, sizeof cookie, NULL, 0);
    cJSON *ok = cJSON_CreateObject();
    cJSON_AddBoolToObject(ok, "ok", 1);
    send_json_value(fd, "200 OK", ok, cookie);
}

static int current_user(SOCKET fd, const char *headers, User *out) {
    int userId = session_user_id_from_request(headers);
    if (userId && user_store_get_by_id(userId, out)) return 1;
    send_error(fd, "401 Unauthorized", "unauthorized", "Sessao expirada.");
    return 0;
}

static void route_me(SOCKET fd, const char *headers) {
    User user;
    if (current_user(fd, headers, &user)) send_json_value(fd, "200 OK", profile_json(&user), NULL);
}

/* A versao em C nao envia e-mail; a recuperacao de senha existe apenas no backend Node. */
static void route_password_recovery_unavailable(SOCKET fd) {
    send_error(fd, "501 Not Implemented", "email_not_configured",
               "A recuperacao de senha por e-mail so existe no servidor Node do Fluxy (npm start).");
}

static void route_security_question_retired(SOCKET fd) {
    send_error(fd, "410 Gone", "security_question_retired",
               "A recuperacao por pergunta de seguranca foi desativada.");
}

static void save_company(SOCKET fd, const char *path, const char *body, size_t bodyLength) {
    cJSON *company = parse_body_or_fail(fd, body, bodyLength);
    if (!company) return;

    /* Grava o JSON ja validado e normalizado, nunca o texto recebido como veio. */
    char *text = cJSON_PrintUnformatted(company);
    cJSON_Delete(company);
    if (!text || strlen(text) > MAX_COMPANY_JSON_BYTES) {
        cJSON_free(text);
        send_error(fd, "413 Payload Too Large", "payload_too_large", "Dados da empresa grandes demais.");
        return;
    }

    MUTEX_LOCK(&company_lock);
    int saved = atomic_write_file(path, text, strlen(text));
    MUTEX_UNLOCK(&company_lock);
    cJSON_free(text);

    if (saved != 0) {
        send_error(fd, "500 Internal Server Error", "internal_error", "Nao foi possivel salvar. Os dados anteriores foram mantidos.");
        return;
    }
    cJSON *ok = cJSON_CreateObject();
    cJSON_AddBoolToObject(ok, "ok", 1);
    send_json_value(fd, "200 OK", ok, NULL);
}

static void show_company(SOCKET fd, const char *path) {
    char buffer[MAX_COMPANY_JSON_BYTES + 1];
    MUTEX_LOCK(&company_lock);
    long length = read_whole_file(path, buffer, MAX_COMPANY_JSON_BYTES);
    MUTEX_UNLOCK(&company_lock);

    cJSON *company = length > 0 ? json_parse_object(buffer, (size_t)length) : NULL;
    cJSON *wrapped = cJSON_CreateObject();
    cJSON_AddItemToObject(wrapped, "company", company ? company : cJSON_CreateNull());
    send_json_value(fd, "200 OK", wrapped, NULL);
}

static void route_company(SOCKET fd, const char *method, const char *headers, const char *body, size_t bodyLength) {
    User user;
    if (!current_user(fd, headers, &user)) return;

    char path[700];
    if (app_company_path(user.id, path, sizeof path) != 0) {
        send_error(fd, "500 Internal Server Error", "internal_error", "Ocorreu um erro interno.");
        return;
    }

    if (!strcmp(method, "POST") || !strcmp(method, "PUT")) save_company(fd, path, body, bodyLength);
    else if (!strcmp(method, "GET")) show_company(fd, path);
    else send_error(fd, "405 Method Not Allowed", "method_not_allowed", "Operacao nao permitida neste endereco.");
}

void handle_api(SOCKET fd, const char *clientIp, const char *method, const char *path, const char *headers,
                const char *body, size_t bodyLength) {
    if (!strcmp(method, "OPTIONS")) {
        send_raw(fd, "204 No Content", "application/json; charset=utf-8", "", 0);
        return;
    }

    if (!strcmp(path, "/health") || !strcmp(path, "/api/health")) {
        route_health(fd);
        return;
    }

    /* Protecao contra CSRF, igual ao backend Node: formularios e links de outros sites
       nao conseguem enviar este cabecalho. */
    if (strcmp(method, "GET") && strcmp(method, "HEAD")) {
        char csrf[8];
        if (!header_get(headers, "X-Fluxy-Request", csrf, sizeof csrf) || strcmp(csrf, "1")) {
            send_error(fd, "403 Forbidden", "csrf_rejected", "Requisicao bloqueada por seguranca. Recarregue a pagina.");
            return;
        }
    }

    if (!strcmp(path, "/api/auth/register") && !strcmp(method, "POST")) route_register(fd, clientIp, body, bodyLength);
    else if (!strcmp(path, "/api/auth/login") && !strcmp(method, "POST")) route_login(fd, clientIp, body, bodyLength);
    else if (!strcmp(path, "/api/auth/logout") && !strcmp(method, "POST")) route_logout(fd, headers);
    else if (!strcmp(path, "/api/me") && !strcmp(method, "GET")) route_me(fd, headers);
    else if (!strcmp(path, "/api/auth/forgot-password") || !strncmp(path, "/api/auth/reset-password", 24)) {
        route_password_recovery_unavailable(fd);
    }
    else if (!strcmp(path, "/api/auth/answer-question")) route_security_question_retired(fd);
    else if (!strcmp(path, "/api/company")) route_company(fd, method, headers, body, bodyLength);
    else send_error(fd, "404 Not Found", "not_found", "Rota nao encontrada.");
}
