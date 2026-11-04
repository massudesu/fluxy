#ifndef FLUXY_RATE_LIMIT_H
#define FLUXY_RATE_LIMIT_H

/* Contadores por chave numa janela de tempo, compartilhados entre as threads (mutex).
   Ficam em memoria, como as sessoes: reiniciar o servidor zera os limites. */

void rate_limit_init(void);

#define RATE_LIMIT_FULL (-1)

/* Conta e confere de uma vez: 0 = liberado; > 0 = segundos ate liberar; RATE_LIMIT_FULL = sem espaco
   para contar, e a tentativa deve ser recusada. */
int rate_limit_consume(const char *key, int max, int windowSeconds);

void rate_limit_reset(const char *key);

#endif
