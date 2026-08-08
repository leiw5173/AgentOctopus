/*
 * helper.c -- trusted host helper subprocess for the AgentOctopus Windows
 * sandbox backend (Task 6). Part of the Windows Trusted Computing Base.
 *
 * Built by scripts/build-win-helper.mjs against the Windows SDK with MSVC:
 *   cl.exe /nologo /c /W4 /WX /O2 /std:c17 helper.c
 *   cl.exe /nologo helper.obj /link /OUT:octopus-sandbox-helper.exe
 *
 * This file is freestanding-ish Win32 C: it does not invoke a shell, does
 * not load any module at runtime (no LoadLibrary/GetProcAddress), and reads
 * configuration ONLY from argv. Every Win32 / HRESULT return is checked;
 * any failure is fatal (non-zero exit + single-line diagnostic on stderr).
 * There is no recovery path and no partial state left behind on the probe
 * path -- the throwaway AppContainer profile is deleted before exit.
 *
 * Invocation (argument array, never shell):
 *   octopus-sandbox-helper.exe sid <moniker>   -- print the loopback
 *                                                 capability SID string
 *                                                 (S-1-15-3-...) to stdout,
 *                                                 exit 0.
 *   octopus-sandbox-helper.exe probe           -- self-test: create+close a
 *                                                 Job Object, derive a
 *                                                 capability SID, create+
 *                                                 delete a throwaway LPAC
 *                                                 AppContainer profile.
 *                                                 Print "OK" to stdout and
 *                                                 exit 0 on success; any
 *                                                 failure -> stderr message
 *                                                 + non-zero exit.
 *
 * Exit codes:
 *   0  success
 *   1  operational failure (any Win32/HRESULT error on a subcommand)
 *   2  usage error (wrong argv; message on stderr)
 *
 * Import libraries: build-win-helper.mjs's linkExe() cannot pass import
 * libs on the cl command line (deferred constraint), so every non-default
 * lib is pulled in via #pragma comment(lib, ...) below. kernel32.lib is
 * implicit. We link:
 *   userenv.lib     -- CreateAppContainerProfile / DeleteAppContainerProfile
 *   advapi32.lib    -- ConvertSidToStringSidW / ConvertStringSidToSidW
 *   onecoreuap.lib  -- DeriveCapabilitySidsFromName (KernelBase.dll)
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

/* Request a Windows 8+ API surface so AppContainer / capability-SID
 * prototypes in <userenv.h> and <securitybaseapi.h> are visible. The
 * helper's minimum target is Windows 10; NTDDI_WIN10_* would also work but
 * WIN8 is the floor for every API we call here. */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602 /* _WIN32_WINNT_WIN8 */
#endif

#include <windows.h>
#include <sddl.h>      /* ConvertSidToStringSidW, ConvertStringSidToSidW */
#include <userenv.h>   /* CreateAppContainerProfile, DeleteAppContainerProfile */
#include <stdio.h>     /* fwprintf */
#include <stdlib.h>    /* wcstoul */
#include <wchar.h>     /* swprintf_s, _wcsnicmp, wcslen, wcscmp, memcpy (via string.h) */
#include <string.h>    /* memcpy, ZeroMemory macro lives in windows.h but memcpy is here */

#include "helper.h"

#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "onecoreuap.lib")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/* SECURITY_APP_PACKAGE_BASE_RID (2) and SECURITY_CAPABILITY_BASE_RID (3)
 * are defined in <winnt.h> on current SDKs; guard against older SDKs that
 * lack them. These values are ABI-stable and documented. */
#ifndef SECURITY_APP_PACKAGE_BASE_RID
#define SECURITY_APP_PACKAGE_BASE_RID 0x00000002L
#endif
#ifndef SECURITY_CAPABILITY_BASE_RID
#define SECURITY_CAPABILITY_BASE_RID  0x00000003L
#endif

/* LPAC process-creation constants (winbase.h on Win10+ SDKs; the
 * ALL_APPLICATION_PACKAGES policy attribute was introduced with LPAC in
 * Windows 10). The numeric values are ABI-stable; the fallbacks let the
 * file compile against an SDK that predates their public definition.
 *   ProcThreadAttributeAllApplicationPackagesPolicy == 15
 *   PROC_THREAD_ATTRIBUTE_INPUT                        == 0x00020000
 *   PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT  == 0x00000001
 * so the composed attribute value is 0x0002000f. */
#ifndef PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY
#define PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY 0x0002000f
#endif
#ifndef PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
#define PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT 0x00000001
#endif

/* Moniker length cap. CreateAppContainerProfile caps the app-container name
 * at 64 characters; we use the same cap for the sid subcommand so both paths
 * enforce one limit. */
#define OCT_MONIKER_MAX_CHARS 64

/* Fixed throwaway moniker for probe. Distinct from any real sandbox profile
 * name so a probe crash cannot collide with a live sandbox profile. The
 * random-looking suffix keeps parallel probes on the same machine from
 * racing on the same profile name. */
#define OCT_PROBE_MONIKER L"AgentOctopus.Sandbox.probe.t6"

/* Active-process cap for the Job (JOBOBJECT_BASIC_LIMIT_INFORMATION). The
 * sandboxed skill is a single Node process; cap the Job at 8 active
 * processes so a fork-bomb cannot spin up unbounded children before
 * KILL_ON_JOB_CLOSE / the memory limit bites. 8 is generous enough for
 * Node's own worker threads to not count (threads are not processes) while
 * still bounding any child_process the skill spawns. */
#define OCT_JOB_ACTIVE_PROCESS_LIMIT 8

/* Overlapped-read buffer size for the stdio relay pipes. 16 KiB is large
 * enough that a chatty child rarely forces a second read per drain, while
 * keeping the three RELAY_PIPE structs' combined stack footprint at ~48 KiB
 * in launch_sandboxed — comfortably inside the default 1 MiB thread stack
 * with the other locals. */
#define OCT_RELAY_BUF_BYTES (16u * 1024u)

/* ------------------------------------------------------------------ */
/* Diagnostics + fatal                                                 */
/* ------------------------------------------------------------------ */

/*
 * Report a single-line diagnostic on stderr. Wide-char format; the last
 * parameter is an HRESULT or Win32 error code rendered as 0x%08lx.
 * Returns the exit code the caller should propagate so call sites read
 *   return fail_hr(L"...", hr);
 */
static int fail_hr(PCWSTR context, HRESULT hr) {
    /* 0x%08lx: HRESULT is a LONG (32-bit) on every supported platform;
     * cast to unsigned long for a well-defined varargs type under /W4. */
    fwprintf(stderr, L"octopus-sandbox-helper: %ls failed (hr=0x%08lx)\n",
             context, (unsigned long)hr);
    return 1;
}

static int fail_win32(PCWSTR context, DWORD err) {
    fwprintf(stderr, L"octopus-sandbox-helper: %ls failed (err=%lu)\n",
             context, (unsigned long)err);
    return 1;
}

/* ------------------------------------------------------------------ */
/* derive_loopback_capability_sid                                      */
/* ------------------------------------------------------------------ */

/*
 * See helper.h for the contract. Implementation:
 *
 *   1. DeriveCapabilitySidsFromName(moniker, ...) yields the base
 *      capability SIDs for the moniker. We use CapabilitySids[0] (the
 *      first app-authority capability SID, S-1-15-3-...*) as the TEMPLATE
 *      only -- we do NOT return it directly, because the loopback
 *      capability must be derived from the PACKAGE SID per the design.
 *
 *   2. The package SID for the same moniker is obtained by
 *      CreateAppContainerProfile on a THROWAWAY profile named after the
 *      moniker, reading its SID, then deleting the profile. This is the
 *      only supported way to resolve a moniker to its package SID without
 *      duplicating the (undocumented) name->SID hash.
 *
 *      NOTE: this has a side effect -- a transient AppContainer profile is
 *      created and deleted for the moniker. That is acceptable for the sid
 *      subcommand's use case (the sandbox will create the real profile
 *      right after), but it means sid is NOT a pure read-only query.
 *
 *   3. Copy the package SID, rewrite SubAuthority[0] from
 *      SECURITY_APP_PACKAGE_BASE_RID (2) to SECURITY_CAPABILITY_BASE_RID
 *      (3), and ConvertSidToStringSidW the result.
 *
 * On any failure before step 3 completes, the throwaway profile is deleted
 * on a best-effort basis and an error HRESULT is returned with *outSid
 * left NULL.
 */
HRESULT derive_loopback_capability_sid(PCWSTR moniker, LPWSTR *outSid) {
    PSID *capGroupSids = NULL;
    DWORD capGroupSidCount = 0;
    PSID *capSids = NULL;
    DWORD capSidCount = 0;
    PSID packageSid = NULL;
    PSID loopbackSid = NULL;
    LPWSTR sidString = NULL;
    LPWSTR outCopy = NULL;
    HRESULT hr = S_OK;
    DWORD err = 0;
    DWORD sidLen = 0;
    DWORD i = 0;
    BOOLEAN profileCreated = FALSE;

    if (moniker == NULL || outSid == NULL || moniker[0] == L'\0') {
        return E_INVALIDARG;
    }
    if (wcslen(moniker) > OCT_MONIKER_MAX_CHARS) {
        return HRESULT_FROM_WIN32(ERROR_FILENAME_EXCED_RANGE);
    }
    *outSid = NULL;

    /* Step 1 -- base capability SIDs for the moniker. We only need this to
     * succeed as a sanity check that the moniker is well-formed for
     * capability derivation; the returned array itself is not the answer.
     * DeriveCapabilitySidsFromName returns BOOL, not HRESULT. */
    if (!DeriveCapabilitySidsFromName(moniker,
                                      &capGroupSids, &capGroupSidCount,
                                      &capSids,      &capSidCount)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* Step 2 -- resolve the package SID via a throwaway profile. */
    hr = CreateAppContainerProfile(moniker,
                                   /* pszDisplayName */ moniker,
                                   /* pszDescription */ L"AgentOctopus sandbox sid-resolution profile",
                                   /* pCapabilities   */ NULL,
                                   /* dwCapabilityCount */ 0,
                                   &packageSid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        /* Profile already exists (e.g. the sandbox created it earlier).
         * Derive its SID directly instead of failing. */
        hr = DeriveAppContainerSidFromAppContainerName(moniker, &packageSid);
        if (FAILED(hr)) {
            goto cleanup;
        }
        /* profileCreated stays FALSE -- we did not create it, so we must
         * NOT delete it on the way out. */
    } else if (FAILED(hr)) {
        goto cleanup;
    } else {
        profileCreated = TRUE;
    }

    /* Step 3 -- copy the package SID and rewrite SubAuthority[0] 2 -> 3. */
    sidLen = GetLengthSid(packageSid);
    if (sidLen == 0) {
        hr = E_UNEXPECTED;
        goto cleanup;
    }
    loopbackSid = (PSID)LocalAlloc(LMEM_FIXED, sidLen);
    if (loopbackSid == NULL) {
        hr = E_OUTOFMEMORY;
        goto cleanup;
    }
    if (!CopySid(sidLen, loopbackSid, packageSid)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* The package SID's identifier authority is SECURITY_APP_PACKAGE_AUTHORITY
     * (15) and its first sub-authority is SECURITY_APP_PACKAGE_BASE_RID (2).
     * Verify before rewriting so a malformed package SID cannot silently
     * produce a wrong "loopback" SID. */
    if (*GetSidSubAuthorityCount(loopbackSid) < 1) {
        hr = E_UNEXPECTED;
        goto cleanup;
    }
    if (*GetSidSubAuthority(loopbackSid, 0) != SECURITY_APP_PACKAGE_BASE_RID) {
        hr = E_UNEXPECTED;
        goto cleanup;
    }
    *GetSidSubAuthority(loopbackSid, 0) = SECURITY_CAPABILITY_BASE_RID;

    if (!ConvertSidToStringSidW(loopbackSid, &sidString)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* ConvertSidToStringSidW returns a LocalAlloc'd buffer; hand the caller
     * its OWN LocalAlloc copy so the contract ("caller frees with
     * LocalFree") does not depend on which allocator produced the string. */
    {
        SIZE_T bytes = (wcslen(sidString) + 1) * sizeof(WCHAR);
        outCopy = (LPWSTR)LocalAlloc(LMEM_FIXED, bytes);
        if (outCopy == NULL) {
            hr = E_OUTOFMEMORY;
            goto cleanup;
        }
        memcpy(outCopy, sidString, bytes);
    }

    *outSid = outCopy;
    outCopy = NULL; /* ownership transferred */
    hr = S_OK;

cleanup:
    /* Best-effort delete of the throwaway profile. A failure here does NOT
     * mask the original hr; the profile is per-user and harmless. */
    if (profileCreated) {
        (void)DeleteAppContainerProfile(moniker);
    }
    if (capGroupSids != NULL) {
        for (i = 0; i < capGroupSidCount; i++) {
            if (capGroupSids[i] != NULL) LocalFree(capGroupSids[i]);
        }
        LocalFree(capGroupSids);
    }
    if (capSids != NULL) {
        for (i = 0; i < capSidCount; i++) {
            if (capSids[i] != NULL) LocalFree(capSids[i]);
        }
        LocalFree(capSids);
    }
    if (packageSid != NULL) FreeSid(packageSid);
    if (loopbackSid != NULL) LocalFree(loopbackSid);
    if (sidString != NULL) LocalFree(sidString);
    if (outCopy != NULL) LocalFree(outCopy); /* only on failure path */
    return hr;
}

/* ------------------------------------------------------------------ */
/* Subcommand: sid <moniker>                                           */
/* ------------------------------------------------------------------ */

static int cmd_sid(PCWSTR moniker) {
    LPWSTR sid = NULL;
    HRESULT hr = derive_loopback_capability_sid(moniker, &sid);
    if (FAILED(hr)) {
        return fail_hr(L"derive_loopback_capability_sid", hr);
    }
    /* stdout gets the SID string followed by a single newline. Use fwprintf
     * on stdout (not _putws) so the line ends with "\n" (execFile captures
     * stdout verbatim; the test trims). */
    fwprintf(stdout, L"%ls\n", sid);
    LocalFree(sid);
    return 0;
}

/* ------------------------------------------------------------------ */
/* Subcommand: probe                                                   */
/* ------------------------------------------------------------------ */

static int cmd_probe(void) {
    HANDLE job = NULL;
    LPWSTR sid = NULL;
    PSID profileSid = NULL;
    HRESULT hr;
    DWORD err;

    /* 1. Job Object create + close. */
    job = CreateJobObjectW(NULL /* lpJobAttributes */, NULL /* lpName */);
    if (job == NULL) {
        err = GetLastError();
        return fail_win32(L"CreateJobObjectW", err);
    }
    if (!CloseHandle(job)) {
        err = GetLastError();
        return fail_win32(L"CloseHandle(JobObject)", err);
    }
    job = NULL;

    /* 2. Derive a capability SID for the throwaway probe moniker. This
     *    exercises DeriveCapabilitySidsFromName end-to-end on this host. */
    hr = derive_loopback_capability_sid(OCT_PROBE_MONIKER, &sid);
    if (FAILED(hr)) {
        return fail_hr(L"probe derive_loopback_capability_sid", hr);
    }
    LocalFree(sid);
    sid = NULL;

    /* 3. Create + delete a throwaway LPAC AppContainer profile. The
     *    capability SID derivation in step 2 already created+deleted a
     *    profile for OCT_PROBE_MONIKER, but probe must independently prove
     *    the create/delete pair works against a profile it owns. */
    hr = CreateAppContainerProfile(OCT_PROBE_MONIKER,
                                   OCT_PROBE_MONIKER,
                                   L"AgentOctopus sandbox helper probe profile",
                                   NULL, 0,
                                   &profileSid);
    if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        return fail_hr(L"probe CreateAppContainerProfile", hr);
    }
    if (profileSid != NULL) {
        FreeSid(profileSid);
        profileSid = NULL;
    }
    hr = DeleteAppContainerProfile(OCT_PROBE_MONIKER);
    if (FAILED(hr)) {
        return fail_hr(L"probe DeleteAppContainerProfile", hr);
    }

    /* Success -- the single "OK" line the test looks for. */
    fwprintf(stdout, L"OK\n");
    return 0;
}

/* ------------------------------------------------------------------ */
/* launch_sandboxed                                                    */
/* ------------------------------------------------------------------ */

/*
 * build_command_line -- concatenate nodePath + argv into a single
 * CreateProcessW command line.
 *
 * CreateProcessW's lpCommandLine is parsed by the child with
 * CommandLineToArgvW rules: an argument containing whitespace or a quote
 * must be wrapped in double quotes, embedded quotes escaped as \", and a
 * trailing backslash before a closing quote escaped as \\. Node's own
 * argv does not normally need this (it is "node.exe -e <code>" with the
 * code quoted), but the -- <argv...> tail is arbitrary skill input, so
 * every argument is quoted defensively.
 *
 * Returns a LocalAlloc'd, NUL-terminated command line on success; caller
 * frees with LocalFree. NULL on allocation failure.
 */
static LPWSTR build_command_line(PCWSTR nodePath, PCWSTR *argv) {
    /* Worst-case length: every char of every arg could need a backslash
     * escape, plus two quotes and a space per arg, plus the NUL. Compute
     * the exact length first, then build. */
    SIZE_T len = 0;
    SIZE_T i;
    LPWSTR out = NULL;
    LPWSTR w;

    /* nodePath (always quoted). */
    len += wcslen(nodePath) * 2 + 2 + 1;

    if (argv != NULL) {
        for (i = 0; argv[i] != NULL; i++) {
            len += wcslen(argv[i]) * 2 + 2 + 1;
        }
    }
    len += 1; /* NUL */

    out = (LPWSTR)LocalAlloc(LMEM_FIXED, len * sizeof(WCHAR));
    if (out == NULL) return NULL;
    w = out;

    /* Append one quoted argument. */
    #define APPEND_QUOTED(s)                                          \
        do {                                                          \
            PCWSTR _r = (s);                                          \
            *w++ = L'"';                                              \
            while (*_r != L'\0') {                                    \
                if (*_r == L'"') {                                    \
                    *w++ = L'\\';                                     \
                    *w++ = L'"';                                      \
                } else if (*_r == L'\\') {                            \
                    /* Copy the backslash run; if the next char is    \
                     * the closing quote we must double the run. */   \
                    PCWSTR _bs = _r;                                  \
                    while (*_bs == L'\\') _bs++;                      \
                    if (*_bs == L'\0') {                              \
                        /* Trailing backslashes before the closing    \
                         * quote: double them. */                     \
                        while (_r < _bs) { *w++ = L'\\'; *w++ = L'\\'; _r++; } \
                    } else {                                          \
                        while (_r < _bs) { *w++ = L'\\'; _r++; }      \
                    }                                                 \
                } else {                                              \
                    *w++ = *_r++;                                     \
                }                                                     \
            }                                                         \
            *w++ = L'"';                                              \
        } while (0)

    APPEND_QUOTED(nodePath);
    if (argv != NULL) {
        for (i = 0; argv[i] != NULL; i++) {
            *w++ = L' ';
            APPEND_QUOTED(argv[i]);
        }
    }
    #undef APPEND_QUOTED

    *w = L'\0';
    return out;
}

/*
 * build_child_environment -- build the sorted Unicode env block for the
 * child.
 *
 * CREATE_UNICODE_ENVIRONMENT requires a double-NUL-terminated block of
 * "NAME=VALUE\0NAME=VALUE\0\0" entries sorted case-insensitively by name.
 * We build exactly the variables the design mandates (§4d) on top of a
 * MINIMAL base set, rather than inheriting the helper's own environment —
 * the helper's env may carry host secrets and must not leak into the
 * sandboxed child.
 *
 * The base set is the smallest set Node needs to boot predictably:
 *   SystemRoot, SystemDrive, ComSpec, PATH, TEMP, TMP, PATHEXT, OS,
 *   PROCESSOR_ARCHITECTURE, NUMBER_OF_PROCESSORS, USERNAME, USERPROFILE,
 *   APPDATA, LOCALAPPDATA, HOMEDRIVE, HOMEPATH, COMPUTERNAME
 *
 * Returns a LocalAlloc'd block on success; *outBytes receives its size in
 * bytes. Caller frees with LocalFree. NULL on failure.
 */
static LPWSTR build_child_environment(const SANDBOX_LAUNCH_ARGS *args,
                                      DWORD *outBytes) {
    /* Fixed base var names we copy from our own environment. */
    static const PCWSTR baseNames[] = {
        L"SystemRoot", L"SystemDrive", L"ComSpec", L"PATH", L"TEMP", L"TMP",
        L"PATHEXT", L"OS", L"PROCESSOR_ARCHITECTURE", L"NUMBER_OF_PROCESSORS",
        L"USERNAME", L"USERPROFILE", L"APPDATA", L"LOCALAPPDATA",
        L"HOMEDRIVE", L"HOMEPATH", L"COMPUTERNAME",
    };
    enum { BASE_COUNT = sizeof(baseNames) / sizeof(baseNames[0]) };

    /* We inject 5 sandbox vars: NODE_OPTIONS, HTTP_PROXY, HTTPS_PROXY,
     * NO_PROXY, NODE_EXTRA_CA_CERTS. */
    enum { INJECT_COUNT = 5 };

    /* Worst case we have BASE_COUNT + INJECT_COUNT entries. */
    enum { MAX_ENTRIES = BASE_COUNT + INJECT_COUNT };

    LPWSTR entries[MAX_ENTRIES];
    SIZE_T entryLens[MAX_ENTRIES];
    int entryCount = 0;
    SIZE_T totalChars = 1; /* final extra NUL */
    LPWSTR block = NULL;
    LPWSTR w;
    int i, j;

    /* Scratch buffers for the injected values (NODE_OPTIONS and the CA
     * path are built from args). Sized generously. */
    WCHAR nodeOptions[MAX_PATH + 64];
    WCHAR caVar[MAX_PATH + 64];

    ZeroMemory(entries, sizeof(entries));
    ZeroMemory(entryLens, sizeof(entryLens));

    /* ---- injected sandbox vars ------------------------------------ */

    /* NODE_OPTIONS=--require <bootstrapPath> */
    if (swprintf_s(nodeOptions, ARRAYSIZE(nodeOptions),
                   L"--require %s", args->bootstrapPath) < 0) {
        return NULL;
    }
    /* NODE_EXTRA_CA_CERTS=<caPath> */
    if (swprintf_s(caVar, ARRAYSIZE(caVar),
                   L"%s", args->caPath) < 0) {
        return NULL;
    }

    /* Each injected entry is "NAME=VALUE". Build them into LocalAlloc'd
     * buffers so they can be sorted and freed uniformly. */
    {
        PCWSTR injectNames[INJECT_COUNT] = {
            L"NODE_OPTIONS", L"HTTP_PROXY", L"HTTPS_PROXY",
            L"NO_PROXY", L"NODE_EXTRA_CA_CERTS",
        };
        PCWSTR injectVals[INJECT_COUNT] = {
            nodeOptions, args->proxyHostPort, args->proxyHostPort,
            L"", caVar,
        };
        for (i = 0; i < INJECT_COUNT; i++) {
            SIZE_T need = wcslen(injectNames[i]) + 1 + wcslen(injectVals[i]) + 1;
            entries[entryCount] = (LPWSTR)LocalAlloc(LMEM_FIXED, need * sizeof(WCHAR));
            if (entries[entryCount] == NULL) goto fail;
            if (swprintf_s(entries[entryCount], need,
                           L"%s=%s", injectNames[i], injectVals[i]) < 0) {
                goto fail;
            }
            entryCount++;
        }
    }

    /* ---- base vars copied from our own env ------------------------- */
    for (i = 0; i < BASE_COUNT; i++) {
        /* GetEnvironmentVariableW with a NULL buffer returns the required
         * size in chars (including NUL). 0 means the var is unset on the
         * helper — skip it (not an error; e.g. HOMEDRIVE may be absent in
         * some service contexts). */
        DWORD need = GetEnvironmentVariableW(baseNames[i], NULL, 0);
        if (need == 0) continue;
        {
            LPWSTR val = (LPWSTR)LocalAlloc(LMEM_FIXED, (SIZE_T)need * sizeof(WCHAR));
            SIZE_T nameLen = wcslen(baseNames[i]);
            LPWSTR entry;
            SIZE_T entryNeed;
            if (val == NULL) goto fail;
            if (GetEnvironmentVariableW(baseNames[i], val, need) == 0) {
                LocalFree(val);
                continue; /* raced out from under us — skip */
            }
            /* Build "NAME=VALUE". */
            entryNeed = nameLen + 1 + (SIZE_T)need; /* need already incl NUL; -1+1 cancels */
            entry = (LPWSTR)LocalAlloc(LMEM_FIXED, entryNeed * sizeof(WCHAR));
            if (entry == NULL) { LocalFree(val); goto fail; }
            if (swprintf_s(entry, entryNeed, L"%s=%s", baseNames[i], val) < 0) {
                LocalFree(val);
                LocalFree(entry);
                goto fail;
            }
            LocalFree(val);
            entries[entryCount] = entry;
            entryCount++;
        }
    }

    /* ---- sort case-insensitively by name (insertion sort; N is tiny) -- */
    for (i = 1; i < entryCount; i++) {
        LPWSTR key = entries[i];
        SIZE_T keyLen = 0;
        /* name length = chars up to the first '=' */
        while (key[keyLen] != L'=' && key[keyLen] != L'\0') keyLen++;
        j = i - 1;
        while (j >= 0) {
            LPWSTR cur = entries[j];
            SIZE_T curLen = 0;
            while (cur[curLen] != L'=' && cur[curLen] != L'\0') curLen++;
            /* Compare names case-insensitively. CompareStringOrdinal is
             * overkill; _wcsnicmp on the shorter name-length then a length
             * tiebreak is sufficient and locale-independent. */
            {
                SIZE_T minLen = (keyLen < curLen) ? keyLen : curLen;
                int cmp = _wcsnicmp(key, cur, minLen);
                if (cmp == 0) {
                    if (keyLen < curLen) cmp = -1;
                    else if (keyLen > curLen) cmp = 1;
                }
                if (cmp < 0) {
                    entries[j + 1] = entries[j];
                    j--;
                } else {
                    break;
                }
            }
        }
        entries[j + 1] = key;
    }

    /* ---- concatenate into the block -------------------------------- */
    for (i = 0; i < entryCount; i++) {
        entryLens[i] = wcslen(entries[i]) + 1; /* +1 for the entry NUL */
        totalChars += entryLens[i];
    }
    block = (LPWSTR)LocalAlloc(LMEM_FIXED, totalChars * sizeof(WCHAR));
    if (block == NULL) goto fail;
    w = block;
    for (i = 0; i < entryCount; i++) {
        memcpy(w, entries[i], entryLens[i] * sizeof(WCHAR));
        w += entryLens[i];
    }
    *w = L'\0'; /* the second NUL that terminates the block */

    *outBytes = (DWORD)(totalChars * sizeof(WCHAR));

    for (i = 0; i < entryCount; i++) LocalFree(entries[i]);
    return block;

fail:
    for (i = 0; i < entryCount; i++) {
        if (entries[i] != NULL) LocalFree(entries[i]);
    }
    return NULL;
}

/*
 * Relay-pipe state for one direction of stdio. Used by the overlapped
 * reader so stdout and stderr stream concurrently without a deadlock.
 */
typedef struct RELAY_PIPE {
    HANDLE childEnd;   /* pipe end the CHILD holds (inheritable) */
    HANDLE parentEnd;  /* pipe end the PARENT holds (overlapped) */
    HANDLE readEvent;  /* manual-reset event for overlapped ReadFile */
    OVERLAPPED ov;     /* overlapped state for parentEnd reads */
    BYTE buf[OCT_RELAY_BUF_BYTES];
    DWORD bufLen;      /* bytes valid in buf after a completed read */
    BOOL eof;          /* child closed its end / pipe broken */
    BOOL pending;      /* an overlapped ReadFile is in flight */
} RELAY_PIPE;

/*
 * relay_init -- create one pipe pair for stdio relay.
 *
 * The parent end must support overlapped reads so stdout and stderr can be
 * drained concurrently without one starving the other. CreatePipe() cannot
 * produce an overlapped handle (anonymous pipes are always synchronous on
 * the read side), so the parent end is a NAMED pipe created with
 * FILE_FLAG_OVERLAPPED. The child end is a CreateFileW client handle on the
 * same pipe name, made inheritable so CreateProcessW can hand it to the
 * child as a std handle.
 *
 * The pipe name is unique per (helper PID, serial) so concurrent helpers on
 * the same machine never collide, and the pipe is created with a NULL DACL
 * + bInheritHandle=FALSE SECURITY_ATTRIBUTES so it is not accessible outside
 * this process's session.
 *
 * kind: 0 = parent reads (child stdout/stderr), 1 = parent writes (child
 * stdin). For kind 0 the child end is the pipe client in GENERIC_WRITE
 * mode; for kind 1 the child end is the client in GENERIC_READ mode.
 *
 * On any failure, every partially-created handle is closed and a failure
 * HRESULT is returned — no half-built pipe is left behind.
 */
static HRESULT relay_init(RELAY_PIPE *p, int kind) {
    SECURITY_ATTRIBUTES sa;
    WCHAR pipeName[128];
    static volatile LONG pipeSerial = 0;
    LONG serial;
    HRESULT hr = S_OK;
    DWORD err;
    DWORD serverAccess;
    DWORD clientAccess;

    ZeroMemory(p, sizeof(*p));

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = FALSE;

    serial = InterlockedIncrement(&pipeSerial);
    if (swprintf_s(pipeName, ARRAYSIZE(pipeName),
                   L"\\\\.\\pipe\\octopus-helper-%lu-%lu",
                   (unsigned long)GetCurrentProcessId(),
                   (unsigned long)serial) < 0) {
        return E_UNEXPECTED;
    }

    /* Parent end: named-pipe server, overlapped on the read side. For
     * kind 0 the parent reads (PIPE_ACCESS_INBOUND); for kind 1 the parent
     * writes (PIPE_ACCESS_OUTBOUND). FILE_FLAG_OVERLAPPED is set on both so
     * the handle is born overlapped-capable; only the kind-0 read path
     * actually uses overlapped I/O. */
    serverAccess = (kind == 0) ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND;
    p->parentEnd = CreateNamedPipeW(pipeName,
        serverAccess | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1,                       /* nMaxInstances — one child per pipe */
        OCT_RELAY_BUF_BYTES,     /* nOutBufferSize */
        OCT_RELAY_BUF_BYTES,     /* nInBufferSize */
        0,                       /* nDefaultTimeOut */
        &sa);
    if (p->parentEnd == INVALID_HANDLE_VALUE) {
        err = GetLastError();
        p->parentEnd = NULL;
        hr = HRESULT_FROM_WIN32(err);
        goto fail;
    }

    /* Child end: a CreateFileW client on the pipe name, inheritable. */
    clientAccess = (kind == 0) ? GENERIC_WRITE : GENERIC_READ;
    {
        SECURITY_ATTRIBUTES childSa;
        childSa.nLength = sizeof(childSa);
        childSa.lpSecurityDescriptor = NULL;
        childSa.bInheritHandle = TRUE; /* this handle IS inherited by the child */

        p->childEnd = CreateFileW(pipeName, clientAccess, 0, &childSa,
                                  OPEN_EXISTING, 0, NULL);
        if (p->childEnd == INVALID_HANDLE_VALUE) {
            err = GetLastError();
            p->childEnd = NULL;
            hr = HRESULT_FROM_WIN32(err);
            goto fail;
        }
    }

    /* Event for overlapped reads on the parent end. */
    p->readEvent = CreateEventW(NULL, TRUE /* manual-reset */, FALSE, NULL);
    if (p->readEvent == NULL) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto fail;
    }
    ZeroMemory(&p->ov, sizeof(p->ov));
    p->ov.hEvent = p->readEvent;
    p->eof = FALSE;
    p->pending = FALSE;
    p->bufLen = 0;
    return S_OK;

fail:
    if (p->childEnd != NULL) { CloseHandle(p->childEnd); p->childEnd = NULL; }
    if (p->parentEnd != NULL) { CloseHandle(p->parentEnd); p->parentEnd = NULL; }
    return hr;
}

fail:
    if (p->childEnd != NULL) CloseHandle(p->childEnd);
    if (p->parentEnd != NULL) CloseHandle(p->parentEnd);
    p->childEnd = NULL;
    p->parentEnd = NULL;
    return hr;
}

static void relay_close(RELAY_PIPE *p) {
    if (p->childEnd != NULL) { CloseHandle(p->childEnd); p->childEnd = NULL; }
    if (p->parentEnd != NULL) { CloseHandle(p->parentEnd); p->parentEnd = NULL; }
    if (p->readEvent != NULL) { CloseHandle(p->readEvent); p->readEvent = NULL; }
}

/*
 * relay_start_read -- kick off (or re-arm) an overlapped read on a relay
 * pipe. Sets p->pending when a read is in flight; on immediate completion
 * moves the bytes into p->buf/p->bufLen and clears pending. On EOF/broken
 * pipe sets p->eof.
 */
static HRESULT relay_start_read(RELAY_PIPE *p) {
    DWORD got = 0;
    DWORD err;

    if (p->eof) return S_OK;

    ResetEvent(p->readEvent);
    if (ReadFile(p->parentEnd, p->buf, OCT_RELAY_BUF_BYTES, &got, &p->ov)) {
        /* Completed synchronously. */
        p->bufLen = got;
        p->pending = FALSE;
        if (got == 0) p->eof = TRUE;
        return S_OK;
    }
    err = GetLastError();
    if (err == ERROR_IO_PENDING) {
        p->pending = TRUE;
        return S_OK;
    }
    if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
        err == ERROR_NO_DATA) {
        p->eof = TRUE;
        p->pending = FALSE;
        return S_OK;
    }
    return HRESULT_FROM_WIN32(err);
}

/*
 * relay_flush_ready -- if a relay pipe has completed bytes, write them to
 * our own fd 1 (stdout) or fd 2 (stderr) as appropriate, then re-arm the
 * read. outFd is 1 for the child's stdout relay, 2 for stderr.
 */
static HRESULT relay_flush_ready(RELAY_PIPE *p, int outFd) {
    HRESULT hr;
    DWORD got = 0;

    if (p->eof && !p->pending && p->bufLen == 0) return S_OK;

    if (p->pending) {
        if (!GetOverlappedResult(p->parentEnd, &p->ov, &got, FALSE)) {
            DWORD err = GetLastError();
            if (err == ERROR_IO_INCOMPLETE) return S_OK; /* not ready yet */
            if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
                err == ERROR_NO_DATA) {
                p->eof = TRUE;
                p->pending = FALSE;
                return S_OK;
            }
            return HRESULT_FROM_WIN32(err);
        }
        p->pending = FALSE;
        p->bufLen = got;
        if (got == 0) {
            p->eof = TRUE;
            return S_OK;
        }
    }

    if (p->bufLen > 0) {
        HANDLE out = GetStdHandle(outFd == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
        DWORD written = 0;
        if (out != NULL && out != INVALID_HANDLE_VALUE) {
            if (!WriteFile(out, p->buf, p->bufLen, &written, NULL)) {
                /* Our own stdout/stderr is broken; not fatal to the child —
                 * drop the bytes and keep draining so the child never blocks
                 * on a full pipe. */
            }
        }
        p->bufLen = 0;
    }

    hr = relay_start_read(p);
    return hr;
}

/*
 * launch_sandboxed -- see helper.h for the contract.
 *
 * The race-free invariant: the child is created suspended, assigned to the
 * Job BEFORE ResumeThread, and the LPAC attribute list is attached at
 * process-creation time via STARTUPINFOEXW (UpdateProcThreadAttribute on a
 * live process is not possible — the SECURITY_CAPABILITIES attribute must
 * be present in the attribute list passed to CreateProcessW). Therefore
 * the actual code order is:
 *
 *   A. Build the LPAC attribute list + SECURITY_CAPABILITIES (needs the
 *      package SID + loopback capability SID first).
 *   B. CreateProcessW(..., CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
 *      EXTENDED_STARTUPINFO_PRESENT, ...) — child frozen at the entry
 *      point, before ANY user code runs.
 *   C. CreateJobObjectW (non-inheritable SA, named) + SetInformationJobObject
 *      (extended limit: JOB_MEMORY | KILL_ON_JOB_CLOSE; basic limit:
 *      ACTIVE_PROCESS).
 *   D. AssignProcessToJobObject(job, child) — while still suspended.
 *   E. Only on full success of A–D: ResumeThread(childThread). Any failure
 *      in A–D jumps to a cleanup label that TerminateProcess()es the
 *      suspended child, closes its handles, frees every SID / attr list /
 *      env block / command line, and returns a failure HRESULT. The child
 *      never runs a single instruction outside the Job.
 */
HRESULT launch_sandboxed(const SANDBOX_LAUNCH_ARGS *args, DWORD *outExitCode) {
    /* ---- security state (allocated, freed on every path) ---- */
    PSID packageSid = NULL;             /* from CreateAppContainerProfile */
    PSID *capGroupSids = NULL;          /* DeriveCapabilitySidsFromName */
    DWORD capGroupSidCount = 0;
    PSID *capSids = NULL;
    DWORD capSidCount = 0;
    PSID loopbackCapSid = NULL;         /* binary form of the loopback SID */
    LPWSTR loopbackCapSidStr = NULL;    /* string form from Task 6 derive */
    SID_AND_ATTRIBUTES *secCapSids = NULL; /* array for SECURITY_CAPABILITIES */
    DWORD secCapSidCount = 0;
    SECURITY_CAPABILITIES secCaps;
    DWORD appPackagesPolicy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    LPPROC_THREAD_ATTRIBUTE_LIST attrList = NULL;
    SIZE_T attrListSize = 0;

    /* ---- process / job state ---- */
    STARTUPINFOEXW si;
    PROCESS_INFORMATION pi;
    HANDLE job = NULL;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    JOBOBJECT_BASIC_LIMIT_INFORMATION jbli;
    BOOL processCreated = FALSE;
    BOOL threadResumed = FALSE;

    /* ---- stdio relay ---- */
    RELAY_PIPE inPipe;   /* parent writes -> child stdin */
    RELAY_PIPE outPipe;  /* child stdout -> parent reads */
    RELAY_PIPE errPipe;  /* child stderr -> parent reads */
    BOOL inInit = FALSE, outInit = FALSE, errInit = FALSE;

    /* ---- misc allocated ---- */
    LPWSTR cmdLine = NULL;
    LPWSTR envBlock = NULL;
    DWORD envBlockBytes = 0;
    SECURITY_ATTRIBUTES jobSa;

    HRESULT hr = S_OK;
    DWORD err = 0;
    DWORD i;

    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    ZeroMemory(&secCaps, sizeof(secCaps));
    ZeroMemory(&inPipe, sizeof(inPipe));
    ZeroMemory(&outPipe, sizeof(outPipe));
    ZeroMemory(&errPipe, sizeof(errPipe));

    if (args == NULL || outExitCode == NULL ||
        args->jobName == NULL || args->pkgMoniker == NULL ||
        args->proxyHostPort == NULL || args->caPath == NULL ||
        args->bootstrapPath == NULL || args->nodePath == NULL) {
        return E_INVALIDARG;
    }
    *outExitCode = 0;

    /* ==============================================================
     * Step A -- build the LPAC attribute list.
     * ============================================================== */

    /* A1. Resolve the package SID for the moniker. Create the profile if it
     * does not exist yet (the real sandbox profile — the TS side may or may
     * not have created it already; CreateAppContainerProfile is idempotent
     * via ERROR_ALREADY_EXISTS). We do NOT delete it here — the profile
     * belongs to the sandbox session, not to this launch. */
    hr = CreateAppContainerProfile(args->pkgMoniker,
                                   args->pkgMoniker,
                                   L"AgentOctopus sandbox profile",
                                   NULL, 0,
                                   &packageSid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(args->pkgMoniker,
                                                       &packageSid);
    }
    if (FAILED(hr)) goto cleanup;

    /* A2. Derive the base capability SIDs for the moniker (group + normal).
     * These give the token the moniker's declared capabilities. */
    if (!DeriveCapabilitySidsFromName(args->pkgMoniker,
                                      &capGroupSids, &capGroupSidCount,
                                      &capSids, &capSidCount)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* A3. Derive the LOOPBACK capability SID via the Task 6 helper, then
     * convert the string back to a binary SID for the SECURITY_CAPABILITIES
     * array. (We go string->binary because derive_loopback_capability_sid
     * is the single source of truth for the 2->3 RID rewrite.) */
    hr = derive_loopback_capability_sid(args->pkgMoniker, &loopbackCapSidStr);
    if (FAILED(hr)) goto cleanup;
    if (!ConvertStringSidToSidW(loopbackCapSidStr, &loopbackCapSid)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* A4. Build the SID_AND_ATTRIBUTES array: all derived capability SIDs
     * (group + normal) PLUS the loopback capability, each with
     * SE_GROUP_ENABLED. */
    secCapSidCount = capGroupSidCount + capSidCount + 1;
    secCapSids = (SID_AND_ATTRIBUTES *)LocalAlloc(LMEM_FIXED | LMEM_ZEROINIT,
        secCapSidCount * sizeof(SID_AND_ATTRIBUTES));
    if (secCapSids == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }
    {
        DWORD idx = 0;
        for (i = 0; i < capGroupSidCount; i++) {
            secCapSids[idx].Sid = capGroupSids[i];
            secCapSids[idx].Attributes = SE_GROUP_ENABLED;
            idx++;
        }
        for (i = 0; i < capSidCount; i++) {
            secCapSids[idx].Sid = capSids[i];
            secCapSids[idx].Attributes = SE_GROUP_ENABLED;
            idx++;
        }
        secCapSids[idx].Sid = loopbackCapSid;
        secCapSids[idx].Attributes = SE_GROUP_ENABLED;
    }
    secCaps.AppContainerSid = packageSid;
    secCaps.Capabilities = secCapSids;
    secCaps.CapabilityCount = secCapSidCount;
    secCaps.Reserved = 0;

    /* A5. Attribute list: size round-trip, allocate, initialize, then set
     * both LPAC attributes. */
    if (!InitializeProcThreadAttributeList(NULL, 2, 0, &attrListSize) &&
        GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    attrList = (LPPROC_THREAD_ATTRIBUTE_LIST)LocalAlloc(LMEM_FIXED, attrListSize);
    if (attrList == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }
    if (!InitializeProcThreadAttributeList(attrList, 2, 0, &attrListSize)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    if (!UpdateProcThreadAttribute(attrList, 0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &secCaps, sizeof(secCaps), NULL, NULL)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    if (!UpdateProcThreadAttribute(attrList, 0,
            PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
            &appPackagesPolicy, sizeof(appPackagesPolicy), NULL, NULL)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* ==============================================================
     * Step B -- stdio pipes + env block + command line, then the
     * suspended CreateProcessW.
     * ============================================================== */

    if (FAILED(hr = relay_init(&inPipe, 1)))  goto cleanup;
    inInit = TRUE;
    if (FAILED(hr = relay_init(&outPipe, 0))) goto cleanup;
    outInit = TRUE;
    if (FAILED(hr = relay_init(&errPipe, 0))) goto cleanup;
    errInit = TRUE;

    /* The child ends are CreateFileW clients that connected during
     * relay_init. The parent (server) ends are still in the listening state;
     * each must complete a ConnectNamedPipe before reads/writes succeed.
     * With FILE_FLAG_OVERLAPPED on the server, ConnectNamedPipe returns
     * FALSE with ERROR_PIPE_CONNECTED when the client is already connected
     * (the normal case here) or ERROR_IO_PENDING — both are success; only
     * other errors are fatal. */
    {
        RELAY_PIPE *pipes[3] = { &inPipe, &outPipe, &errPipe };
        int k;
        for (k = 0; k < 3; k++) {
            if (!ConnectNamedPipe(pipes[k]->parentEnd, NULL)) {
                DWORD cerr = GetLastError();
                if (cerr != ERROR_PIPE_CONNECTED && cerr != ERROR_IO_PENDING) {
                    hr = HRESULT_FROM_WIN32(cerr);
                    goto cleanup;
                }
            }
        }
    }

    envBlock = build_child_environment(args, &envBlockBytes);
    if (envBlock == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }

    cmdLine = build_command_line(args->nodePath, args->argv);
    if (cmdLine == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }

    si.cb = sizeof(si);
    si.StartupInfo.cb = sizeof(si.StartupInfo);
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = inPipe.childEnd;
    si.StartupInfo.hStdOutput = outPipe.childEnd;
    si.StartupInfo.hStdError = errPipe.childEnd;
    si.lpAttributeList = attrList;

    if (!CreateProcessW(NULL,           /* lpApplicationName — use cmdLine */
                        cmdLine,        /* lpCommandLine */
                        NULL,           /* lpProcessAttributes */
                        NULL,           /* lpThreadAttributes */
                        TRUE,           /* bInheritHandles — inherit the 3 pipe ends */
                        CREATE_SUSPENDED |
                        CREATE_UNICODE_ENVIRONMENT |
                        EXTENDED_STARTUPINFO_PRESENT,
                        envBlock,
                        NULL,           /* lpCurrentDirectory — inherit */
                        &si.StartupInfo,
                        &pi)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    processCreated = TRUE;

    /* The child now holds its own copies of the inheritable pipe ends; the
     * parent closes its copies of the CHILD ends so EOF propagates when the
     * child exits. The parent ends stay open for the relay. */
    CloseHandle(inPipe.childEnd);  inPipe.childEnd = NULL;
    CloseHandle(outPipe.childEnd); outPipe.childEnd = NULL;
    CloseHandle(errPipe.childEnd); errPipe.childEnd = NULL;

    /* ==============================================================
     * Step C -- Job Object create + configure.
     * ============================================================== */

    jobSa.nLength = sizeof(jobSa);
    jobSa.lpSecurityDescriptor = NULL;
    jobSa.bInheritHandle = FALSE; /* the untrusted child must NOT inherit the Job handle */

    job = CreateJobObjectW(&jobSa, args->jobName);
    if (job == NULL) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    jeli.JobMemoryLimit = (SIZE_T)args->memMb * 1024u * 1024u;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &jeli, sizeof(jeli))) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    ZeroMemory(&jbli, sizeof(jbli));
    jbli.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    jbli.ActiveProcessLimit = OCT_JOB_ACTIVE_PROCESS_LIMIT;
    if (!SetInformationJobObject(job, JobObjectBasicLimitInformation,
                                 &jbli, sizeof(jbli))) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* ==============================================================
     * Step D -- assign the still-suspended child to the Job.
     * ============================================================== */

    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* ==============================================================
     * Step E -- everything succeeded. Resume the child: it now runs
     * for the first time, fully inside the Job under LPAC.
     * ============================================================== */

    if (ResumeThread(pi.hThread) == (DWORD)-1) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    threadResumed = TRUE;

    /* ---- stdin payload: this launch contract has no stdin payload from
     * the TS side (the skill's stdin is the relay itself), so we close the
     * parent's stdin write end immediately. A future run-mode that carries
     * a payload writes it here BEFORE closing. Closing signals EOF to the
     * child's stdin. */
    CloseHandle(inPipe.parentEnd);
    inPipe.parentEnd = NULL;

    /* ---- relay loop: drain stdout + stderr concurrently, wait for exit -- */

    (void)relay_start_read(&outPipe);
    (void)relay_start_read(&errPipe);

    for (;;) {
        HANDLE waitSet[3];
        DWORD nWait = 0;
        DWORD waitRes;

        /* Wait on: child process handle + whichever pipe-read events are
         * still armed. We rebuild the array each iteration because pipes
         * reach EOF at different times. */
        waitSet[nWait++] = pi.hProcess;
        if (!outPipe.eof) waitSet[nWait++] = outPipe.readEvent;
        if (!errPipe.eof) waitSet[nWait++] = errPipe.readEvent;

        /* If every pipe is at EOF and the child has exited, we are done. */
        if (nWait == 1 &&
            WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0) {
            break;
        }

        waitRes = WaitForMultipleObjects(nWait, waitSet, FALSE, 100 /* ms */);
        if (waitRes == WAIT_FAILED) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }
        /* Regardless of which handle fired (or the 100 ms tick), flush both
         * relays. relay_flush_ready is a no-op on a pipe with no completed
         * bytes, so calling it unconditionally is correct and avoids the
         * stdout/stderr starvation deadlock: neither pipe is ever left
         * undrained while we block on the other. */
        if (FAILED(hr = relay_flush_ready(&outPipe, 1))) goto cleanup;
        if (FAILED(hr = relay_flush_ready(&errPipe, 2))) goto cleanup;

        /* Exit the loop once the child is gone AND both pipes are drained. */
        if (WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0 &&
            outPipe.eof && errPipe.eof &&
            !outPipe.pending && !errPipe.pending) {
            break;
        }
    }

    /* Final flush — anything still buffered after EOF. */
    (void)relay_flush_ready(&outPipe, 1);
    (void)relay_flush_ready(&errPipe, 2);

    if (!GetExitCodeProcess(pi.hProcess, outExitCode)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    hr = S_OK;

cleanup:
    /* If we created the process but never resumed it (any failure in B–D),
     * the child is still suspended at its entry point. Kill it before it
     * can ever run, then let the Job handle close (KILL_ON_JOB_CLOSE is a
     * backstop; TerminateProcess is deterministic). If we DID resume, the
     * child ran to completion inside the Job on the success path; on a
     * relay-loop failure after resume we still terminate to avoid a leaked
     * running child. */
    if (processCreated) {
        if (!threadResumed || FAILED(hr)) {
            (void)TerminateProcess(pi.hProcess, 1);
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    if (job != NULL) CloseHandle(job);

    if (inInit)  relay_close(&inPipe);
    if (outInit) relay_close(&outPipe);
    if (errInit) relay_close(&errPipe);

    if (attrList != NULL) {
        DeleteProcThreadAttributeList(attrList);
        LocalFree(attrList);
    }
    if (secCapSids != NULL) LocalFree(secCapSids);
    if (loopbackCapSid != NULL) LocalFree(loopbackCapSid);
    if (loopbackCapSidStr != NULL) LocalFree(loopbackCapSidStr);
    if (capGroupSids != NULL) {
        for (i = 0; i < capGroupSidCount; i++) {
            if (capGroupSids[i] != NULL) LocalFree(capGroupSids[i]);
        }
        LocalFree(capGroupSids);
    }
    if (capSids != NULL) {
        for (i = 0; i < capSidCount; i++) {
            if (capSids[i] != NULL) LocalFree(capSids[i]);
        }
        LocalFree(capSids);
    }
    if (packageSid != NULL) FreeSid(packageSid);
    if (cmdLine != NULL) LocalFree(cmdLine);
    if (envBlock != NULL) LocalFree(envBlock);

    return hr;
}

/* ------------------------------------------------------------------ */
/* Subcommand: run                                                     */
/* ------------------------------------------------------------------ */

static void usage_run(void) {
    fwprintf(stderr,
        L"octopus-sandbox-helper: usage:\n"
        L"  octopus-sandbox-helper.exe run\n"
        L"      --job <name> --mem-mb <n> --pkg <moniker>\n"
        L"      --proxy <host:port> --ca <path> --bootstrap <path>\n"
        L"      --node <nodePath> -- <argv...>\n");
}

/*
 * cmd_run -- parse the run flags and delegate to launch_sandboxed. Exits
 * with the child's exit code on success; usage error = 2; launch failure = 1.
 */
static int cmd_run(int argc, wchar_t **argv, int startIdx) {
    SANDBOX_LAUNCH_ARGS a;
    PCWSTR childArgv = NULL;
    DWORD memMb = 0;
    DWORD childExit = 0;
    HRESULT hr;
    int i;

    ZeroMemory(&a, sizeof(a));

    for (i = startIdx; i < argc; i++) {
        PCWSTR f = argv[i];
        if (wcscmp(f, L"--") == 0) {
            i++;
            if (i < argc) {
                childArgv = (PCWSTR)&argv[i];
            }
            break;
        }
        if (i + 1 >= argc) { usage_run(); return 2; }
        if (wcscmp(f, L"--job") == 0) {
            a.jobName = argv[++i];
        } else if (wcscmp(f, L"--mem-mb") == 0) {
            PCWSTR s = argv[++i];
            LPWSTR end = NULL;
            unsigned long v = wcstoul(s, &end, 10);
            if (end == s || *end != L'\0' || v == 0) { usage_run(); return 2; }
            memMb = (DWORD)v;
        } else if (wcscmp(f, L"--pkg") == 0) {
            a.pkgMoniker = argv[++i];
        } else if (wcscmp(f, L"--proxy") == 0) {
            a.proxyHostPort = argv[++i];
        } else if (wcscmp(f, L"--ca") == 0) {
            a.caPath = argv[++i];
        } else if (wcscmp(f, L"--bootstrap") == 0) {
            a.bootstrapPath = argv[++i];
        } else if (wcscmp(f, L"--node") == 0) {
            a.nodePath = argv[++i];
        } else {
            usage_run();
            return 2;
        }
    }

    a.memMb = memMb;
    a.argv = childArgv;

    if (a.jobName == NULL || a.memMb == 0 || a.pkgMoniker == NULL ||
        a.proxyHostPort == NULL || a.caPath == NULL ||
        a.bootstrapPath == NULL || a.nodePath == NULL) {
        usage_run();
        return 2;
    }

    hr = launch_sandboxed(&a, &childExit);
    if (FAILED(hr)) {
        return fail_hr(L"launch_sandboxed", hr);
    }
    /* Propagate the child's exit code verbatim. A DWORD can exceed 255 but
     * the Windows process exit code IS a DWORD, so this is lossless. */
    return (int)childExit;
}

/* ------------------------------------------------------------------ */
/* wmain -- argv dispatcher                                            */
/* ------------------------------------------------------------------ */

static void usage(void) {
    fwprintf(stderr,
        L"octopus-sandbox-helper: usage:\n"
        L"  octopus-sandbox-helper.exe sid <moniker>\n"
        L"  octopus-sandbox-helper.exe probe\n"
        L"  octopus-sandbox-helper.exe run --job <name> --mem-mb <n> --pkg <moniker>\n"
        L"      --proxy <host:port> --ca <path> --bootstrap <path> --node <nodePath>\n"
        L"      -- <argv...>\n");
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) {
        usage();
        return 2;
    }

    if (wcscmp(argv[1], L"sid") == 0) {
        if (argc != 3) {
            usage();
            return 2;
        }
        return cmd_sid(argv[2]);
    }

    if (wcscmp(argv[1], L"probe") == 0) {
        if (argc != 2) {
            usage();
            return 2;
        }
        return cmd_probe();
    }

    if (wcscmp(argv[1], L"run") == 0) {
        return cmd_run(argc, argv, 2);
    }

    /* Unknown subcommand. Later tasks (8, 9) will add `grant-acl` and
     * `teardown` arms here; keep this a plain if/else chain so adding them
     * is a one-line change each. */
    fwprintf(stderr, L"octopus-sandbox-helper: unknown subcommand '%ls'\n", argv[1]);
    usage();
    return 2;
}
