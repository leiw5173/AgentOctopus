/*
 * gate-svc.c -- privileged companion service for the AgentOctopus Windows
 * sandbox backend (Task 9). Part of the Windows Trusted Computing Base.
 *
 * Built by scripts/build-win-helper.mjs against the Windows SDK with MSVC:
 *   cl.exe /nologo /c /W4 /WX /O2 /std:c17 gate-svc.c
 *   cl.exe /nologo gate-svc.obj /link /OUT:octopus-sandbox-gate-svc.exe
 *
 * This process runs as the Windows service `OctopusSandboxGate` (LocalSystem,
 * SERVICE_AUTO_START). It owns the PERSISTENT WFP (Windows Filtering
 * Platform) egress allowlist described in spec §4c: for each sandbox session
 * it installs a private provider + sublayer and four filters scoped to the
 * skill's node.exe APPLICATION PATH (FWPM_CONDITION_ALE_APP_ID, the
 * lower-case fully-qualified device path from FwpmGetAppIdFromFileName0) that
 * permit only `TCP 127.0.0.1:<proxyPort>` (and `TCP [::1]:<proxyPort>` when
 * the proxy listens on ::1) and block every other connect for that binary
 * (all other V4/V6, all UDP, internet, LAN, and every other loopback port).
 *
 * Option 3 (spec §4c, task 36/37): the node execution path no longer runs
 * under an AppContainer token (it launches under a CreateRestrictedToken +
 * Job Object), so FWPM_CONDITION_ALE_PACKAGE_ID would never match. The gate
 * is therefore scoped to the sandbox-private node.exe path via
 * FWPM_CONDITION_ALE_APP_ID, which matches the restricted-token child on the
 * same ALE connect layers and uniquely keys the sandbox binary (the host's
 * other node.exe has a different path and is unaffected).
 *
 * RPC surface (exactly two operations -- NOT a general WFP write proxy):
 *   install-gate { sessionId, appIdPath, proxyHost, proxyPort, jobName }
 *       -> create the persistent provider (once) + sublayer (once) + the
 *          four persistent filters; record a session lease
 *          { sessionId, appIdPath, filterKeys[4], jobName }; return
 *          { ok:true, filterKeys:[...] }.
 *   remove-gate { sessionId }
 *       -> SERVICE-SIDE verification (spec §4c, do NOT trust the caller):
 *          resolve the lease, OpenJobObjectW(jobName), confirm the Job is
 *          dead (ERROR_FILE_NOT_FOUND) or empty (ActiveProcesses==0), verify
 *          the request matches the lease, then FwpmFilterDeleteByKey0 each
 *          filter and drop the lease. REFUSE (ok:false) if any check fails.
 *
 * Fail-closed everywhere: any WFP/Job/lease failure refuses the operation and
 * reports ok:false; a partial install (filter N of 4 fails) rolls back
 * filters 1..N-1 so no half-installed gate is ever left; a remove is NEVER
 * performed on an unverified request. A service crash can only leave a
 * fail-closed BLOCK (residual DoS), never widened access; the startup sweep
 * reclaims filters whose Jobs are already dead.
 *
 * This file is freestanding-ish Win32 C: no shell, no LoadLibrary /
 * GetProcAddress, no external JSON library. Configuration comes from the
 * length-prefixed JSON RPC frames on the pipe; every Win32 / HRESULT / WFP
 * return is checked. The WFP 1.0 `...0` APIs (fwpmu.h) are used throughout.
 *
 * Import libraries: build-win-helper.mjs's linkExe() cannot pass import libs
 * on the cl command line (deferred constraint), so every non-default lib is
 * pulled in via #pragma comment(lib, ...) below. kernel32.lib is implicit.
 * We link:
 *   Fwpuclnt.lib  -- FwpmEngineOpen0 / FwpmProviderAdd0 / FwpmSubLayerAdd0 /
 *                    FwpmFilterAdd0 / FwpmFilterDeleteByKey0 /
 *                    FwpmGetAppIdFromFileName0 / FwpmFreeMemory0
 *   advapi32.lib  -- service control (StartServiceCtrlDispatcherW,
 *                    RegisterServiceCtrlHandlerExW, SetServiceStatus),
 *                    ConvertStringSecurityDescriptorToSecurityDescriptorW,
 *                    registry (lease persistence)
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

/* API surface targeting.
 *
 * The service's minimum target is Windows 10 (matching helper.c). The two
 * gates must be self-defined BEFORE any SDK header, because
 * scripts/build-win-helper.mjs passes NO /D (verified -- compileObj/linkExe
 * carry only /nologo /c /W4 /WX /O2 /std:c17 /Fo). FwpmEngineOpen0 and the
 * ALE connect layers are Vista+, and FWPM_CONDITION_ALE_APP_ID /
 * FwpmGetAppIdFromFileName0 are Vista+, so the Win10 floor is comfortably
 * above every WFP declaration used here.
 * The #ifndef guards let a future build-script /D override win. */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00 /* _WIN32_WINNT_WIN10 */
#endif
#ifndef NTDDI_VERSION
#define NTDDI_VERSION 0x0A000000 /* NTDDI_WIN10 */
#endif

#include <windows.h>
#include <ws2def.h>     /* IPPROTO_TCP (the IPPROTO enum the WFP protocol
                         * condition expects); fwpmtypes.h does not pull it in */
#include <fwpmu.h>     /* WFP 1.0 user-mode API (Fwpm*0, FWPM_*, FWP_*) */
#include <fwpmtypes.h> /* FWPM_PROVIDER0 / FWPM_SUBLAYER0 / FWPM_FILTER0 */
#include <sddl.h>      /* ConvertStringSecurityDescriptorToSecurityDescriptorW */
#include <stdio.h>     /* fwprintf */
#include <stdlib.h>    /* strtoul */
#include <string.h>    /* memcpy, memcmp, strlen, strstr */
#include <wchar.h>     /* swprintf_s, wcslen, wcscmp */

#pragma comment(lib, "Fwpuclnt.lib")
#pragma comment(lib, "advapi32.lib")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/* Service identity. The provider's serviceName MUST equal this so BFE keeps
 * the provider's persistent filters enabled only while this auto-start
 * service runs (fail-closed: a stopped/absent service never leaves an
 * over-broad gate). */
#define OCT_SERVICE_NAME  L"OctopusSandboxGate"

/* Named pipe endpoint. Restrictive DACL (below) limits access to the
 * installing user + Administrators. */
#define OCT_PIPE_NAME     L"\\\\.\\pipe\\octopus-sandbox-gate"

/* Pipe DACL, expressed as an SDDL string and converted with
 * ConvertStringSecurityDescriptorToSecurityDescriptorW. Breakdown:
 *   D:                      DACL
 *   (A;;GA;;;BA)            Allow GENERIC_ALL to Builtin Administrators
 *   (A;;GA;;;SY)            Allow GENERIC_ALL to LocalSystem (the service
 *                           itself, so its own clients in-session 0 can talk)
 *   (A;;GA;;;IU)            Allow GENERIC_ALL to the INTERACTIVE user -- the
 *                           installing/logged-on operator who drives the
 *                           sandbox. Everyone else is implicitly denied (no
 *                           ACE), which is the fail-closed default. */
#define OCT_PIPE_SDDL       L"D:(A;;GA;;;BA)(A;;GA;;;SY)(A;;GA;;;IU)"

/* RPC frame caps. 64 KiB is far larger than any legitimate install/remove
 * request (a handful of short string fields); anything larger is malformed
 * and refused. The length prefix is 4-byte little-endian. */
#define OCT_RPC_MAX_BYTES   (64u * 1024u)
#define OCT_RPC_LEN_BYTES   4u

/* Field caps for the parsed install/remove payloads. Job names, session ids,
 * and host strings are short; these caps bound the JSON extractor's copies. A
 * GUID filter key is 38 wide chars ("{...}"). The application-id path is a
 * full DOS path (e.g. "C:\...\node.exe"); OCT_PATH_MAX generously caps it at
 * 512 (well above the Win32 MAX_PATH of 260 plus long-path headroom). */
#define OCT_SESSIONID_MAX   128
#define OCT_PATH_MAX        512
#define OCT_JOBNAME_MAX     260
#define OCT_PROXYHOST_MAX   64
#define OCT_FILTERKEY_MAX   40

/* Filter weights (spec §4c): the PERMIT rules carry a HIGH weight so they
 * outrank the catch-all BLOCK rules within our sublayer; the BLOCK rules
 * carry a LOW weight. weight is FWP_UINT64 in FWPM_FILTER0; we use a small
 * integer for block and a larger one for permit so arbitration is
 * deterministic and independent of other providers' sublayers (our filters
 * live in our own private sublayer). */
#define OCT_WEIGHT_PERMIT   ((UINT64)0x1000)
#define OCT_WEIGHT_BLOCK    ((UINT64)0x10)

/* Fixed GUIDs for the provider and sublayer. Deterministic (not per-boot
 * random) so install is idempotent across service restarts and the startup
 * sweep can re-resolve the same objects. These are private to this service;
 * they were generated once for the AgentOctopus gate and never reused
 * elsewhere. Filter GUIDs are derived per-session (see make_filter_key). */
/* {7A1E5C10-3B2F-4E6A-9C1D-2F4A6B8C0D2E} */
static const GUID OCT_PROVIDER_KEY =
    { 0x7a1e5c10, 0x3b2f, 0x4e6a, { 0x9c, 0x1d, 0x2f, 0x4a, 0x6b, 0x8c, 0x0d, 0x2e } };
/* {8B2F6D21-4C3A-5F7B-AD2E-3A5B7C9D1E3F} */
static const GUID OCT_SUBLAYER_KEY =
    { 0x8b2f6d21, 0x4c3a, 0x5f7b, { 0xad, 0x2e, 0x3a, 0x5b, 0x7c, 0x9d, 0x1e, 0x3f } };

/* Lease persistence. Leases must survive a service restart so the startup
 * sweep can reclaim leaked filters from a crashed run. We store them under a
 * dedicated registry key owned by the service (HKLM\SOFTWARE, which requires
 * the LocalSystem write access the service has and is NOT writable by the
 * unprivileged sandbox). One value per sessionId:
 *   value name  = sessionId (sanitized to a safe subset)
 *   value data  = REG_SZ "appIdPath|jobName|key0,key1,key2,key3"
 * This keeps persistence simple and fail-closed: a lease that cannot be
 * written aborts the install (the gate is rolled back). */
#define OCT_LEASE_REG_PATH  L"SOFTWARE\\AgentOctopus\\SandboxGate\\Leases"

/* Job-death poll: how long remove-gate waits for a still-open Job's active
 * process count to reach 0 before giving up (fail-closed refuse). The Job is
 * terminated by the TS side (KILL_ON_JOB_CLOSE) BEFORE remove-gate is called,
 * so by the time we query it the count is normally already 0; the poll only
 * covers the brief unwind window. */
#define OCT_JOB_DRAIN_TIMEOUT_MS 5000
#define OCT_JOB_DRAIN_POLL_MS    50

/* Per-session filter slots. The four filters of spec §4c. */
#define OCT_FILTER_COUNT 4

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/* Single-line diagnostic on stderr. Wide-char context + a 0x%08lx code
 * (HRESULT / Win32 / WFP error are all 32-bit). In service mode stderr is
 * not attached to a console, but the call is harmless and aids
 * --run-foreground debugging. */
static void diag(PCWSTR context, DWORD code) {
    fwprintf(stderr, L"octopus-sandbox-gate-svc: %ls failed (code=0x%08lx)\n",
             context, (unsigned long)code);
}

/* ------------------------------------------------------------------ */
/* Minimal strict JSON extraction                                      */
/* ------------------------------------------------------------------ */

/*
 * The RPC payload is a flat JSON object with a known, tiny key set. We do
 * NOT pull in a JSON library; instead we extract scalar values with a strict
 * hand-rolled scanner that:
 *   - finds `"key"` followed by optional whitespace, ':', optional whitespace;
 *   - for a string value, reads to the closing quote, unescaping exactly the
 *         two escapes a JSON.stringify'd Windows DOS path can produce
 *         ("\\" -> '\' and "\"" -> '"'); every other escape is rejected
 *         fail-closed. (Option-3 note: appIdPath is the first field that
 *         legitimately contains backslashes; the TS client JSON-escapes them,
 *         so the scanner must unescape them or install-gate fails closed with
 *         bad-install-args.)
 *   - for a number value (proxyPort), reads [0-9]+ only.
 * Anything nested, oversized, or containing an unsupported escape is
 * rejected. This is intentionally narrow: the service trusts nothing about
 * the client and refuses anything it cannot parse exactly.
 *
 * json_get_string -- copy the string value of `key` into out (cap outCap
 * chars, NUL-terminated). Returns TRUE on a clean, fully-contained extraction;
 * FALSE if the key is absent, the value is not a plain string, contains an
 * unsupported escape, or exceeds outCap-1.
 */
static BOOL json_get_string(const char *json, const char *key,
                            char *out, size_t outCap) {
    char needle[64];
    const char *p;
    size_t klen;
    size_t n = 0;

    if (json == NULL || key == NULL || out == NULL || outCap == 0) return FALSE;
    out[0] = '\0';

    /* Build "key" with quotes. Keys are short and fixed; reject absurd ones. */
    klen = strlen(key);
    if (klen == 0 || klen + 3 > sizeof(needle)) return FALSE;
    needle[0] = '"';
    memcpy(needle + 1, key, klen);
    needle[1 + klen] = '"';
    needle[2 + klen] = '\0';

    p = strstr(json, needle);
    if (p == NULL) return FALSE;
    p += klen + 2; /* past the closing quote of the key */

    /* optional whitespace then ':' then optional whitespace */
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != ':') return FALSE;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '"') return FALSE;
    p++; /* opening quote of the value */

    /* Copy the value into out, unescaping the ONLY two escapes a Windows DOS
     * path (appIdPath) can produce once JSON.stringify'd by the TS client:
     * "\\" -> '\' and "\"" -> '"'. Every other escape (\n, \uXXXX, ...) is
     * still rejected outright — the service never guesses a value it cannot
     * parse exactly. Written char-by-char because unescaping makes the output
     * shorter than the raw JSON span (no trailing memcpy). */
    while (*p != '\0' && *p != '"') {
        char c = *p;
        if (c == '\\') {
            char e = *(p + 1);
            if (e == '\\') {
                c = '\\';
                p += 2;
            } else if (e == '"') {
                c = '"';
                p += 2;
            } else {
                return FALSE; /* unsupported escape — fail closed */
            }
        } else {
            p++;
        }
        if (n + 1 >= outCap) return FALSE; /* leave room for the NUL */
        out[n++] = c;
    }
    if (*p != '"') return FALSE; /* unterminated */

    out[n] = '\0';
    return TRUE;
}

/*
 * json_get_uint -- extract a non-negative integer value for `key` into
 * *out. Accepts only a bare [0-9]+ token (no quotes, no sign, no decimal).
 * Returns TRUE on a clean extraction; FALSE otherwise.
 */
static BOOL json_get_uint(const char *json, const char *key,
                          unsigned long *out) {
    char needle[64];
    const char *p;
    size_t klen;
    unsigned long v = 0;
    BOOL any = FALSE;

    if (json == NULL || key == NULL || out == NULL) return FALSE;

    klen = strlen(key);
    if (klen == 0 || klen + 3 > sizeof(needle)) return FALSE;
    needle[0] = '"';
    memcpy(needle + 1, key, klen);
    needle[1 + klen] = '"';
    needle[2 + klen] = '\0';

    p = strstr(json, needle);
    if (p == NULL) return FALSE;
    p += klen + 2;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != ':') return FALSE;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;

    while (*p >= '0' && *p <= '9') {
        unsigned int digit = (unsigned int)(*p - '0');
        /* Overflow guard: refuse absurd ports before they wrap. */
        if (v > (0xFFFFFFFFul - digit) / 10ul) return FALSE;
        v = v * 10ul + digit;
        any = TRUE;
        p++;
    }
    if (!any) return FALSE;
    *out = v;
    return TRUE;
}

/*
 * json_get_bool -- extract a boolean value for `key` into *out. Accepts only
 * the bare JSON literals `true` / `false` (no quotes, no 1/0). Returns TRUE on
 * a clean extraction; FALSE when the key is absent or the value is not one of
 * those literals. Matches the strict, hand-rolled idiom of json_get_string /
 * json_get_uint above: the service never guesses a value it cannot parse.
 */
static BOOL json_get_bool(const char *json, const char *key, BOOL *out) {
    char needle[64];
    const char *p;
    size_t klen;

    if (json == NULL || key == NULL || out == NULL) return FALSE;

    klen = strlen(key);
    if (klen == 0 || klen + 3 > sizeof(needle)) return FALSE;
    needle[0] = '"';
    memcpy(needle + 1, key, klen);
    needle[1 + klen] = '"';
    needle[2 + klen] = '\0';

    p = strstr(json, needle);
    if (p == NULL) return FALSE;
    p += klen + 2;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != ':') return FALSE;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;

    if (strncmp(p, "true", 4) == 0) {
        *out = TRUE;
        return TRUE;
    }
    if (strncmp(p, "false", 5) == 0) {
        *out = FALSE;
        return TRUE;
    }
    return FALSE;
}

/* ------------------------------------------------------------------ */
/* Session lease                                                       */
/* ------------------------------------------------------------------ */

typedef struct OCT_LEASE {
    char  sessionId[OCT_SESSIONID_MAX];
    char  appIdPath[OCT_PATH_MAX];   /* ASCII form, e.g. "C:\...\node.exe" */
    char  jobName[OCT_JOBNAME_MAX];  /* ASCII form of the named Job */
    GUID  filterKeys[OCT_FILTER_COUNT];
    DWORD filterCount;               /* 3 when V6 permit is omitted, else 4 */
} OCT_LEASE;

/* A narrow, in-memory lease table guarded by a critical section. Leases are
 * additionally mirrored to the registry (below) so a restart can re-load
 * them. The table is small (one entry per live sandbox session). */
#define OCT_LEASE_TABLE_MAX 64

typedef struct OCT_LEASE_TABLE {
    CRITICAL_SECTION lock;
    OCT_LEASE entries[OCT_LEASE_TABLE_MAX];
    DWORD count;
} OCT_LEASE_TABLE;

static OCT_LEASE_TABLE g_leases;

static void lease_table_init(void) {
    InitializeCriticalSection(&g_leases.lock);
    g_leases.count = 0;
}

/* Sanitize a sessionId into a registry-safe value name: keep [A-Za-z0-9._-],
 * replace anything else with '_'. Returns TRUE if a non-empty name was
 * produced. Registry value names cannot contain '\\'. */
static BOOL lease_reg_name(const char *sessionId, WCHAR *out, size_t outCap) {
    size_t i = 0;
    size_t n = 0;
    if (sessionId == NULL || out == NULL || outCap == 0) return FALSE;
    while (sessionId[i] != '\0') {
        unsigned char c = (unsigned char)sessionId[i];
        WCHAR w;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-') {
            w = (WCHAR)c;
        } else {
            w = L'_';
        }
        if (n + 1 >= outCap) return FALSE;
        out[n++] = w;
        i++;
    }
    if (n == 0) return FALSE;
    out[n] = L'\0';
    return TRUE;
}

/* Wide<->ASCII helpers for the narrow fields we round-trip through the
 * registry. Our values are pure ASCII (DOS paths, GUIDs, safe names), so a
 * simple per-char widening/narrowing is exact and avoids locale surprises. */
static void ascii_to_wide(const char *in, WCHAR *out, size_t outCap) {
    size_t i = 0;
    if (outCap == 0) return;
    while (in[i] != '\0' && i + 1 < outCap) {
        out[i] = (WCHAR)(unsigned char)in[i];
        i++;
    }
    out[i] = L'\0';
}

static void wide_to_ascii(const WCHAR *in, char *out, size_t outCap) {
    size_t i = 0;
    if (outCap == 0) return;
    while (in[i] != L'\0' && i + 1 < outCap) {
        WCHAR w = in[i];
        out[i] = (w < 0x80) ? (char)w : '?';
        i++;
    }
    out[i] = L'\0';
}

/* Serialize a lease to "appIdPath|jobName|k0,k1,k2,k3" (filterCount GUIDs
 * comma-separated) in a wide buffer for REG_SZ storage. Returns TRUE on
 * success. */
static BOOL lease_serialize(const OCT_LEASE *lease, WCHAR *out, size_t outCapChars) {
    WCHAR pathW[OCT_PATH_MAX];
    WCHAR jobW[OCT_JOBNAME_MAX];
    WCHAR guidW[OCT_FILTERKEY_MAX];
    size_t used = 0;
    DWORD i;
    int wrote;

    if (lease == NULL || out == NULL || outCapChars == 0) return FALSE;
    out[0] = L'\0';
    ascii_to_wide(lease->appIdPath, pathW, ARRAYSIZE(pathW));
    ascii_to_wide(lease->jobName, jobW, ARRAYSIZE(jobW));

    wrote = swprintf_s(out, outCapChars, L"%s|%s|", pathW, jobW);
    if (wrote < 0) return FALSE;
    used = (size_t)wrote;

    for (i = 0; i < lease->filterCount; i++) {
        wrote = swprintf_s(guidW, ARRAYSIZE(guidW),
            L"{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
            (unsigned long)lease->filterKeys[i].Data1,
            (unsigned int)lease->filterKeys[i].Data2,
            (unsigned int)lease->filterKeys[i].Data3,
            (unsigned int)lease->filterKeys[i].Data4[0],
            (unsigned int)lease->filterKeys[i].Data4[1],
            (unsigned int)lease->filterKeys[i].Data4[2],
            (unsigned int)lease->filterKeys[i].Data4[3],
            (unsigned int)lease->filterKeys[i].Data4[4],
            (unsigned int)lease->filterKeys[i].Data4[5],
            (unsigned int)lease->filterKeys[i].Data4[6],
            (unsigned int)lease->filterKeys[i].Data4[7]);
        if (wrote < 0) return FALSE;
        if (i + 1 < lease->filterCount) {
            /* Append ",<guid>". */
            if (used + (size_t)wrote + 2 > outCapChars) return FALSE;
            out[used++] = L',';
            memcpy(out + used, guidW, (size_t)wrote * sizeof(WCHAR));
            used += (size_t)wrote;
            out[used] = L'\0';
        } else {
            if (used + (size_t)wrote + 1 > outCapChars) return FALSE;
            memcpy(out + used, guidW, (size_t)wrote * sizeof(WCHAR));
            used += (size_t)wrote;
            out[used] = L'\0';
        }
    }
    return TRUE;
}

/* Persist a lease to the registry. Creates the key if needed. Fail-closed:
 * returns FALSE on any error so the caller can roll back the install. */
static BOOL lease_persist(const OCT_LEASE *lease) {
    HKEY key = NULL;
    WCHAR name[OCT_SESSIONID_MAX];
    WCHAR data[OCT_PATH_MAX + OCT_JOBNAME_MAX +
               (OCT_FILTERKEY_MAX * OCT_FILTER_COUNT) + 16];
    LSTATUS st;
    BOOL ok = FALSE;

    if (!lease_reg_name(lease->sessionId, name, ARRAYSIZE(name))) return FALSE;
    if (!lease_serialize(lease, data, ARRAYSIZE(data))) return FALSE;

    st = RegCreateKeyExW(HKEY_LOCAL_MACHINE, OCT_LEASE_REG_PATH, 0, NULL,
                         0 /* non-volatile */, KEY_READ | KEY_WRITE, NULL,
                         &key, NULL);
    if (st != ERROR_SUCCESS) { diag(L"RegCreateKeyExW", (DWORD)st); return FALSE; }

    st = RegSetValueExW(key, name, 0, REG_SZ, (const BYTE *)data,
                        (DWORD)((wcslen(data) + 1) * sizeof(WCHAR)));
    if (st != ERROR_SUCCESS) {
        diag(L"RegSetValueExW", (DWORD)st);
    } else {
        ok = TRUE;
    }
    RegCloseKey(key);
    return ok;
}

/* Delete a lease's registry value (best-effort; absence is fine). */
static void lease_unpersist(const char *sessionId) {
    HKEY key = NULL;
    WCHAR name[OCT_SESSIONID_MAX];
    if (!lease_reg_name(sessionId, name, ARRAYSIZE(name))) return;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, OCT_LEASE_REG_PATH, 0,
                      KEY_READ | KEY_WRITE, &key) != ERROR_SUCCESS) {
        return;
    }
    (void)RegDeleteValueW(key, name);
    RegCloseKey(key);
}

/* In-memory lease insert. Assumes the table lock is held. Returns FALSE if
 * the table is full (fail-closed). */
static BOOL lease_table_add_locked(const OCT_LEASE *lease) {
    if (g_leases.count >= OCT_LEASE_TABLE_MAX) return FALSE;
    g_leases.entries[g_leases.count] = *lease; /* struct copy: fixed-size members */
    g_leases.count++;
    return TRUE;
}

/* In-memory lease find by sessionId. Returns the index, or -1. */
static LONG lease_table_find_locked(const char *sessionId) {
    DWORD i;
    for (i = 0; i < g_leases.count; i++) {
        if (strcmp(g_leases.entries[i].sessionId, sessionId) == 0) {
            return (LONG)i;
        }
    }
    return -1;
}

/* In-memory lease remove by index (swap-with-last). Lock held. */
static void lease_table_remove_locked(LONG idx) {
    if (idx < 0 || (DWORD)idx >= g_leases.count) return;
    g_leases.entries[idx] = g_leases.entries[g_leases.count - 1];
    g_leases.count--;
}

/* ------------------------------------------------------------------ */
/* Filter-key derivation                                               */
/* ------------------------------------------------------------------ */

/*
 * make_filter_key -- derive the GUID for filter `slot` of a session.
 *
 * The GUID is deterministic from (sessionId, slot) so install/remove/sweep
 * all agree on the same keys for the same session, and so a re-install after
 * a crash re-resolves the same filters. We fold a tiny FNV-1a hash of the
 * sessionId into Data1 and stamp the slot into Data2, on top of a fixed
 * per-component prefix, so keys from different sessions never collide.
 *
 * slot: 0 = V4 permit, 1 = V4 block, 2 = V6 permit, 3 = V6 block.
 */
static void make_filter_key(const char *sessionId, DWORD slot, GUID *out) {
    UINT32 h = 2166136261u; /* FNV-1a 32 offset basis */
    const unsigned char *p = (const unsigned char *)sessionId;
    while (*p != 0) {
        h ^= (UINT32)(*p);
        h *= 16777619u;
        p++;
    }
    out->Data1 = 0x0c700000u ^ h;         /* fixed tag ^ session hash */
    out->Data2 = (USHORT)(0x5a00u + slot);
    out->Data3 = 0x47ac;
    out->Data4[0] = 0x9e;
    out->Data4[1] = 0x01;
    out->Data4[2] = (BYTE)(h >> 24);
    out->Data4[3] = (BYTE)(h >> 16);
    out->Data4[4] = (BYTE)(h >> 8);
    out->Data4[5] = (BYTE)(h);
    out->Data4[6] = 0x0c;
    out->Data4[7] = (BYTE)(0x70u + slot);
}

/* ------------------------------------------------------------------ */
/* WFP engine                                                          */
/* ------------------------------------------------------------------ */

/*
 * Open the WFP engine for a NON-dynamic session. We deliberately do NOT set
 * FWPM_SESSION_FLAG_DYNAMIC: dynamic objects would be auto-deleted when this
 * process exits, which is fail-open for a blocker (spec §4c). All our objects
 * are individually persistent, so the session itself is the default
 * (non-dynamic) kind.
 *
 * The service runs as LocalSystem, which holds FWPM_ACTRL_ADD +
 * FWPM_ACTRL_ADD_LINK on the provider/layer/sublayer containers.
 */
static HRESULT wfp_open(HANDLE *outEngine) {
    DWORD rc;
    *outEngine = NULL;
    rc = FwpmEngineOpen0(NULL /* local */, RPC_C_AUTHN_DEFAULT, NULL, NULL,
                         outEngine);
    if (rc != ERROR_SUCCESS) {
        return HRESULT_FROM_WIN32(rc);
    }
    return S_OK;
}

/*
 * Ensure the persistent provider + sublayer exist. Idempotent: if they
 * already exist (a prior install or a service restart), FwpmProviderAdd0 /
 * FwpmSubLayerAdd0 return FWP_E_ALREADY_EXISTS, which we treat as success.
 */
static HRESULT wfp_ensure_provider_and_sublayer(HANDLE engine) {
    FWPM_PROVIDER0 provider;
    FWPM_SUBLAYER0 sublayer;
    DWORD rc;

    ZeroMemory(&provider, sizeof(provider));
    provider.providerKey = OCT_PROVIDER_KEY;
    provider.displayData.name = (LPWSTR)L"AgentOctopus Sandbox Gate";
    provider.displayData.description =
        (LPWSTR)L"Per-session egress allowlist for the AgentOctopus Windows sandbox";
    provider.flags = FWPM_PROVIDER_FLAG_PERSISTENT;
    /* serviceName is the fail-closed anchor: BFE keeps this provider's
     * persistent filters enabled only while the named auto-start service
     * runs. A stopped/absent service disables the filters (they can then only
     * block, never over-permit). */
    provider.serviceName = (LPWSTR)OCT_SERVICE_NAME;

    rc = FwpmProviderAdd0(engine, &provider, NULL);
    if (rc != ERROR_SUCCESS && rc != FWP_E_ALREADY_EXISTS) {
        return HRESULT_FROM_WIN32(rc);
    }

    ZeroMemory(&sublayer, sizeof(sublayer));
    sublayer.subLayerKey = OCT_SUBLAYER_KEY;
    sublayer.displayData.name = (LPWSTR)L"AgentOctopus Sandbox Gate Sublayer";
    sublayer.displayData.description =
        (LPWSTR)L"Sublayer holding the AgentOctopus per-session egress allowlist";
    sublayer.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
    sublayer.providerKey = (GUID *)&OCT_PROVIDER_KEY;
    sublayer.weight = 0xFFFF; /* highest sublayer weight: our arbitration is authoritative */

    rc = FwpmSubLayerAdd0(engine, &sublayer, NULL);
    if (rc != ERROR_SUCCESS && rc != FWP_E_ALREADY_EXISTS) {
        return HRESULT_FROM_WIN32(rc);
    }
    return S_OK;
}

/*
 * Build + add one ALE connect filter. This is the shared body for all four
 * rules of spec §4c; the caller supplies the layer, the condition list, the
 * action type, the weight, and the derived filter key.
 *
 * conditions: array of FWPM_FILTER_CONDITION0 (already populated, with the
 * APP_ID condition first). All conditions must match (AND).
 *
 * Returns S_OK when the filter was added (or already existed). A failure
 * HRESULT otherwise; the caller is responsible for rolling back earlier
 * filters.
 */
static HRESULT wfp_add_filter(HANDLE engine, const GUID *layerKey,
                              FWPM_FILTER_CONDITION0 *conditions,
                              UINT32 numConditions, UINT32 actionType,
                              UINT64 weight, const GUID *filterKey,
                              PCWSTR name) {
    FWPM_FILTER0 filter;
    DWORD rc;

    ZeroMemory(&filter, sizeof(filter));
    filter.filterKey = *filterKey;
    filter.layerKey = *(GUID *)layerKey;
    filter.displayData.name = (LPWSTR)name;
    filter.displayData.description =
        (LPWSTR)L"AgentOctopus per-session egress allowlist rule";
    filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
    filter.providerKey = (GUID *)&OCT_PROVIDER_KEY;
    filter.subLayerKey = OCT_SUBLAYER_KEY;
    filter.weight.type = FWP_UINT64;
    filter.weight.uint64 = (UINT64 *)&weight;
    filter.action.type = actionType;
    filter.numFilterConditions = numConditions;
    filter.filterCondition = conditions;

    rc = FwpmFilterAdd0(engine, &filter, NULL, NULL);
    if (rc != ERROR_SUCCESS && rc != FWP_E_ALREADY_EXISTS) {
        return HRESULT_FROM_WIN32(rc);
    }
    return S_OK;
}

/*
 * Roll back the first `count` filters of a lease (used when install fails
 * partway). Best-effort: deletion failures are logged but do not mask the
 * original install failure. Never deletes filters belonging to another
 * session -- the keys come from the partially-built lease.
 */
static void wfp_rollback_filters(HANDLE engine, const OCT_LEASE *lease,
                                 DWORD count) {
    DWORD i;
    for (i = 0; i < count && i < lease->filterCount; i++) {
        DWORD rc = FwpmFilterDeleteByKey0(engine, &lease->filterKeys[i]);
        if (rc != ERROR_SUCCESS && rc != FWP_E_FILTER_NOT_FOUND) {
            diag(L"rollback FwpmFilterDeleteByKey0", rc);
        }
    }
}

/*
 * install_gate -- create the four persistent filters of spec §4c for one
 * session and record the lease. On any failure after some filters were added,
 * the partial set is rolled back so no half-installed gate is left.
 *
 * proxyPort: the loopback TCP port the egress proxy listens on.
 * hasV6Loopback: TRUE when the proxy also listens on ::1 (rule 3 is added);
 *   FALSE to omit rule 3 (rule 4 then blocks all V6).
 *
 * Returns S_OK and fills *lease (with filterCount + filterKeys) on success.
 */
static HRESULT install_gate(HANDLE engine, const char *sessionId,
                            const char *appIdPath, const char *proxyHost,
                            unsigned long proxyPort, const char *jobName,
                            BOOL hasV6Loopback, OCT_LEASE *lease) {
    FWP_BYTE_BLOB *appIdBlob = NULL;
    HRESULT hr = S_OK;
    DWORD err = 0;
    DWORD added = 0;
    WCHAR pathW[OCT_PATH_MAX];
    int isLoopbackV4;
    int isLoopbackV6;

    ZeroMemory(lease, sizeof(*lease));

    /* ---- validate + copy the narrow inputs into the lease ------------- */
    if (sessionId == NULL || sessionId[0] == '\0' ||
        strlen(sessionId) >= OCT_SESSIONID_MAX) {
        return E_INVALIDARG;
    }
    if (appIdPath == NULL || appIdPath[0] == '\0' ||
        strlen(appIdPath) >= OCT_PATH_MAX) {
        return E_INVALIDARG;
    }
    if (jobName == NULL || jobName[0] == '\0' ||
        strlen(jobName) >= OCT_JOBNAME_MAX) {
        return E_INVALIDARG;
    }
    if (proxyPort == 0 || proxyPort > 65535) {
        return E_INVALIDARG;
    }

    strcpy_s(lease->sessionId, ARRAYSIZE(lease->sessionId), sessionId);
    strcpy_s(lease->appIdPath, ARRAYSIZE(lease->appIdPath), appIdPath);
    strcpy_s(lease->jobName, ARRAYSIZE(lease->jobName), jobName);

    /* Decide which loopback permit(s) to install from proxyHost. We accept
     * only "127.0.0.1" and "::1" (and the empty/NULL-v4 default) — the proxy
     * is always loopback (spec §4c). Any other host is rejected: the gate is
     * not a general egress-granting tool. */
    isLoopbackV4 = (proxyHost != NULL && strcmp(proxyHost, "127.0.0.1") == 0);
    isLoopbackV6 = (proxyHost != NULL &&
                    (strcmp(proxyHost, "::1") == 0 || strcmp(proxyHost, "[::1]") == 0));
    if (!isLoopbackV4 && !isLoopbackV6) {
        return E_INVALIDARG;
    }
    /* Rule 3 (V6 permit) is added only when the proxy listens on ::1. When
     * the caller's proxyHost is IPv4 loopback we still honor the caller's
     * hasV6Loopback signal (the TS side knows whether the proxy dual-binds).
     * When proxyHost is ::1 the V6 permit is mandatory. */
    if (isLoopbackV6) hasV6Loopback = TRUE;

    /* Canonicalize the sandbox node.exe DOS path into the WFP application-id
     * blob for the FWPM_CONDITION_ALE_APP_ID condition (type FWP_BYTE_BLOB,
     * the lower-case fully-qualified device path). FwpmGetAppIdFromFileName0
     * requires the file to exist on the local machine at install time; on any
     * failure (missing file / non-canonicalizable path) we return the error
     * fail-closed and install NO filter. The returned blob is owned by us and
     * freed with FwpmFreeMemory0 on every exit path below. */
    ascii_to_wide(appIdPath, pathW, ARRAYSIZE(pathW));
    err = FwpmGetAppIdFromFileName0(pathW, &appIdBlob);
    if (err != ERROR_SUCCESS) {
        return HRESULT_FROM_WIN32(err);
    }

    hr = wfp_ensure_provider_and_sublayer(engine);
    if (FAILED(hr)) goto done;

    /* ================================================================
     * Rule 1 -- high-weight PERMIT: app-id path AND TCP AND
     *           remote-addr==127.0.0.1 AND remote-port==proxyPort (V4).
     * ================================================================ */
    if (isLoopbackV4) {
        FWPM_FILTER_CONDITION0 cond[4];
        FWP_CONDITION_VALUE blobVal;
        FWP_CONDITION_VALUE protoVal;
        FWP_CONDITION_VALUE addrVal;
        FWP_CONDITION_VALUE portVal;
        GUID key;

        ZeroMemory(cond, sizeof(cond));
        /* Remote address: 127.0.0.1. We use the FWP_UINT32 encoding, which
         * FWPM_CONDITION_IP_REMOTE_ADDRESS also accepts alongside
         * FWP_V4_ADDR_MASK (verified against MS Learn). The two encodings
         * differ in byte order, which is exactly why FWP_UINT32 is chosen
         * here:
         *   - FWP_UINT32 for this condition is NETWORK byte order (Microsoft's
         *     examples pass inet_addr("x.x.x.x"), which returns network order),
         *     so 127.0.0.1 is 0x0100007F.
         *   - The FWP_V4_ADDR_AND_MASK struct, by contrast, holds the address
         *     in HOST order per its own struct page (127.0.0.1 == 0x7F000001),
         *     making it the ambiguity-prone choice.
         * We hardcode the network-order constant rather than call inet_addr:
         * the V4 permit path is only reached when proxyHost is the fixed
         * loopback "127.0.0.1" (the isLoopbackV4 gate above), so no runtime
         * parse is needed, and avoiding Winsock keeps the import surface
         * minimal (no Ws2_32.lib / no WSAStartup). */
        addrVal.type = FWP_UINT32;
        addrVal.uint32 = 0x0100007Fu; /* 127.0.0.1, network byte order */

        /* Scoping value: the application-id blob canonicalized above. The
         * condition matches any connect from the sandbox node.exe binary
         * (the restricted-token child), regardless of token type. */
        blobVal.type = FWP_BYTE_BLOB_TYPE;
        blobVal.byteBlob = appIdBlob;
        protoVal.type = FWP_UINT8;
        protoVal.uint8 = (UINT8)IPPROTO_TCP;
        /* addrVal (FWP_UINT32, network order) is set above where the byte-order
         * rationale is documented. */
        portVal.type = FWP_UINT16;
        portVal.uint16 = (UINT16)proxyPort;

        cond[0].fieldKey = FWPM_CONDITION_ALE_APP_ID;
        cond[0].matchType = FWP_MATCH_EQUAL;
        cond[0].conditionValue = blobVal;
        cond[1].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
        cond[1].matchType = FWP_MATCH_EQUAL;
        cond[1].conditionValue = protoVal;
        cond[2].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        cond[2].matchType = FWP_MATCH_EQUAL;
        cond[2].conditionValue = addrVal;
        cond[3].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        cond[3].matchType = FWP_MATCH_EQUAL;
        cond[3].conditionValue = portVal;

        make_filter_key(sessionId, 0, &key);
        lease->filterKeys[added] = key;
        hr = wfp_add_filter(engine, &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                            cond, 4, FWP_ACTION_PERMIT, OCT_WEIGHT_PERMIT,
                            &key, L"AgentOctopus gate: permit proxy (V4)");
        if (FAILED(hr)) goto rollback;
        added++;
    }

    /* ================================================================
     * Rule 2 -- low-weight BLOCK: all other V4 for this app-id path.
     * ================================================================ */
    {
        FWPM_FILTER_CONDITION0 cond[1];
        FWP_CONDITION_VALUE blobVal;
        GUID key;

        ZeroMemory(cond, sizeof(cond));
        blobVal.type = FWP_BYTE_BLOB_TYPE;
        blobVal.byteBlob = appIdBlob;
        cond[0].fieldKey = FWPM_CONDITION_ALE_APP_ID;
        cond[0].matchType = FWP_MATCH_EQUAL;
        cond[0].conditionValue = blobVal;

        make_filter_key(sessionId, 1, &key);
        lease->filterKeys[added] = key;
        hr = wfp_add_filter(engine, &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                            cond, 1, FWP_ACTION_BLOCK, OCT_WEIGHT_BLOCK,
                            &key, L"AgentOctopus gate: block other V4");
        if (FAILED(hr)) goto rollback;
        added++;
    }

    /* ================================================================
     * Rule 3 -- conditional high-weight V6 PERMIT (only when the proxy
     *           listens on ::1): app-id path AND TCP AND remote-addr==::1
     *           AND remote-port==proxyPort.
     * ================================================================ */
    if (hasV6Loopback) {
        FWPM_FILTER_CONDITION0 cond[4];
        FWP_V6_ADDR_AND_MASK addr6;
        FWP_CONDITION_VALUE blobVal;
        FWP_CONDITION_VALUE protoVal;
        FWP_CONDITION_VALUE addrVal;
        FWP_CONDITION_VALUE portVal;
        GUID key;
        static const BYTE loopback6[16] =
            { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1 }; /* ::1 */

        ZeroMemory(cond, sizeof(cond));
        ZeroMemory(&addr6, sizeof(addr6));
        /* FWP_V6_ADDR_AND_MASK.addr is a 16-BYTE array, so unlike the V4 case
         * there is NO host/network byte-order ambiguity: an IPv6 address is a
         * byte sequence, not an integer. ::1 is 15 zero bytes then a trailing
         * 0x01 (== in6addr_loopback), in wire order. prefixLength 128 = exact
         * host match. */
        memcpy(addr6.addr, loopback6, 16);
        addr6.prefixLength = 128; /* exact host match */

        blobVal.type = FWP_BYTE_BLOB_TYPE;
        blobVal.byteBlob = appIdBlob;
        protoVal.type = FWP_UINT8;
        protoVal.uint8 = (UINT8)IPPROTO_TCP;
        addrVal.type = FWP_V6_ADDR_MASK;
        addrVal.v6AddrMask = &addr6;
        portVal.type = FWP_UINT16;
        portVal.uint16 = (UINT16)proxyPort;

        cond[0].fieldKey = FWPM_CONDITION_ALE_APP_ID;
        cond[0].matchType = FWP_MATCH_EQUAL;
        cond[0].conditionValue = blobVal;
        cond[1].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
        cond[1].matchType = FWP_MATCH_EQUAL;
        cond[1].conditionValue = protoVal;
        cond[2].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        cond[2].matchType = FWP_MATCH_EQUAL;
        cond[2].conditionValue = addrVal;
        cond[3].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        cond[3].matchType = FWP_MATCH_EQUAL;
        cond[3].conditionValue = portVal;

        make_filter_key(sessionId, 2, &key);
        lease->filterKeys[added] = key;
        hr = wfp_add_filter(engine, &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                            cond, 4, FWP_ACTION_PERMIT, OCT_WEIGHT_PERMIT,
                            &key, L"AgentOctopus gate: permit proxy (V6)");
        if (FAILED(hr)) goto rollback;
        added++;
    }

    /* ================================================================
     * Rule 4 -- low-weight V6 BLOCK: all other V6 for this app-id path.
     *           (If rule 3 was omitted this blocks all V6.)
     * ================================================================ */
    {
        FWPM_FILTER_CONDITION0 cond[1];
        FWP_CONDITION_VALUE blobVal;
        GUID key;

        ZeroMemory(cond, sizeof(cond));
        blobVal.type = FWP_BYTE_BLOB_TYPE;
        blobVal.byteBlob = appIdBlob;
        cond[0].fieldKey = FWPM_CONDITION_ALE_APP_ID;
        cond[0].matchType = FWP_MATCH_EQUAL;
        cond[0].conditionValue = blobVal;

        make_filter_key(sessionId, 3, &key);
        lease->filterKeys[added] = key;
        hr = wfp_add_filter(engine, &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                            cond, 1, FWP_ACTION_BLOCK, OCT_WEIGHT_BLOCK,
                            &key, L"AgentOctopus gate: block other V6");
        if (FAILED(hr)) goto rollback;
        added++;
    }

    lease->filterCount = added;
    hr = S_OK;
    goto done;

rollback:
    /* A filter failed after `added` earlier ones were installed: remove them
     * so no half-installed gate is left (fail-closed, no partial artifact). */
    lease->filterCount = added;
    wfp_rollback_filters(engine, lease, added);
    lease->filterCount = 0;

done:
    if (appIdBlob != NULL) FwpmFreeMemory0((void **)&appIdBlob);
    return hr;
}

/* ------------------------------------------------------------------ */
/* Service-side remove verification                                    */
/* ------------------------------------------------------------------ */

/*
 * job_confirmed_dead -- the security invariant behind remove-gate (spec §4c,
 * Acceptance #9). The service itself resolves the named Job and confirms it
 * is dead/empty; it does NOT rely on the caller's say-so.
 *
 *   - OpenJobObjectW returns ERROR_FILE_NOT_FOUND -> the Job is gone -> dead.
 *   - Otherwise query BasicAccountingInfo.ActiveProcesses; 0 -> dead. If the
 *     count is non-zero we poll briefly (KILL_ON_JOB_CLOSE unwind window),
 *     then give up -> NOT confirmed dead.
 *
 * Returns TRUE only when the Job is confirmed dead. Any open/query failure
 * (other than not-found) is treated as NOT dead (fail-closed).
 *
 * RUN-12 NAMESPACE: the helper creates the named Job in the GLOBAL object
 * namespace (CreateJobObjectW "Global\<jobName>", --global-job) so this
 * session-0 service can see the interactive-session Job. If we opened the
 * BARE name here, session 0's Local\ namespace would report the helper's Job
 * as ERROR_FILE_NOT_FOUND -> "dead" -> remove-gate would be allowed while the
 * child is alive (run-12 CI: `remove-gate while Job alive -> {"ok":true}`).
 * So this routine prefixes Global\ (unless the caller already supplied a
 * namespace prefix). The lease stores the bare jobName; the prefix is applied
 * at open time only.
 */
static BOOL job_confirmed_dead(PCWSTR jobName) {
    HANDLE job;
    DWORD err;
    BOOL dead = FALSE;
    WCHAR openName[MAX_PATH];
    PCWSTR name = jobName;

    /* Apply the Global\ prefix unless the name already carries an explicit
     * object-namespace prefix (contains a backslash). */
    if (wcschr(jobName, L'\\') == NULL) {
        if (swprintf_s(openName, ARRAYSIZE(openName), L"Global\\%ls", jobName) >= 0) {
            name = openName;
        }
    }

    job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, name);
    if (job == NULL) {
        err = GetLastError();
        if (err == ERROR_FILE_NOT_FOUND) {
            return TRUE; /* Job already gone -> dead */
        }
        /* Cannot open to check (access denied, etc.) -> not confirmed. */
        diag(L"OpenJobObjectW", err);
        return FALSE;
    }

    {
        DWORD waited = 0;
        for (;;) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
            DWORD retLen = 0;
            ZeroMemory(&acct, sizeof(acct));
            if (!QueryInformationJobObject(job,
                    JobObjectBasicAccountingInformation,
                    &acct, sizeof(acct), &retLen)) {
                diag(L"QueryInformationJobObject", GetLastError());
                dead = FALSE;
                break;
            }
            if (acct.ActiveProcesses == 0) {
                dead = TRUE;
                break;
            }
            if (waited >= OCT_JOB_DRAIN_TIMEOUT_MS) {
                dead = FALSE;
                break;
            }
            Sleep(OCT_JOB_DRAIN_POLL_MS);
            waited += OCT_JOB_DRAIN_POLL_MS;
        }
    }

    CloseHandle(job);
    return dead;
}

/*
 * remove_gate -- the verified, fail-closed gate removal. Chain (spec §4c):
 *   1. Resolve the lease for sessionId (the service's independent record).
 *   2. OpenJobObjectW(lease.jobName) and confirm dead/empty.
 *   3. (The lease itself IS the recorded app-id path + filter keys; a remove
 *      request carries only sessionId, so the identity check is "the lease
 *      exists and its Job is dead" -- we delete exactly the lease's recorded
 *      keys, never caller-supplied ones.)
 *   4. FwpmFilterDeleteByKey0 each recorded filter; drop the lease.
 * REFUSE (return a failure HRESULT) if any check fails; the gate stays.
 */
static HRESULT remove_gate(HANDLE engine, const char *sessionId) {
    LONG idx;
    OCT_LEASE lease;
    WCHAR jobW[OCT_JOBNAME_MAX];
    DWORD i;
    HRESULT hr = S_OK;

    if (sessionId == NULL || sessionId[0] == '\0') return E_INVALIDARG;

    EnterCriticalSection(&g_leases.lock);
    idx = lease_table_find_locked(sessionId);
    if (idx < 0) {
        LeaveCriticalSection(&g_leases.lock);
        /* No lease -> nothing we installed -> refuse (we never delete a gate
         * we cannot identify). */
        return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    }
    lease = g_leases.entries[idx]; /* copy out; drop the lock during I/O */
    LeaveCriticalSection(&g_leases.lock);

    /* Confirm the Job is dead SERVICE-SIDE. */
    ascii_to_wide(lease.jobName, jobW, ARRAYSIZE(jobW));
    if (!job_confirmed_dead(jobW)) {
        return HRESULT_FROM_WIN32(ERROR_BUSY); /* refuse: job not confirmed dead */
    }

    /* Delete exactly the lease's recorded filter keys. */
    for (i = 0; i < lease.filterCount; i++) {
        DWORD rc = FwpmFilterDeleteByKey0(engine, &lease.filterKeys[i]);
        if (rc != ERROR_SUCCESS && rc != FWP_E_FILTER_NOT_FOUND) {
            /* A filter that should exist could not be deleted. The Job is
             * already dead, so a leftover BLOCK filter is fail-closed residue
             * (residual DoS), not a containment breach -- but we still report
             * failure so the caller sees the imperfect cleanup, and we keep
             * the lease so a later sweep can retry. */
            diag(L"remove FwpmFilterDeleteByKey0", rc);
            hr = HRESULT_FROM_WIN32(rc);
            /* Continue deleting the rest, then report the failure. */
        }
    }

    if (SUCCEEDED(hr)) {
        EnterCriticalSection(&g_leases.lock);
        idx = lease_table_find_locked(sessionId);
        if (idx >= 0) lease_table_remove_locked(idx);
        LeaveCriticalSection(&g_leases.lock);
        lease_unpersist(sessionId);
    }
    return hr;
}

/*
 * sweep_dead_leases -- startup sweep. For every lease whose Job is already
 * dead, remove the gate. This reclaims persistent filters leaked by a crashed
 * run (a crash can only leave fail-closed BLOCK filters; the sweep clears
 * them once the owning Job is gone).
 */
static void sweep_dead_leases(HANDLE engine) {
    char ids[OCT_LEASE_TABLE_MAX][OCT_SESSIONID_MAX];
    DWORD n = 0;
    DWORD i;

    /* Snapshot the live session ids under the lock, then remove outside it. */
    EnterCriticalSection(&g_leases.lock);
    for (i = 0; i < g_leases.count && n < OCT_LEASE_TABLE_MAX; i++) {
        strcpy_s(ids[n], OCT_SESSIONID_MAX, g_leases.entries[i].sessionId);
        n++;
    }
    LeaveCriticalSection(&g_leases.lock);

    for (i = 0; i < n; i++) {
        /* remove_gate re-resolves the lease and re-confirms death, so a lease
         * that came alive between snapshot and sweep is left alone. */
        (void)remove_gate(engine, ids[i]);
    }
}

/* ------------------------------------------------------------------ */
/* Lease re-load from the registry (startup)                           */
/* ------------------------------------------------------------------ */

/*
 * hex_nibble -- convert one ASCII hex char to its 0-15 value, or -1.
 */
static int hex_nibble(WCHAR c) {
    if (c >= L'0' && c <= L'9') return (int)(c - L'0');
    if (c >= L'a' && c <= L'f') return (int)(c - L'a') + 10;
    if (c >= L'A' && c <= L'F') return (int)(c - L'A') + 10;
    return -1;
}

/*
 * parse_guid_token -- parse one "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"
 * token (exactly 38 wide chars) back into a GUID. Strict, hand-rolled hex
 * parse (no scanf) so the accepted shape is exact and deterministic.
 * Returns TRUE on a clean parse.
 *
 * Layout inside the braces: 8 hex, '-', 4 hex, '-', 4 hex, '-', 4 hex, '-',
 * 12 hex. The first three groups are Data1/Data2/Data3 (most-significant
 * nibble first); the final 8 hex pairs map to Data4[0..7] in order.
 */
static BOOL parse_guid_token(const WCHAR *tok, GUID *out) {
    /* Indices of the 32 hex digits within tok[1..36] (skipping the 4 '-'). */
    int digits[32];
    int di = 0;
    int i;

    if (tok == NULL || out == NULL) return FALSE;
    if (wcslen(tok) != 38) return FALSE;
    if (tok[0] != L'{' || tok[37] != L'}') return FALSE;
    if (tok[9] != L'-' || tok[14] != L'-' || tok[19] != L'-' || tok[24] != L'-') {
        return FALSE;
    }

    for (i = 1; i <= 36; i++) {
        if (tok[i] == L'-') continue;
        digits[di] = hex_nibble(tok[i]);
        if (digits[di] < 0) return FALSE;
        di++;
    }
    if (di != 32) return FALSE;

    /* Data1 = first 8 nibbles; Data2 = next 4; Data3 = next 4. */
    out->Data1 = 0;
    for (i = 0; i < 8; i++)  out->Data1 = (out->Data1 << 4) | (UINT32)digits[i];
    out->Data2 = 0;
    for (i = 8; i < 12; i++) out->Data2 = (USHORT)((out->Data2 << 4) | (USHORT)digits[i]);
    out->Data3 = 0;
    for (i = 12; i < 16; i++) out->Data3 = (USHORT)((out->Data3 << 4) | (USHORT)digits[i]);
    /* Data4[0..7] = remaining 16 nibbles as 8 bytes. */
    for (i = 0; i < 8; i++) {
        out->Data4[i] = (BYTE)((digits[16 + i * 2] << 4) | digits[16 + i * 2 + 1]);
    }
    return TRUE;
}

/*
 * leases_reload -- read every persisted lease value back into the in-memory
 * table at startup so the sweep can act on gates installed before a restart.
 * Malformed values are skipped (and left for manual inspection); a value that
 * cannot be parsed is NOT deleted silently. Best-effort: a registry read
 * failure leaves the table empty (the sweep then has nothing to reclaim,
 * which is safe -- leftover filters stay fail-closed).
 */
static void leases_reload(void) {
    HKEY key = NULL;
    DWORD index = 0;

    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, OCT_LEASE_REG_PATH, 0,
                      KEY_READ, &key) != ERROR_SUCCESS) {
        return; /* no leases persisted yet */
    }

    for (;;) {
        WCHAR valueName[OCT_SESSIONID_MAX];
        DWORD valueNameChars = ARRAYSIZE(valueName);
        WCHAR data[OCT_PATH_MAX + OCT_JOBNAME_MAX +
                   (OCT_FILTERKEY_MAX * OCT_FILTER_COUNT) + 16];
        DWORD dataBytes = sizeof(data);
        DWORD type = 0;
        LSTATUS st;

        st = RegEnumValueW(key, index, valueName, &valueNameChars, NULL,
                           &type, (LPBYTE)data, &dataBytes);
        if (st == ERROR_NO_MORE_ITEMS) break;
        if (st != ERROR_SUCCESS) { index++; continue; }
        index++;

        if (type != REG_SZ) continue;

        /* Split "appIdPath|jobName|k0,k1,..." on the two '|' separators. */
        {
            WCHAR *sep1 = wcschr(data, L'|');
            WCHAR *sep2;
            OCT_LEASE lease;
            WCHAR *keysStart;
            WCHAR *cursor;
            DWORD kcount = 0;
            BOOL parseOk = TRUE;

            ZeroMemory(&lease, sizeof(lease));
            if (sep1 == NULL) continue;
            *sep1 = L'\0';
            sep2 = wcschr(sep1 + 1, L'|');
            if (sep2 == NULL) continue;
            *sep2 = L'\0';

            wide_to_ascii(valueName, lease.sessionId, ARRAYSIZE(lease.sessionId));
            wide_to_ascii(data, lease.appIdPath, ARRAYSIZE(lease.appIdPath));
            wide_to_ascii(sep1 + 1, lease.jobName, ARRAYSIZE(lease.jobName));

            keysStart = sep2 + 1;
            cursor = keysStart;
            while (*cursor != L'\0' && kcount < OCT_FILTER_COUNT) {
                WCHAR token[OCT_FILTERKEY_MAX];
                DWORD t = 0;
                while (cursor[0] != L'\0' && cursor[0] != L',') {
                    if (t + 1 >= ARRAYSIZE(token)) { parseOk = FALSE; break; }
                    token[t++] = *cursor++;
                }
                if (!parseOk) break;
                token[t] = L'\0';
                if (*cursor == L',') cursor++;
                if (t == 0) break; /* trailing comma / empty token */
                if (!parse_guid_token(token, &lease.filterKeys[kcount])) {
                    parseOk = FALSE;
                    break;
                }
                kcount++;
            }
            if (!parseOk || kcount == 0) continue;
            lease.filterCount = kcount;

            EnterCriticalSection(&g_leases.lock);
            if (lease_table_find_locked(lease.sessionId) < 0) {
                (void)lease_table_add_locked(&lease);
            }
            LeaveCriticalSection(&g_leases.lock);
        }
    }

    RegCloseKey(key);
}

/* ------------------------------------------------------------------ */
/* JSON response emission                                              */
/* ------------------------------------------------------------------ */

/*
 * Format one filter key as "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" into out
 * (cap >= 39 chars). Used to build the install-gate filterKeys response.
 */
static void format_guid_json(const GUID *g, char *out, size_t outCap) {
    char tmp[64];
    (void)sprintf_s(tmp, sizeof(tmp),
        "{%08X-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
        (unsigned int)g->Data1, (unsigned int)g->Data2, (unsigned int)g->Data3,
        (unsigned int)g->Data4[0], (unsigned int)g->Data4[1],
        (unsigned int)g->Data4[2], (unsigned int)g->Data4[3],
        (unsigned int)g->Data4[4], (unsigned int)g->Data4[5],
        (unsigned int)g->Data4[6], (unsigned int)g->Data4[7]);
    strncpy_s(out, outCap, tmp, _TRUNCATE);
}

/*
 * Build the JSON response body (no length prefix) into out. Returns the byte
 * count (excluding NUL), or 0 on overflow. Responses are ASCII-only; the
 * filter key GUIDs are the only dynamic content.
 */
static size_t build_install_response(const OCT_LEASE *lease, char *out, size_t outCap) {
    char keys[(OCT_FILTERKEY_MAX + 4) * OCT_FILTER_COUNT];
    size_t used = 0;
    DWORD i;
    int wrote;

    keys[0] = '\0';
    for (i = 0; i < lease->filterCount; i++) {
        char g[OCT_FILTERKEY_MAX + 2];
        format_guid_json(&lease->filterKeys[i], g, sizeof(g));
        if (i + 1 < lease->filterCount) {
            wrote = sprintf_s(keys + used, sizeof(keys) - used, "\"%s\",", g);
        } else {
            wrote = sprintf_s(keys + used, sizeof(keys) - used, "\"%s\"", g);
        }
        if (wrote < 0) return 0;
        used += (size_t)wrote;
    }

    wrote = sprintf_s(out, outCap, "{\"ok\":true,\"filterKeys\":[%s]}", keys);
    if (wrote < 0) return 0;
    return (size_t)wrote;
}

/* ------------------------------------------------------------------ */
/* Request dispatch                                                    */
/* ------------------------------------------------------------------ */

/*
 * handle_request -- parse one framed JSON request body and produce the framed
 * JSON response body. respBuf/respCap carry the response BODY (no prefix);
 * the caller adds the 4-byte length prefix. Returns the response body byte
 * count (>= 0), or -1 if the response could not be built.
 *
 * Every failure path yields a well-formed {"ok":false,...} response; the
 * service never crashes on a malformed request.
 */
static int handle_request(HANDLE engine, const char *body,
                          char *respBuf, size_t respCap) {
    char op[32];
    int wrote;

    if (body == NULL || respBuf == NULL || respCap == 0) return -1;

    if (!json_get_string(body, "op", op, sizeof(op))) {
        wrote = sprintf_s(respBuf, respCap, "{\"ok\":false,\"error\":\"bad-op\"}");
        return (wrote < 0) ? -1 : wrote;
    }

    if (strcmp(op, "install-gate") == 0) {
        char sessionId[OCT_SESSIONID_MAX];
        char appIdPath[OCT_PATH_MAX];
        char proxyHost[OCT_PROXYHOST_MAX];
        char jobName[OCT_JOBNAME_MAX];
        unsigned long proxyPort = 0;
        BOOL proxyV6Loopback = FALSE; /* fail-closed default: no V6 permit */
        OCT_LEASE lease;
        HRESULT hr;

        if (!json_get_string(body, "sessionId", sessionId, sizeof(sessionId)) ||
            !json_get_string(body, "appIdPath", appIdPath, sizeof(appIdPath)) ||
            !json_get_string(body, "proxyHost", proxyHost, sizeof(proxyHost)) ||
            !json_get_string(body, "jobName", jobName, sizeof(jobName)) ||
            !json_get_uint(body, "proxyPort", &proxyPort)) {
            wrote = sprintf_s(respBuf, respCap,
                              "{\"ok\":false,\"error\":\"bad-install-args\"}");
            return (wrote < 0) ? -1 : wrote;
        }

        /* Read the explicit proxyV6Loopback the Task 10 client sends (exact
         * key name "proxyV6Loopback"). The service must not guess: when the
         * field is present it drives install_gate's hasV6Loopback; when absent
         * the fail-closed FALSE default stands (rule 3 omitted, rule 4 blocks
         * all V6). install_gate still force-enables the V6 permit when
         * proxyHost is ::1 (gate-svc.c isLoopbackV6 path), so a TRUE here is
         * only meaningful for a dual-binding V4 proxy. */
        (void)json_get_bool(body, "proxyV6Loopback", &proxyV6Loopback);

        hr = install_gate(engine, sessionId, appIdPath, proxyHost, proxyPort,
                          jobName, proxyV6Loopback, &lease);
        if (FAILED(hr)) {
            diag(L"install-gate", (DWORD)hr);
            wrote = sprintf_s(respBuf, respCap,
                              "{\"ok\":false,\"error\":\"install-failed\"}");
            return (wrote < 0) ? -1 : wrote;
        }

        /* Record the lease (memory + registry). A persistence failure rolls
         * back the just-installed gate so we never have a gate with no lease
         * to verify a future remove against. */
        EnterCriticalSection(&g_leases.lock);
        if (!lease_table_add_locked(&lease)) {
            LeaveCriticalSection(&g_leases.lock);
            wfp_rollback_filters(engine, &lease, lease.filterCount);
            wrote = sprintf_s(respBuf, respCap,
                              "{\"ok\":false,\"error\":\"lease-table-full\"}");
            return (wrote < 0) ? -1 : wrote;
        }
        LeaveCriticalSection(&g_leases.lock);

        if (!lease_persist(&lease)) {
            EnterCriticalSection(&g_leases.lock);
            {
                LONG li = lease_table_find_locked(sessionId);
                if (li >= 0) lease_table_remove_locked(li);
            }
            LeaveCriticalSection(&g_leases.lock);
            wfp_rollback_filters(engine, &lease, lease.filterCount);
            wrote = sprintf_s(respBuf, respCap,
                              "{\"ok\":false,\"error\":\"lease-persist-failed\"}");
            return (wrote < 0) ? -1 : wrote;
        }

        {
            size_t n = build_install_response(&lease, respBuf, respCap);
            if (n == 0) return -1;
            return (int)n;
        }
    }

    if (strcmp(op, "remove-gate") == 0) {
        char sessionId[OCT_SESSIONID_MAX];
        HRESULT hr;

        if (!json_get_string(body, "sessionId", sessionId, sizeof(sessionId))) {
            wrote = sprintf_s(respBuf, respCap,
                              "{\"ok\":false,\"error\":\"bad-remove-args\"}");
            return (wrote < 0) ? -1 : wrote;
        }

        hr = remove_gate(engine, sessionId);
        if (FAILED(hr)) {
            wrote = sprintf_s(respBuf, respCap,
                              "{\"ok\":false,\"error\":\"remove-refused\"}");
            return (wrote < 0) ? -1 : wrote;
        }
        wrote = sprintf_s(respBuf, respCap, "{\"ok\":true}");
        return (wrote < 0) ? -1 : wrote;
    }

    wrote = sprintf_s(respBuf, respCap, "{\"ok\":false,\"error\":\"unknown-op\"}");
    return (wrote < 0) ? -1 : wrote;
}

/* ------------------------------------------------------------------ */
/* Pipe server                                                         */
/* ------------------------------------------------------------------ */

/*
 * serve_one_client -- handle a single connected pipe client: read the 4-byte
 * LE length prefix + the JSON body (strictly capped), dispatch, then write
 * the framed JSON response and close.
 *
 * Reads are bounded: a length prefix > OCT_RPC_MAX_BYTES is refused before
 * any body is read. Partial reads are looped until the full frame arrives or
 * the pipe breaks. This function never blocks indefinitely in service use
 * because the client (the trusted TS side) always sends a complete frame then
 * waits for the response.
 */
static void serve_one_client(HANDLE pipe, HANDLE engine) {
    BYTE lenBuf[OCT_RPC_LEN_BYTES];
    BYTE *body = NULL;
    DWORD bodyLen = 0;
    DWORD got;
    DWORD off;
    char respBody[1024];
    BYTE respFrame[OCT_RPC_LEN_BYTES + 1024];
    int respLen;
    DWORD wrote;

    /* ---- read the 4-byte length prefix -------------------------------- */
    off = 0;
    while (off < OCT_RPC_LEN_BYTES) {
        if (!ReadFile(pipe, lenBuf + off, OCT_RPC_LEN_BYTES - off, &got, NULL) ||
            got == 0) {
            return; /* client went away before sending a length */
        }
        off += got;
    }
    bodyLen = (DWORD)lenBuf[0]
            | ((DWORD)lenBuf[1] << 8)
            | ((DWORD)lenBuf[2] << 16)
            | ((DWORD)lenBuf[3] << 24);

    if (bodyLen == 0 || bodyLen > OCT_RPC_MAX_BYTES) {
        return; /* oversized / empty frame refused (fail-closed) */
    }

    /* ---- read the body ------------------------------------------------- */
    body = (BYTE *)LocalAlloc(LMEM_FIXED, bodyLen + 1);
    if (body == NULL) return;
    off = 0;
    while (off < bodyLen) {
        if (!ReadFile(pipe, body + off, bodyLen - off, &got, NULL) || got == 0) {
            LocalFree(body);
            return;
        }
        off += got;
    }
    body[bodyLen] = '\0'; /* NUL-terminate for the JSON scanner */

    /* ---- dispatch + respond ------------------------------------------- */
    respLen = handle_request(engine, (const char *)body, respBody, sizeof(respBody));
    LocalFree(body);
    if (respLen < 0 || (size_t)respLen > sizeof(respBody)) {
        return;
    }

    respFrame[0] = (BYTE)(respLen & 0xFF);
    respFrame[1] = (BYTE)((respLen >> 8) & 0xFF);
    respFrame[2] = (BYTE)((respLen >> 16) & 0xFF);
    respFrame[3] = (BYTE)((respLen >> 24) & 0xFF);
    memcpy(respFrame + OCT_RPC_LEN_BYTES, respBody, (size_t)respLen);

    if (!WriteFile(pipe, respFrame, OCT_RPC_LEN_BYTES + (DWORD)respLen,
                   &wrote, NULL)) {
        return;
    }
    /* Flush so the client sees the full response before we disconnect. */
    FlushFileBuffers(pipe);
}

/*
 * pipe_server_loop -- accept loop. Creates the pipe with the restrictive
 * DACL (installing user + Administrators + LocalSystem), then serves clients
 * one at a time. Runs until the stop event is set (service shutdown) or, in
 * foreground mode, until interrupted.
 *
 * stopEvent: signaled to request shutdown. We poll ConnectNamedPipe with an
 * overlapped wait so the accept can be interrupted by the stop event rather
 * than blocking forever on a client that never comes.
 */
static DWORD pipe_server_loop(HANDLE stopEvent) {
    PSECURITY_DESCRIPTOR sd = NULL;
    SECURITY_ATTRIBUTES sa;
    HANDLE engine = NULL;
    HRESULT hr;
    DWORD result = 0;

    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            OCT_PIPE_SDDL, SDDL_REVISION_1, &sd, NULL)) {
        diag(L"ConvertStringSecurityDescriptorToSecurityDescriptorW",
             GetLastError());
        return 1;
    }

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;

    hr = wfp_open(&engine);
    if (FAILED(hr)) {
        diag(L"FwpmEngineOpen0", (DWORD)hr);
        LocalFree(sd);
        return 1;
    }

    /* Startup sweep: reclaim any gates whose Jobs died while we were down. */
    sweep_dead_leases(engine);

    for (;;) {
        HANDLE pipe;
        OVERLAPPED ov;
        HANDLE connEvent;
        BOOL connected;

        /* Check for shutdown before blocking on a new client. */
        if (WaitForSingleObject(stopEvent, 0) == WAIT_OBJECT_0) break;

        pipe = CreateNamedPipeW(OCT_PIPE_NAME,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            4096, 4096, 0, &sa);
        if (pipe == INVALID_HANDLE_VALUE) {
            diag(L"CreateNamedPipeW", GetLastError());
            result = 1;
            break;
        }

        connEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (connEvent == NULL) {
            diag(L"CreateEventW", GetLastError());
            CloseHandle(pipe);
            result = 1;
            break;
        }
        ZeroMemory(&ov, sizeof(ov));
        ov.hEvent = connEvent;

        connected = ConnectNamedPipe(pipe, &ov);
        if (!connected) {
            DWORD cerr = GetLastError();
            if (cerr == ERROR_IO_PENDING) {
                /* Wait for either a client connection or shutdown. */
                HANDLE waitSet[2];
                DWORD w;
                waitSet[0] = connEvent;
                waitSet[1] = stopEvent;
                w = WaitForMultipleObjects(2, waitSet, FALSE, INFINITE);
                if (w == WAIT_OBJECT_0 + 1) {
                    /* Shutdown requested while waiting for a client. */
                    CancelIo(pipe);
                    CloseHandle(connEvent);
                    CloseHandle(pipe);
                    break;
                }
                if (w != WAIT_OBJECT_0) {
                    CancelIo(pipe);
                    CloseHandle(connEvent);
                    CloseHandle(pipe);
                    result = 1;
                    break;
                }
                /* Connection completed; verify the overlapped result. */
                {
                    DWORD transferred = 0;
                    if (!GetOverlappedResult(pipe, &ov, &transferred, FALSE)) {
                        CloseHandle(connEvent);
                        CloseHandle(pipe);
                        continue; /* spurious; accept again */
                    }
                }
            } else if (cerr == ERROR_PIPE_CONNECTED) {
                /* Client already connected between create and connect. */
            } else {
                diag(L"ConnectNamedPipe", cerr);
                CloseHandle(connEvent);
                CloseHandle(pipe);
                result = 1;
                break;
            }
        }

        serve_one_client(pipe, engine);

        DisconnectNamedPipe(pipe);
        CloseHandle(connEvent);
        CloseHandle(pipe);

        /* Re-check shutdown between clients. */
        if (WaitForSingleObject(stopEvent, 0) == WAIT_OBJECT_0) break;
    }

    if (engine != NULL) FwpmEngineClose0(engine);
    if (sd != NULL) LocalFree(sd);
    return result;
}

/* ------------------------------------------------------------------ */
/* Windows service plumbing                                            */
/* ------------------------------------------------------------------ */

static SERVICE_STATUS_HANDLE g_statusHandle = NULL;
static HANDLE g_stopEvent = NULL;

static void report_status(DWORD state, DWORD win32ExitCode) {
    SERVICE_STATUS st;
    if (g_statusHandle == NULL) return;
    ZeroMemory(&st, sizeof(st));
    st.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    st.dwCurrentState = state;
    st.dwWin32ExitCode = win32ExitCode;
    st.dwControlsAccepted =
        (state == SERVICE_RUNNING) ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN) : 0;
    st.dwWaitHint = (state == SERVICE_RUNNING) ? 0 : 30000;
    SetServiceStatus(g_statusHandle, &st);
}

/* Service control handler: STOP/SHUTDOWN -> signal the accept loop to wind
 * down. */
static DWORD WINAPI service_ctrl_handler(DWORD control, DWORD eventType,
                                         LPVOID eventData, LPVOID context) {
    (void)eventType;
    (void)eventData;
    (void)context;
    switch (control) {
    case SERVICE_CONTROL_STOP:
    case SERVICE_CONTROL_SHUTDOWN:
        report_status(SERVICE_STOP_PENDING, NO_ERROR);
        if (g_stopEvent != NULL) SetEvent(g_stopEvent);
        return NO_ERROR;
    case SERVICE_CONTROL_INTERROGATE:
        return NO_ERROR;
    default:
        return ERROR_CALL_NOT_IMPLEMENTED;
    }
}

/* Service main: register the control handler, report RUNNING, then run the
 * pipe accept loop on this thread until the stop event fires. */
static VOID WINAPI service_main(DWORD argc, LPWSTR *argv) {
    DWORD serverResult;
    (void)argc;
    (void)argv;

    g_statusHandle = RegisterServiceCtrlHandlerExW(OCT_SERVICE_NAME,
                                                   service_ctrl_handler, NULL);
    if (g_statusHandle == NULL) {
        diag(L"RegisterServiceCtrlHandlerExW", GetLastError());
        return;
    }

    g_stopEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (g_stopEvent == NULL) {
        diag(L"CreateEventW(stop)", GetLastError());
        report_status(SERVICE_STOPPED, GetLastError());
        return;
    }

    lease_table_init();
    leases_reload();

    report_status(SERVICE_RUNNING, NO_ERROR);
    serverResult = pipe_server_loop(g_stopEvent);

    report_status(SERVICE_STOPPED, serverResult == 0 ? NO_ERROR : ERROR_SERVICE_SPECIFIC_ERROR);
    CloseHandle(g_stopEvent);
    g_stopEvent = NULL;
}

/* ------------------------------------------------------------------ */
/* wmain -- service dispatcher vs. foreground debug mode               */
/* ------------------------------------------------------------------ */

static void usage(void) {
    fwprintf(stderr,
        L"octopus-sandbox-gate-svc: usage:\n"
        L"  (no args)              run as the Windows service '%ls'\n"
        L"  --run-foreground       run the pipe server in the console (debug)\n",
        OCT_SERVICE_NAME);
}

/*
 * Entry point. With no arguments we hand control to the Service Control
 * Manager via StartServiceCtrlDispatcherW (the normal installed-service
 * path). --run-foreground runs the same accept loop directly for local
 * debugging / testability (it must still be elevated to perform WFP writes).
 *
 * Exit codes: 0 clean stop; 1 operational failure; 2 usage error.
 */
int wmain(int argc, wchar_t **argv) {
    if (argc >= 2 && wcscmp(argv[1], L"--run-foreground") == 0) {
        HANDLE stopEv;
        DWORD res;
        lease_table_init();
        leases_reload();
        stopEv = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (stopEv == NULL) {
            diag(L"CreateEventW(fg-stop)", GetLastError());
            return 1;
        }
        res = pipe_server_loop(stopEv);
        CloseHandle(stopEv);
        return (int)res;
    }

    if (argc >= 2) {
        usage();
        return 2;
    }

    /* Normal path: run as the Windows service. The dispatch table connects
     * the SCM to service_main. This call blocks until the service stops. */
    {
        SERVICE_TABLE_ENTRYW table[2];
        ZeroMemory(table, sizeof(table));
        table[0].lpServiceName = (LPWSTR)OCT_SERVICE_NAME;
        table[0].lpServiceProc = service_main;
        /* table[1] is the NULL terminator from ZeroMemory. */

        if (!StartServiceCtrlDispatcherW(table)) {
            DWORD err = GetLastError();
            /* ERROR_FAILED_SERVICE_CONTROLLER_CONNECT means we were launched
             * as a console app, not by the SCM. Point the operator at the
             * foreground mode instead of failing cryptically. */
            if (err == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
                fwprintf(stderr,
                    L"octopus-sandbox-gate-svc: not started by the Service Control "
                    L"Manager; use --run-foreground for console debugging\n");
                return 2;
            }
            diag(L"StartServiceCtrlDispatcherW", err);
            return 1;
        }
    }
    return 0;
}
