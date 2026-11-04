#ifndef FLUXY_PLATFORM_H
#define FLUXY_PLATFORM_H

#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>
#  include <direct.h>
#  include <io.h>
#  define CLOSESOCK closesocket
#  define MKDIR(path) _mkdir(path)
typedef int socklen_t;

typedef CRITICAL_SECTION fluxy_mutex;
#  define MUTEX_INIT(m)   InitializeCriticalSection(m)
#  define MUTEX_LOCK(m)   EnterCriticalSection(m)
#  define MUTEX_UNLOCK(m) LeaveCriticalSection(m)
#else
#  include <sys/socket.h>
#  include <sys/stat.h>
#  include <sys/time.h>
#  include <netinet/in.h>
#  include <arpa/inet.h>
#  include <unistd.h>
#  include <signal.h>
#  include <pthread.h>
#  define CLOSESOCK close
#  define MKDIR(path) mkdir(path, 0700)
typedef int SOCKET;
#  define INVALID_SOCKET (-1)

typedef pthread_mutex_t fluxy_mutex;
#  define MUTEX_INIT(m)   pthread_mutex_init(m, NULL)
#  define MUTEX_LOCK(m)   pthread_mutex_lock(m)
#  define MUTEX_UNLOCK(m) pthread_mutex_unlock(m)
#endif

int start_detached_thread(void (*fn)(void *), void *arg);

void set_socket_timeouts(SOCKET fd, int seconds);

#endif
