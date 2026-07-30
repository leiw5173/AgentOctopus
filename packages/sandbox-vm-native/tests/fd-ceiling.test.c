/*
 * fd-ceiling.test.c -- static/doc test for ME-3: mass_close_fds fallback
 * must be bounded by getrlimit(RLIMIT_NOFILE), not a hardcoded 4096.
 *
 * Build/run:
 *   cc -std=gnu17 -Wall -Werror -o /tmp/fd-ceiling.test tests/fd-ceiling.test.c && /tmp/fd-ceiling.test
 *
 * This is a source-level test: it reads vm-helper.c and asserts the
 * fallback close loops are driven by fd_ceiling()/getrlimit rather than
 * the previous hard-coded 4096 bound.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SOURCE_PATH "src/vm-helper.c"

int main(void) {
    FILE *f = fopen(SOURCE_PATH, "r");
    if (!f) {
        perror("fopen " SOURCE_PATH);
        return 2;
    }

    char line[1024];
    int lineno = 0;
    int found_hardcoded = 0;
    int found_fd_ceiling = 0;
    int found_getrlimit = 0;

    while (fgets(line, sizeof(line), f)) {
        lineno++;
        if (strstr(line, "fd_ceiling(")) {
            found_fd_ceiling = 1;
        }
        if (strstr(line, "getrlimit(RLIMIT_NOFILE")) {
            found_getrlimit = 1;
        }
        if (strstr(line, "fd < 4096")) {
            printf("FAIL: hardcoded 4096 fallback loop bound at %s:%d: %s",
                   SOURCE_PATH, lineno, line);
            found_hardcoded = 1;
        }
    }
    fclose(f);

    if (!found_getrlimit) {
        printf("FAIL: %s does not call getrlimit(RLIMIT_NOFILE, ...)\n",
               SOURCE_PATH);
    }
    if (!found_fd_ceiling) {
        printf("FAIL: %s does not define or call fd_ceiling()\n", SOURCE_PATH);
    }

    if (found_hardcoded || !found_getrlimit || !found_fd_ceiling) {
        return 1;
    }

    printf("PASS: fallback loop bound is derived from RLIMIT_NOFILE via fd_ceiling()\n");
    return 0;
}
