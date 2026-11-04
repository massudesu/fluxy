#ifndef FLUXY_ATOMIC_FILE_H
#define FLUXY_ATOMIC_FILE_H

#include <stddef.h>

/*
 * Grava em "<path>.tmp", confere escrita/flush/fechamento, forca o conteudo para o disco e so
 * entao substitui o arquivo original numa unica operacao. Se algo falhar, o original fica
 * intacto. Retorna 0 em sucesso.
 */
int atomic_write_file(const char *path, const char *data, size_t length);

/* Le o arquivo inteiro. Retorna o tamanho lido, 0 se nao existe, -1 em erro ou se passar de max_bytes. */
long read_whole_file(const char *path, char *out, size_t max_bytes);

#endif
