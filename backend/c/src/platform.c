#include "platform.h"

#include <stdlib.h>

typedef struct {
    void (*fn)(void *);
    void *arg;
} ThreadStart;

#ifdef _WIN32
static DWORD WINAPI thread_main(LPVOID raw) {
    ThreadStart start = *(ThreadStart *)raw;
    free(raw);
    start.fn(start.arg);
    return 0;
}
#else
static void *thread_main(void *raw) {
    ThreadStart start = *(ThreadStart *)raw;
    free(raw);
    start.fn(start.arg);
    return NULL;
}
#endif

int start_detached_thread(void (*fn)(void *), void *arg) {
    ThreadStart *start = malloc(sizeof *start);
    if (!start) return -1;
    start->fn = fn;
    start->arg = arg;

#ifdef _WIN32
    HANDLE thread = CreateThread(NULL, 0, thread_main, start, 0, NULL);
    if (!thread) {
        free(start);
        return -1;
    }
    CloseHandle(thread);
#else
    pthread_t thread;
    if (pthread_create(&thread, NULL, thread_main, start) != 0) {
        free(start);
        return -1;
    }
    pthread_detach(thread);
#endif
    return 0;
}

void set_socket_timeouts(SOCKET fd, int seconds) {
#ifdef _WIN32
    DWORD ms = (DWORD)seconds * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&ms, sizeof ms);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&ms, sizeof ms);
#else
    struct timeval tv = { seconds, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
}
