#include "atomic_file.h"
#include "platform.h"

#include <errno.h>
#include <stdio.h>

#ifndef _WIN32
#include <fcntl.h>
#endif

static int flush_to_disk(FILE *file) {
    if (fflush(file) != 0) return -1;
#ifdef _WIN32
    return _commit(_fileno(file));
#else
    return fsync(fileno(file));
#endif
}

static int replace_file(const char *from, const char *to) {
#ifdef _WIN32
    /* rename() do Windows falha se o destino existe; MoveFileEx substitui sem apagar antes. */
    return MoveFileExA(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) ? 0 : -1;
#else
    return rename(from, to);
#endif
}

/* Os arquivos guardam dados pessoais e hashes de senha: no Unix nascem com 0600, sem depender
   do umask. No Windows valem as permissoes herdadas da pasta (a do usuario, numa instalacao comum). */
static FILE *create_private(const char *path) {
#ifdef _WIN32
    return fopen(path, "wb");
#else
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, S_IRUSR | S_IWUSR);
    if (fd < 0) return NULL;
    if (fchmod(fd, S_IRUSR | S_IWUSR) != 0) {
        close(fd);
        return NULL;
    }
    FILE *file = fdopen(fd, "wb");
    if (!file) close(fd);
    return file;
#endif
}

int atomic_write_file(const char *path, const char *data, size_t length) {
    char tmpPath[1100];
    if (snprintf(tmpPath, sizeof tmpPath, "%s.tmp", path) >= (int)sizeof tmpPath) return -1;

    FILE *file = create_private(tmpPath);
    if (!file) return -1;

    int failed = length && fwrite(data, 1, length, file) != length;
    if (!failed) failed = flush_to_disk(file) != 0;
    if (fclose(file) != 0) failed = 1;

    if (failed || replace_file(tmpPath, path) != 0) {
        remove(tmpPath);
        return -1;
    }
    return 0;
}

long read_whole_file(const char *path, char *out, size_t max_bytes) {
    FILE *file = fopen(path, "rb");
    if (!file) return errno == ENOENT ? 0 : -1;

    size_t n = fread(out, 1, max_bytes, file);
    int failed = ferror(file) || (n == max_bytes && fgetc(file) != EOF);
    fclose(file);
    return failed ? -1 : (long)n;
}
