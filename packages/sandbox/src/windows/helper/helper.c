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
 *   octopus-sandbox-helper.exe diag-launch --node <path>
 *                                              -- run-10 diagnostic: probe
 *                                                 image/winsta/desktop access
 *                                                 under the production
 *                                                 restricted token and run a
 *                                                 launch-variant battery; all
 *                                                 output on stderr, exit 0
 *                                                 once the battery completes.
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
 *   advapi32.lib    -- ConvertSidToStringSidW / ConvertStringSidToSidW, and
 *                      the Option-3 restricted-token calls
 *                      (OpenProcessToken / DuplicateTokenEx /
 *                      CreateRestrictedToken / CreateWellKnownSid /
 *                      SetTokenInformation); the Option-3 launch itself uses
 *                      CreateProcessWithTokenW (kernel32)
 *   onecoreuap.lib  -- DeriveCapabilitySidsFromName (KernelBase.dll)
 *   user32.lib      -- diag-launch window-station/desktop probes
 *                      (OpenWindowStationW / OpenDesktopW; not a default lib)
 */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

/* API surface targeting.
 *
 * The helper's minimum target is Windows 10. Two independent gates must be
 * set BEFORE any SDK header is included, because scripts/build-win-helper.mjs
 * passes NO /D for either (verified — compileObj/linkExe carry only
 * /nologo /c /W4 /WX /O2 /std:c17 /Fo); the file must self-define them:
 *
 *   _WIN32_WINNT  = 0x0A00 (WIN10)   -- selects the Win10 API surface.
 *   NTDDI_VERSION = NTDDI_WIN10      -- gates the SDK declarations that are
 *                                       wrapped in #if (NTDDI_VERSION >=
 *                                       NTDDI_WIN10). This covers
 *                                       DeriveCapabilitySidsFromName
 *                                       (securitybaseapi.h) and the LPAC
 *                                       PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY
 *                                       constant used by launch_sandboxed,
 *                                       both of which are Win10-gated.
 *                                       Task 6's CreateAppContainerProfile
 *                                       is Win8+ and already covered, but
 *                                       the single Win10 floor keeps the
 *                                       whole file consistent.
 *
 * NTDDI_WIN10 is defined in <sdkddkver.h>; we cannot reference it before
 * including a header, so we set NTDDI_VERSION to its literal value
 * (0x0A000000) and let <sdkddkver.h> (pulled in by <windows.h>) confirm it.
 * The #ifndef guards let a future build-script /D override win. */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00 /* _WIN32_WINNT_WIN10 */
#endif
#ifndef NTDDI_VERSION
#define NTDDI_VERSION 0x0A000000 /* NTDDI_WIN10 */
#endif

#include <windows.h>
#include <sddl.h>      /* ConvertSidToStringSidW, ConvertStringSidToSidW */
#include <userenv.h>   /* CreateAppContainerProfile, DeleteAppContainerProfile */
#include <aclapi.h>    /* GetNamedSecurityInfoW, SetNamedSecurityInfoW,
                        * SetEntriesInAclW, EXPLICIT_ACCESSW, TRUSTEE_W */
#include <stdio.h>     /* fwprintf */
#include <stdlib.h>    /* wcstoul */
#include <wchar.h>     /* swprintf_s, _wcsnicmp, wcslen, wcscmp, memcpy (via string.h) */
#include <string.h>    /* memcpy, ZeroMemory macro lives in windows.h but memcpy is here */

#include "helper.h"

#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "onecoreuap.lib")
/* user32.lib -- the run-10 diag-launch probes OpenWindowStationW /
 * OpenDesktopW / CloseWindowStation / CloseDesktop. user32 is NOT in the
 * cl/link default library set (only kernel32 is), so it must be requested
 * explicitly. Diagnostic-only surface, but a link failure fails the lane. */
#pragma comment(lib, "user32.lib")

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
    /* stderr to a pipe is block-buffered; flush or a quick exit(1) drops the
     * diagnostic before the parent's relay ever reads it. */
    fflush(stderr);
    return 1;
}

static int fail_win32(PCWSTR context, DWORD err) {
    fwprintf(stderr, L"octopus-sandbox-helper: %ls failed (err=%lu)\n",
             context, (unsigned long)err);
    fflush(stderr);
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
 * CommandLineToArgvW rules (see append_quoted). Node's own argv does not
 * normally need elaborate quoting (it is "node.exe -e <code>"), but the
 * -- <argv...> tail is arbitrary skill input, so every argument is quoted
 * defensively via append_quoted.
 *
 * Returns a LocalAlloc'd, NUL-terminated command line on success; caller
 * frees with LocalFree. NULL on allocation failure.
 */
/*
 * append_quoted -- append one argument to a CreateProcessW command line,
 * wrapped in double quotes with the full CommandLineToArgvW escaping rule.
 *
 * CommandLineToArgvW (and the MSVC CRT argument parser Node uses) treats a
 * backslash as literal EXCEPT when it precedes a double quote:
 *   - 2n backslashes followed by a quote  -> n literal backslashes; the
 *     quote is an argument delimiter.
 *   - 2n+1 backslashes followed by a quote -> n literal backslashes; the
 *     quote is a LITERAL character (escaped).
 *   - backslashes not followed by a quote (including at end of the raw arg)
 *     are literal.
 *
 * To round-trip an arbitrary raw argument we therefore emit, for each
 * maximal run of N backslashes:
 *   - run followed by a '"'     -> 2N backslashes, then '\"'  (escape the quote)
 *   - run at end of argument    -> 2N backslashes              (protect the closing quote)
 *   - run before any other char -> N backslashes               (literal)
 * and we always wrap the whole argument in double quotes. This handles
 * backslashes-before-quote EVERYWHERE in the argument, not just at the end.
 *
 * The output buffer must have room for at least 2*wcslen(arg)+2 wide chars
 * (the caller's worst-case bound guarantees this). *ppw is advanced past
 * the appended text.
 */
static void append_quoted(LPWSTR *ppw, PCWSTR arg) {
    LPWSTR w = *ppw;
    PCWSTR r = arg;

    *w++ = L'"';
    while (*r != L'\0') {
        if (*r == L'\\') {
            /* Measure the maximal backslash run. */
            PCWSTR bs = r;
            SIZE_T n;
            while (*bs == L'\\') bs++;
            n = (SIZE_T)(bs - r);
            if (*bs == L'"') {
                /* Run before a quote: double it, then escape the quote. */
                SIZE_T k;
                for (k = 0; k < 2 * n; k++) *w++ = L'\\';
                *w++ = L'\\';
                *w++ = L'"';
                r = bs + 1; /* consumed the run AND the quote */
            } else if (*bs == L'\0') {
                /* Trailing run at end of arg: double it to protect the
                 * closing quote we are about to emit. */
                SIZE_T k;
                for (k = 0; k < 2 * n; k++) *w++ = L'\\';
                r = bs; /* consumed the run; loop sees the NUL and exits */
            } else {
                /* Run before an ordinary char: literal. */
                SIZE_T k;
                for (k = 0; k < n; k++) *w++ = L'\\';
                r = bs; /* leave the ordinary char for the next iteration */
            }
        } else if (*r == L'"') {
            /* A bare quote (not preceded by a backslash run): escape it. */
            *w++ = L'\\';
            *w++ = L'"';
            r++;
        } else {
            *w++ = *r++;
        }
    }
    *w++ = L'"';

    *ppw = w;
}

static LPWSTR build_command_line(PCWSTR nodePath, PCWSTR *argv) {
    /* Worst-case length: every input char can produce at most 2 output
     * chars (a run of N backslashes before a quote yields 2N+2 from N+1
     * input chars, i.e. <= 2x), plus the two wrapping quotes and one
     * separating space per arg, plus the terminating NUL. */
    SIZE_T len = 0;
    SIZE_T i;
    LPWSTR out = NULL;
    LPWSTR w;

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

    append_quoted(&w, nodePath);
    if (argv != NULL) {
        for (i = 0; argv[i] != NULL; i++) {
            *w++ = L' ';
            append_quoted(&w, argv[i]);
        }
    }

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
     * buffers so they can be sorted and freed uniformly.
     *
     * SCHEME CONTRACT (unresolved — owned by Task 8, the TS caller): the
     * helper passes args->proxyHostPort through VERBATIM as the value of
     * HTTP_PROXY and HTTPS_PROXY. Spec §4d mandates the value be
     * "http://127.0.0.1:<proxyPort>" (a full scheme-qualified URL), but the
     * test currently passes a bare "host:port" and undici's ProxyAgent also
     * accepts a bare host:port. Whether the helper prepends "http://" or the
     * TS caller (Task 8) supplies a scheme-qualified value is NOT decided in
     * Task 7 — the reviewer deferred scheme ownership to Task 8. The helper
     * therefore does NO scheme normalization here; if Task 8 settles on a
     * bare host:port from the TS side, the helper must prepend "http://" at
     * this assignment. Do not silently change one side without the other. */
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

    /* ---- Option-3 restricted-token state (allocated, freed on every path).
     * Only populated when args->useRestrictedToken is set. ---- */
    HANDLE hToken = NULL;      /* our own process token (TOKEN_DUPLICATE|...) */
    HANDLE hPrimary = NULL;    /* primary duplicate of hToken */
    HANDLE hRestricted = NULL; /* CreateRestrictedToken-hardened launch token */
    PSID pAdminSid = NULL;     /* local Administrators alias (deny-only entry) */
    PSID pLowIntegritySid = NULL; /* S-1-16-4096 mandatory-label SID */
    SID_AND_ATTRIBUTES disableSids[1]; /* deny-only GROUP SID set */
    DWORD disableSidCount = 0;
    TOKEN_MANDATORY_LABEL tml;

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
    WCHAR jobNameBuf[MAX_PATH]; /* Global\-prefixed Job name (run-12) */
    PCWSTR jobCreateName;       /* name handed to CreateJobObjectW */

    HRESULT hr = S_OK;
    DWORD err = 0;
    DWORD i;

    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    ZeroMemory(&secCaps, sizeof(secCaps));
    ZeroMemory(&tml, sizeof(tml));
    ZeroMemory(disableSids, sizeof(disableSids));
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
     *
     * RUN-6 DIAGNOSTIC (skipLpac): when args->skipLpac is set this entire
     * step is skipped — no AppContainer profile, no SECURITY_CAPABILITIES,
     * no ALL_APPLICATION_PACKAGES opt-out, and attrList stays NULL so
     * CreateProcessW gets a plain (non-LPAC) token. This is the
     * single-variable "no LPAC" matrix arm; it is diagnostic-only and the
     * production win-backend never sets it.
     *
     * OPTION-3 (useRestrictedToken): when args->useRestrictedToken is set the
     * LPAC Step A is skipped EXACTLY as for skipLpac — the restricted token
     * is built instead in Step A' (below) and the child launches via
     * CreateProcessWithTokenW. useRestrictedToken takes precedence: it implies
     * "no LPAC attribute list."
     * ============================================================== */

    if (!args->skipLpac && !args->useRestrictedToken) {
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
    fwprintf(stderr, L"[run] appcontainer profile resolved\n");
    fflush(stderr);

    /* A2. Derive the base capability SIDs for the moniker (group + normal).
     * These give the token the moniker's declared capabilities. */
    if (!DeriveCapabilitySidsFromName(args->pkgMoniker,
                                      &capGroupSids, &capGroupSidCount,
                                      &capSids, &capSidCount)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    fwprintf(stderr, L"[run] capability sids derived\n");
    fflush(stderr);

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

    /* A4. Build the SID_AND_ATTRIBUTES array for SECURITY_CAPABILITIES.
     *
     * ROOT CAUSE of the run-4 E_INVALIDARG (0x80070057) at CreateProcessW:
     * this array previously ALSO included every CapabilityGroupSid returned
     * by DeriveCapabilitySidsFromName. Those are NT-Authority group SIDs
     * (S-1-5-...), NOT AppContainer capability SIDs. SECURITY_CAPABILITIES
     * .Capabilities must contain ONLY AppAuthority capability SIDs
     * (S-1-15-3-...). Microsoft's "Launch an AppContainer" doc is explicit:
     * "Group SIDs are only used for services" and its GetCapabilitySidFromName
     * helper FREES the group SIDs and keeps only CapabilitySids[0]. Putting
     * NT-Authority group SIDs into the AppContainer capability list makes the
     * token-creation parameters invalid, and CreateProcessW rejects the launch
     * with ERROR_INVALID_PARAMETER.
     *
     * Fix: exclude the group SIDs. The array carries the AppAuthority
     * capability SIDs (capSids) PLUS the loopback capability, each with
     * SE_GROUP_ENABLED. The group SIDs are still derived above (their
     * successful derivation sanity-checks the moniker) and are freed in the
     * cleanup block below; they are simply never placed in the token. */
    secCapSidCount = capSidCount + 1;
    secCapSids = (SID_AND_ATTRIBUTES *)LocalAlloc(LMEM_FIXED | LMEM_ZEROINIT,
        secCapSidCount * sizeof(SID_AND_ATTRIBUTES));
    if (secCapSids == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }
    {
        DWORD idx = 0;
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

    /* DIAGNOSTIC (run 5): print the exact capability-array composition and
     * the loopback SID string so the next CI run confirms the token's
     * capability list contains only AppAuthority S-1-15-3 capability SIDs.
     * capGroupSidCount is printed to prove the group SIDs were derived but
     * are now EXCLUDED from the array. */
    fwprintf(stderr,
             L"[run] secCaps: capSids=%lu loopback=1 groupSids(excluded)=%lu "
             L"totalInArray=%lu loopbackSid=%ls\n",
             (unsigned long)capSidCount,
             (unsigned long)capGroupSidCount,
             (unsigned long)secCapSidCount,
             loopbackCapSidStr);
    fflush(stderr);

    /* DIAGNOSTIC (run 5, SID-match): print the AppContainer (package) SID and
     * EVERY capability SID placed in the token, as strings. The LPAC access
     * check is the INTERSECTION of user/group SIDs and AppContainer SIDs
     * (MS "Launch an AppContainer": "the permitted access is the intersection
     * of that granted by the user/group SIDs and AppContainer SIDs"), so the
     * SIDs granted by grant-acl MUST be SIDs the token actually presents.
     * Comparing these strings against the grant-acl "[grant] sid=" lines in
     * the same CI log proves match/mismatch. */
    {
        LPWSTR pkgSidStr = NULL;
        if (ConvertSidToStringSidW(packageSid, &pkgSidStr)) {
            fwprintf(stderr, L"[run] token AppContainerSid=%ls\n", pkgSidStr);
            LocalFree(pkgSidStr);
        }
        for (i = 0; i < secCapSidCount; i++) {
            LPWSTR capStr = NULL;
            if (ConvertSidToStringSidW(secCapSids[i].Sid, &capStr)) {
                fwprintf(stderr, L"[run] token capability[%lu]=%ls\n",
                         (unsigned long)i, capStr);
                LocalFree(capStr);
            }
        }
        fflush(stderr);
    }

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
    fwprintf(stderr, L"[run] attribute list built\n");
    fflush(stderr);
    } else {
        /* RUN-6 DIAGNOSTIC (skipLpac) / OPTION-3 (useRestrictedToken):
         * attrList is left NULL and si.lpAttributeList is never set, so the
         * child launches with a PLAIN token — no AppContainer, no capability
         * SIDs, no ALL_APPLICATION_PACKAGES opt-out. packageSid / capSids /
         * loopbackCapSid / secCapSids all stay NULL and the cleanup block
         * already NULL-guards each free, so skipping Step A is safe. */
        if (args->useRestrictedToken) {
            fwprintf(stderr, L"[run] LPAC attribute list omitted (restricted-token path)\n");
        } else {
            fwprintf(stderr, L"[run] DIAG skipLpac: LPAC attribute list omitted (plain token)\n");
        }
        fflush(stderr);
    }

    /* ==============================================================
     * Step A' -- OPTION-3: build the hardened restricted token.
     *
     * Runs INSTEAD of the LPAC Step A when args->useRestrictedToken is set.
     * The 6-arm run-6 matrix proved the LPAC token is the NECESSARY trigger
     * for the node.exe 0x80000003 fast-fail; the specific Node/V8 internal
     * trigger point is pending crash-stack confirmation. This path moves the
     * production node launch off LPAC onto a CreateRestrictedToken-hardened
     * PLAIN token that keeps the user's normal identity (file/registry access
     * via the user + logon SIDs) but strips admin power and every dangerous
     * privilege, and lowers the child to Low integrity.
     *
     * Hardening applied:
     *   1. Duplicate our own (admin) token to a primary token.
     *   2. CreateRestrictedToken with DISABLE_MAX_PRIVILEGE — every privilege
     *      is removed except SeChangeNotifyPrivilege ("bypass traverse
     *      checking"), which is required for ordinary file-path access.
     *   3. A MINIMAL deny-only GROUP SID set: only the local Administrators
     *      alias (WinBuiltinAdministratorsSid) is disabled. The user's own
     *      SID and the logon SID are intentionally NOT disabled so node can
     *      still read its install tree, the staged copy, and HKCU.
     *   4. Low integrity (S-1-16-4096, SECURITY_MANDATORY_LOW_RID) via
     *      SetTokenInformation — a strong process-isolation boundary against
     *      the host's Medium/High processes.
     *
     * Any failure here is fail-closed: no partially-hardened token is ever
     * used for launch. The Job Object (Step C/D) is applied to this child
     * exactly as for the LPAC path.
     * ============================================================== */
    if (args->useRestrictedToken) {
        /* 1. Open our own process token. Only TOKEN_DUPLICATE | TOKEN_QUERY
         * are requested: DuplicateTokenEx re-acquires full rights on the
         * duplicate, and neither CreateRestrictedToken nor the integrity
         * lowering needs TOKEN_ADJUST_DEFAULT / TOKEN_ADJUST_SESSIONID on the
         * source token. Least-privilege on the source handle. */
        if (!OpenProcessToken(GetCurrentProcess(),
                              TOKEN_DUPLICATE | TOKEN_QUERY,
                              &hToken)) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }

        /* 2. Duplicate to a PRIMARY token — CreateRestrictedToken derives
         * from a primary token; the Option-3 launch (CreateProcessWithTokenW)
         * accepts primary or impersonation tokens, and the primary form is
         * the clean one for process creation. */
        if (!DuplicateTokenEx(hToken, TOKEN_ALL_ACCESS, NULL,
                              SecurityImpersonation, TokenPrimary,
                              &hPrimary)) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }

        /* 3a. Build the deny-only GROUP SID set. MINIMAL and documented:
         * only the local Administrators alias is made deny-only (attributes
         * == 0). Stripping admin membership removes administrative power while
         * the token retains its user identity. We deliberately do NOT disable
         * the user's own SID or the logon SID — node needs those to read
         * files and the registry. */
        {
            DWORD adminSidSize = (DWORD)SECURITY_MAX_SID_SIZE;
            pAdminSid = (PSID)LocalAlloc(LMEM_FIXED, adminSidSize);
            if (pAdminSid == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }
            if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL,
                                    pAdminSid, &adminSidSize)) {
                err = GetLastError();
                hr = HRESULT_FROM_WIN32(err);
                goto cleanup;
            }
        }
        disableSids[0].Sid = pAdminSid;
        disableSids[0].Attributes = 0; /* 0 => "disable" (deny-only) */
        disableSidCount = 1;

        /* 3b. Build the restricted token. DISABLE_MAX_PRIVILEGE strips all
         * privileges except SeChangeNotifyPrivilege. No SIDs are deleted
         * (deleteSidCount 0) and no restricted SIDs are added. */
        if (!CreateRestrictedToken(hPrimary, DISABLE_MAX_PRIVILEGE,
                                   disableSidCount, disableSids,
                                   0, NULL,   /* no SIDs deleted */
                                   0, NULL,   /* no restricted SIDs */
                                   &hRestricted)) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }

        /* 4. Lower integrity to Low (S-1-16-4096). Build the mandatory-label
         * SID and set TokenIntegrityLevel with SE_GROUP_INTEGRITY. */
        if (!ConvertStringSidToSidW(L"S-1-16-4096", &pLowIntegritySid)) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }
        tml.Label.Sid = pLowIntegritySid;
        tml.Label.Attributes = SE_GROUP_INTEGRITY;
        if (!SetTokenInformation(hRestricted, TokenIntegrityLevel,
                                 &tml, (DWORD)sizeof(tml))) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }

        fwprintf(stderr, L"[run] restricted token built (privileges stripped, admins disabled, low integrity)\n");
        fflush(stderr);
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

    if (args->selfTest) {
        /* RUN-5 CONTROLLED EXPERIMENT: launch the helper EXE itself running
         * `run-probe-child` instead of node.exe. The probe child is a minimal
         * native process (no V8, no --require bootstrap execution) that
         * ExitProcess(3)es. It runs under the IDENTICAL LPAC token + Job, so:
         *   - self-test passes (exit 3 relayed)  => LPAC token + Job + file
         *     access to the launched exe are all viable; node/V8 is the cause.
         *   - self-test also fastfails 0x80000003 => the LPAC token / file
         *     access itself is broken, independent of node.
         * GetModuleFileNameW(NULL,...) resolves the running helper's own path
         * (a real, readable exe the LPAC token can load once granted). */
        WCHAR selfPath[MAX_PATH];
        PCWSTR probeArgv[2];
        DWORD mlen = GetModuleFileNameW(NULL, selfPath, ARRAYSIZE(selfPath));
        if (mlen == 0 || mlen >= ARRAYSIZE(selfPath)) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err == ERROR_SUCCESS ? ERROR_BUFFER_OVERFLOW : err);
            goto cleanup;
        }
        probeArgv[0] = L"run-probe-child";
        probeArgv[1] = NULL;
        cmdLine = build_command_line(selfPath, probeArgv);
        fwprintf(stderr, L"[run] selftest: child = self exe run-probe-child\n");
        fflush(stderr);
    } else {
        cmdLine = build_command_line(args->nodePath, args->argv);
    }
    if (cmdLine == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }

    fwprintf(stderr, L"[run] relay pipes + env + cmdline ready\n");
    fflush(stderr);

    /* DIAGNOSTIC (run 5): print the env block byte count, the full command
     * line, and the AppContainer moniker so that if CreateProcessW still
     * returns E_INVALIDARG after the group-SID fix, the next CI log shows
     * exactly which remaining parameter (env block size / cmdline quoting /
     * moniker) is malformed. envBlockBytes must be the Unicode block size in
     * bytes (4 zero bytes terminate it); cmdLine must be properly quoted. */
    fwprintf(stderr,
             L"[run] createprocess params: envBlockBytes=%lu pkgMoniker=%ls\n",
             (unsigned long)envBlockBytes, args->pkgMoniker);
    fflush(stderr);
    fwprintf(stderr, L"[run] createprocess cmdline: %ls\n", cmdLine);
    fflush(stderr);

    /* STARTUPINFOEXW has no top-level cb member; the embedded STARTUPINFOW's
     * cb must be set to the size of the FULL extended struct
     * (sizeof(STARTUPINFOEXW)), per the CreateProcessW docs — otherwise the
     * EXTENDED_STARTUPINFO_PRESENT attribute list is not honored. */
    si.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = inPipe.childEnd;
    si.StartupInfo.hStdOutput = outPipe.childEnd;
    si.StartupInfo.hStdError = errPipe.childEnd;
    si.lpAttributeList = attrList; /* NULL when skipLpac (no LPAC attrs) */

    if (args->useRestrictedToken) {
        /* OPTION-3: launch the child under the hardened restricted token.
         * CreateProcessWithTokenW uses hRestricted as the new process's
         * token (it does NOT impersonate it). There is NO attribute list
         * (EXTENDED_STARTUPINFO_PRESENT is omitted) because the restricted
         * token replaces the LPAC attribute list. The Job Object steps below
         * (create/configure, assign-while-suspended, ResumeThread) are applied
         * to this child identically.
         *
         * WHY CreateProcessWithTokenW and NOT CreateProcessAsUserW (run-7 CI
         * finding, hr=0x80070522): CreateProcessAsUserW requires the caller
         * to hold SE_ASSIGNPRIMARY_TOKEN_NAME + SE_INCREASE_QUOTA_NAME,
         * which only SERVICE tokens carry — an (even elevated) interactive
         * admin token fails with ERROR_PRIVILEGE_NOT_HELD (1314).
         * CreateProcessWithTokenW instead requires SE_IMPERSONATE_NAME,
         * which admin tokens hold by default.
         *
         * WHY LOGON_NETCREDENTIALS_ONLY and NOT LOGON_WITH_PROFILE (run-8 CI
         * finding, hr=0x80070005): LOGON_WITH_PROFILE loads the token user's
         * profile hive, which requires WRITE access to the (Medium integrity)
         * profile directory — the Low-integrity restricted token is blocked
         * by write-up (NO_WRITE_UP) and the launch fails with ACCESS_DENIED.
         * The profile is unnecessary here: the child's environment is the
         * explicit envBlock (not the profile environment), and node needs no
         * HKCU hive to start. LOGON_NETCREDENTIALS_ONLY skips the profile
         * load entirely; the token's credentials still apply for network
         * authentication.
         *
         * WHY NOT CREATE_NO_WINDOW (run-12 finding): adding CREATE_NO_WINDOW
         * made the one-shot child (whose stdout/stderr are the relay pipes)
         * hang for the full timeout — under the Low-integrity token the
         * child could not produce pipe output, so the helper's relay loop
         * never saw EOF and the test timed out. The window-station/desktop
         * check was NOT the run-9 denial (diag battery arm B with
         * CREATE_NO_WINDOW still failed), so the flag is reverted. The child
         * attaches to the helper's (inherited) console state normally. */
        fwprintf(stderr, L"[run] launching via CreateProcessWithTokenW\n");
        fflush(stderr);
        /* CreateProcessWithTokenW takes a plain STARTUPINFOW (not the
         * extended struct); cb must be sizeof(STARTUPINFOW). The EXW-size cb
         * set above is only correct for CreateProcessW +
         * EXTENDED_STARTUPINFO_PRESENT. */
        si.StartupInfo.cb = sizeof(STARTUPINFOW);
        /* Defense-in-depth: clear the attribute list so this no-extended-flag
         * launch can never carry a stale list (attrList is already NULL on the
         * restricted path, since the LPAC Step A was skipped). */
        si.lpAttributeList = NULL;
        /* CreateProcessWithTokenW has no bInheritHandles parameter: with
         * STARTF_USESTDHANDLES set, the inheritable pipe ends in hStd* are
         * inherited by the child (they were created inheritable). */
        if (!CreateProcessWithTokenW(hRestricted,  /* hardened restricted token */
                                  LOGON_NETCREDENTIALS_ONLY,
                                  NULL,         /* lpApplicationName — use cmdLine */
                                  cmdLine,      /* lpCommandLine */
                                  CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                                  envBlock,
                                  NULL,         /* lpCurrentDirectory — inherit */
                                  &si.StartupInfo,
                                  &pi)) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }
    } else if (!CreateProcessW(NULL,           /* lpApplicationName — use cmdLine */
                        cmdLine,        /* lpCommandLine */
                        NULL,           /* lpProcessAttributes */
                        NULL,           /* lpThreadAttributes */
                        TRUE,           /* bInheritHandles — inherit the 3 pipe ends */
                        CREATE_SUSPENDED |
                        CREATE_UNICODE_ENVIRONMENT |
                        /* EXTENDED_STARTUPINFO_PRESENT is required to honor
                         * lpAttributeList; it is harmless-but-pointless when
                         * the list is NULL, so omit it on the skipLpac arm to
                         * keep that arm's CreateProcess call minimal. */
                        (args->skipLpac ? 0 : EXTENDED_STARTUPINFO_PRESENT),
                        envBlock,
                        NULL,           /* lpCurrentDirectory — inherit */
                        &si.StartupInfo,
                        &pi)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }
    processCreated = TRUE;
    fwprintf(stderr, L"[run] child process created (suspended), pid=%lu\n",
             (unsigned long)pi.dwProcessId);
    fflush(stderr);

    /* The child now holds its own copies of the inheritable pipe ends; the
     * parent closes its copies of the CHILD ends so EOF propagates when the
     * child exits. The parent ends stay open for the relay. */
    CloseHandle(inPipe.childEnd);  inPipe.childEnd = NULL;
    CloseHandle(outPipe.childEnd); outPipe.childEnd = NULL;
    CloseHandle(errPipe.childEnd); errPipe.childEnd = NULL;

    /* ==============================================================
     * Step C -- Job Object create + configure.
     *
     * RUN-6 DIAGNOSTIC (skipJob): when args->skipJob is set this step and
     * Step D are skipped entirely — no Job is created and the child is
     * never assigned to one. The child is still CREATE_SUSPENDED ->
     * ResumeThread with the stdio relay; only the Job layer is omitted
     * (the single-variable "no Job" matrix arm). job stays NULL and the
     * cleanup block NULL-guards CloseHandle(job). Diagnostic-only.
     *
     * RUN-6 DIAGNOSTIC (noJobMemLimit): when set, the Job is created and
     * assigned but JOB_OBJECT_LIMIT_JOB_MEMORY is omitted from the
     * extended limit (KILL_ON_JOB_CLOSE and the active-process cap are
     * kept). This isolates whether the per-Job commit cap is the node/V8
     * fast-fail trigger. Diagnostic-only.
     * ============================================================== */

    if (!args->skipJob) {
    jobSa.nLength = sizeof(jobSa);
    jobSa.lpSecurityDescriptor = NULL;
    jobSa.bInheritHandle = FALSE; /* the untrusted child must NOT inherit the Job handle */

    /* RUN-12: session-0 gate service visibility. A bare Job name is created in
     * the caller's SESSION (Local\) object namespace — the helper runs in the
     * interactive session while the gate service runs in session 0, so the
     * service's OpenJobObjectW("OctJob-X") returned ERROR_FILE_NOT_FOUND and
     * the fail-safe "Job gone -> allow remove-gate" branch silently defeated
     * the alive-Job refusal (run-12 CI). When args->globalJobName is set,
     * create the Job in the GLOBAL object namespace (Global\<name>) so the
     * service — which opens Global\<name> on remove-gate — can actually see
     * the live Job and refuse removal while it is populated. */
    if (args->globalJobName) {
        if (swprintf_s(jobNameBuf, ARRAYSIZE(jobNameBuf),
                       L"Global\\%ls", args->jobName) < 0) {
            hr = E_INVALIDARG; /* job name too long to prefix */
            goto cleanup;
        }
        jobCreateName = jobNameBuf;
        fwprintf(stderr, L"[run] job created in Global namespace: %ls\n", jobNameBuf);
        fflush(stderr);
    } else {
        jobCreateName = args->jobName;
    }

    job = CreateJobObjectW(&jobSa, jobCreateName);
    if (job == NULL) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!args->noJobMemLimit) {
        jeli.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
        jeli.JobMemoryLimit = (SIZE_T)args->memMb * 1024u * 1024u;
    } else {
        fwprintf(stderr, L"[run] DIAG noJobMemLimit: JOB_OBJECT_LIMIT_JOB_MEMORY omitted\n");
        fflush(stderr);
    }
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
    fwprintf(stderr, L"[run] child assigned to job\n");
    fflush(stderr);
    } else {
        fwprintf(stderr, L"[run] DIAG skipJob: no Job created/assigned\n");
        fflush(stderr);
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
    fwprintf(stderr, L"[run] child resumed\n");
    fflush(stderr);

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

    fwprintf(stderr, L"[run] relay loop entered\n");
    fflush(stderr);

    {
        BOOL loggedExit = FALSE;
        BOOL loggedOutEof = FALSE;
        BOOL loggedErrEof = FALSE;
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

        /* DIAGNOSTIC stage markers (run 3): log the first time each terminal
         * condition becomes true so a hang shows exactly which condition is
         * never satisfied — child-exited, stdout-EOF, stderr-EOF. */
        if (!loggedExit &&
            WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0) {
            loggedExit = TRUE;
            fwprintf(stderr, L"[run] child exited\n");
            fflush(stderr);
        }
        if (!loggedOutEof && outPipe.eof) {
            loggedOutEof = TRUE;
            fwprintf(stderr, L"[run] stdout pipe eof\n");
            fflush(stderr);
        }
        if (!loggedErrEof && errPipe.eof) {
            loggedErrEof = TRUE;
            fwprintf(stderr, L"[run] stderr pipe eof\n");
            fflush(stderr);
        }

        /* Exit the loop once the child is gone AND both pipes are drained. */
        if (WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0 &&
            outPipe.eof && errPipe.eof &&
            !outPipe.pending && !errPipe.pending) {
            break;
        }
        }
    }

    /* Final flush — anything still buffered after EOF. */
    (void)relay_flush_ready(&outPipe, 1);
    (void)relay_flush_ready(&errPipe, 2);

    fwprintf(stderr, L"[run] relay loop exited\n");
    fflush(stderr);

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

    /* Option-3 restricted-token state: close every token handle and free
     * every SID, each NULL-guarded, on every exit path (success and all
     * failure paths alike). */
    if (hRestricted != NULL) CloseHandle(hRestricted);
    if (hPrimary != NULL) CloseHandle(hPrimary);
    if (hToken != NULL) CloseHandle(hToken);
    if (pAdminSid != NULL) LocalFree(pAdminSid);
    if (pLowIntegritySid != NULL) LocalFree(pLowIntegritySid);

    if (cmdLine != NULL) LocalFree(cmdLine);
    if (envBlock != NULL) LocalFree(envBlock);

    return hr;
}

/* ------------------------------------------------------------------ */
/* Subcommand: run                                                     */
/* ------------------------------------------------------------------ */

/*
 * cmd_run_probe_child -- the minimal LPAC child used by `run --selftest`.
 *
 * This is the controlled experiment's "no-V8" arm. It does NO node/V8/CRT-
 * heavy init: it writes a liveness marker to its stderr (relayed by the
 * parent to the helper's stderr) and ExitProcess(3)es. If THIS child runs
 * clean under the LPAC token + Job but node.exe fastfails (0x80000003), the
 * crash is in node/V8 init under LPAC, not in the token / Job / file access.
 * If it ALSO fastfails, the LPAC token / file access itself is broken.
 *
 * Exit code 3 is chosen to match the helper-run test's expected child exit so
 * the same assertion path validates both arms.
 */
__declspec(noreturn) static void cmd_run_probe_child(void) {
    fwprintf(stderr, L"[run-probe-child] alive under LPAC, exiting 3\n");
    fflush(stderr);
    /* Use ExitProcess (not return from wmain) so no atexit / CRT teardown
     * runs — the point is the smallest possible surface that still proves the
     * loader + process init succeeded under LPAC. Marked noreturn so callers
     * need no unreachable trailing return (C4702 under /WX). */
    ExitProcess(3);
}


static void usage_run(void) {
    fwprintf(stderr,
        L"octopus-sandbox-helper: usage:\n"
        L"  octopus-sandbox-helper.exe run\n"
        L"      --job <name> --mem-mb <n> --pkg <moniker>\n"
        L"      --proxy <host:port> --ca <path> --bootstrap <path>\n"
        L"      --node <nodePath> -- <argv...>\n"
        L"  octopus-sandbox-helper.exe run --selftest --job <name> --mem-mb <n>\n"
        L"      --pkg <moniker> --proxy <host:port> --ca <path> --bootstrap <path>\n"
        L"      --node <nodePath>   (selftest launches the helper exe itself as the\n"
        L"      LPAC child via run-probe-child; --node is accepted but unused)\n"
        L"  PRODUCTION MODE (Option 3 — the node launch path; replaces the LPAC\n"
        L"  token with a CreateRestrictedToken-hardened plain token + Job):\n"
        L"      --restricted-token  launch node under a restricted token (privileges\n"
        L"                          stripped, local Administrators deny-only, Low\n"
        L"                          integrity) + the Job Object. REPLACES the LPAC\n"
        L"                          Step A; wins over the LPAC path when both apply.\n"
        L"                          The LPAC path and the --skip-* flags below are\n"
        L"                          diagnostic-only.\n"
        L"  RUN-6 DIAGNOSTIC-ONLY flags (not part of the production launch\n"
        L"  contract; each removes ONE sandbox layer for the node/V8 root-cause\n"
        L"  matrix; must be removed/guarded before release):\n"
        L"      --skip-job          do not create/assign the Job Object\n"
        L"      --skip-lpac         do not attach the AppContainer attribute list\n"
        L"                          (plain token; Job still applied unless --skip-job)\n"
        L"      --no-job-mem-limit  create the Job but omit JOB_OBJECT_LIMIT_JOB_MEMORY\n");
}

/*
 * cmd_run -- parse the run flags and delegate to launch_sandboxed. Exits
 * with the child's exit code on success; usage error = 2; launch failure = 1.
 */
static int cmd_run(int argc, wchar_t **argv, int startIdx) {
    SANDBOX_LAUNCH_ARGS a;
    /* Points at the first element of the NULL-terminated tail of argv that
     * follows the literal "--" separator. &argv[i] has type wchar_t **,
     * which decays to PCWSTR * — matching SANDBOX_LAUNCH_ARGS.argv. NULL
     * when no "--" tail was given. */
    PCWSTR *childArgv = NULL;
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
                /* argv is wchar_t **; &argv[i] is wchar_t **, which the
                 * struct member (PCWSTR *) accepts — the pointed-to strings
                 * are treated as read-only. The tail is NULL-terminated
                 * because wmain's argv[argc] is NULL. */
                childArgv = (PCWSTR *)&argv[i];
            }
            break;
        }
        /* Flag with no argument. */
        if (wcscmp(f, L"--selftest") == 0) {
            a.selfTest = 1;
            continue;
        }
        /* OPTION-3 PRODUCTION MODE: launch node under a CreateRestrictedToken
         * -hardened plain token + Job Object instead of the LPAC token. This
         * is the production path; it replaces the LPAC Step A (restricted
         * token WINS over the LPAC attribute list when both would apply). */
        if (wcscmp(f, L"--restricted-token") == 0) {
            a.useRestrictedToken = 1;
            continue;
        }
        /* RUN-6 DIAGNOSTIC-ONLY flags (see helper.h): each removes exactly
         * one sandbox layer for the node/V8 root-cause matrix. They are NOT
         * part of the production launch contract and must be removed /
         * hard-guarded before release. */
        if (wcscmp(f, L"--skip-job") == 0) {
            a.skipJob = 1;
            continue;
        }
        if (wcscmp(f, L"--skip-lpac") == 0) {
            a.skipLpac = 1;
            continue;
        }
        if (wcscmp(f, L"--no-job-mem-limit") == 0) {
            a.noJobMemLimit = 1;
            continue;
        }
        /* RUN-12 PRODUCTION flag: create the named Job in the Global object
         * namespace (Global\<job>) so the session-0 gate service can open it
         * and refuse remove-gate while the Job is alive. Set by win-backend. */
        if (wcscmp(f, L"--global-job") == 0) {
            a.globalJobName = 1;
            continue;
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

    /* DIAGNOSTIC stage marker (CI hang localization, run 3): parsed args OK.
     * These markers go to the helper's OWN stderr, which the tests now stream
     * live so a hang in launch_sandboxed localizes to the last stage reached.
     * fflush forces each line out immediately (stderr to a pipe is otherwise
     * block-buffered and a hang would swallow the markers). */
    fwprintf(stderr, L"[run] parsed args\n");
    fflush(stderr);
    /* OPTION-3 PRODUCTION MODE marker: emitted on its own line so the CI log
     * shows the production restricted-token path was selected (distinct from
     * the run-6 diagnostic toggles below). */
    if (a.useRestrictedToken) {
        fwprintf(stderr, L"[run] mode: restricted-token (Option 3, production)\n");
        fflush(stderr);
    }
    /* RUN-6 DIAGNOSTIC: echo the active matrix toggles so each matrix arm's
     * CI log line is self-describing (which single variable was removed). */
    if (a.skipJob || a.skipLpac || a.noJobMemLimit) {
        fwprintf(stderr,
                 L"[run] DIAG toggles: skipJob=%d skipLpac=%d noJobMemLimit=%d\n",
                 a.skipJob, a.skipLpac, a.noJobMemLimit);
        fflush(stderr);
    }

    hr = launch_sandboxed(&a, &childExit);
    if (FAILED(hr)) {
        return fail_hr(L"launch_sandboxed", hr);
    }
    fwprintf(stderr, L"[run] launch_sandboxed returned, child exit=%lu\n",
             (unsigned long)childExit);
    fflush(stderr);
    /* Propagate the child's exit code verbatim. A DWORD can exceed 255 but
     * the Windows process exit code IS a DWORD, so this is lossless. */
    return (int)childExit;
}

/* ------------------------------------------------------------------ */
/* Subcommand: grant-acl                                               */
/* ------------------------------------------------------------------ */

/*
 * collect_lpac_sids -- gather the BINARY SID set that identifies an LPAC
 * process for a package moniker: the package SID + the derived capability
 * group SIDs + the derived capability SIDs + the loopback capability SID.
 *
 * These are exactly the SIDs the launched LPAC token carries (the same set
 * launch_sandboxed builds into SECURITY_CAPABILITIES). grant-acl grants each
 * of them READ+EXECUTE on the staged copy dir so the LPAC child — which has
 * opted OUT of ALL APPLICATION PACKAGES — can still read the copy.
 *
 * On success returns S_OK and fills *outSids with a LocalAlloc'd array of
 * PSID (count in *outCount). The array and every SID in it are LocalAlloc'd;
 * the caller frees each SID then the array, all with LocalFree. On any
 * failure *outSids is NULL, *outCount is 0, and every partial allocation is
 * freed before returning a failure HRESULT.
 */
static HRESULT collect_lpac_sids(PCWSTR moniker, PSID **outSids, DWORD *outCount) {
    PSID packageSid = NULL;
    PSID *capGroupSids = NULL;
    DWORD capGroupSidCount = 0;
    PSID *capSids = NULL;
    DWORD capSidCount = 0;
    PSID loopbackCapSid = NULL;
    LPWSTR loopbackCapSidStr = NULL;
    PSID *result = NULL;
    DWORD total = 0;
    DWORD idx = 0;
    DWORD i;
    HRESULT hr = S_OK;
    DWORD err = 0;

    if (moniker == NULL || outSids == NULL || outCount == NULL) {
        return E_INVALIDARG;
    }
    *outSids = NULL;
    *outCount = 0;

    /* Package SID (create the profile if absent; derive if it exists). */
    hr = CreateAppContainerProfile(moniker, moniker,
                                   L"AgentOctopus sandbox profile",
                                   NULL, 0, &packageSid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(moniker, &packageSid);
    }
    if (FAILED(hr)) goto cleanup;

    /* Derived capability group + normal SIDs. */
    if (!DeriveCapabilitySidsFromName(moniker,
                                      &capGroupSids, &capGroupSidCount,
                                      &capSids, &capSidCount)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    /* Loopback capability SID via the Task 6 string derive + re-parse. */
    hr = derive_loopback_capability_sid(moniker, &loopbackCapSidStr);
    if (FAILED(hr)) goto cleanup;
    if (!ConvertStringSidToSidW(loopbackCapSidStr, &loopbackCapSid)) {
        err = GetLastError();
        hr = HRESULT_FROM_WIN32(err);
        goto cleanup;
    }

    total = 1 + capGroupSidCount + capSidCount + 1;
    result = (PSID *)LocalAlloc(LMEM_FIXED | LMEM_ZEROINIT,
                                total * sizeof(PSID));
    if (result == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }

    /* Move ownership of each SID into the result array. packageSid is
     * FreeSid-allocated; copy it into a LocalAlloc buffer so the whole
     * result set has ONE free discipline (LocalFree). */
    {
        DWORD pkgLen = GetLengthSid(packageSid);
        if (pkgLen == 0) { hr = E_UNEXPECTED; goto cleanup; }
        result[idx] = (PSID)LocalAlloc(LMEM_FIXED, pkgLen);
        if (result[idx] == NULL) { hr = E_OUTOFMEMORY; goto cleanup; }
        if (!CopySid(pkgLen, result[idx], packageSid)) {
            err = GetLastError();
            hr = HRESULT_FROM_WIN32(err);
            goto cleanup;
        }
        idx++;
    }
    for (i = 0; i < capGroupSidCount; i++) {
        result[idx] = capGroupSids[i];  /* LocalAlloc'd by the API; move */
        capGroupSids[i] = NULL;
        idx++;
    }
    for (i = 0; i < capSidCount; i++) {
        result[idx] = capSids[i];       /* LocalAlloc'd by the API; move */
        capSids[i] = NULL;
        idx++;
    }
    result[idx] = loopbackCapSid;       /* LocalAlloc'd; move */
    loopbackCapSid = NULL;
    idx++;

    *outSids = result;
    *outCount = idx;
    result = NULL;
    hr = S_OK;

cleanup:
    if (result != NULL) {
        for (i = 0; i < total; i++) {
            if (result[i] != NULL) LocalFree(result[i]);
        }
        LocalFree(result);
    }
    if (packageSid != NULL) FreeSid(packageSid);
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
    return hr;
}

/*
 * grant_read_execute_on_path -- add one ACCESS_ALLOWED ACE per LPAC SID
 * (GENERIC_READ | GENERIC_EXECUTE) to the DACL of a single file or
 * directory, PRESERVING every existing ACE.
 *
 * The merge (not clobber) algorithm:
 *   1. GetNamedSecurityInfoW(DACL_SECURITY_INFORMATION) reads the current
 *      DACL (which may be NULL, meaning "no DACL = full access", or absent).
 *   2. SetEntriesInAclW(count, explicitAccess[], oldDacl, &newDacl) builds a
 *      NEW DACL that contains every old ACE PLUS the new ones — the API
 *      merges; it does not replace. New ACEs are appended after existing
 *      ones so deny-ACEs that already exist keep their precedence.
 *   3. SetNamedSecurityInfoW(DACL_SECURITY_INFORMATION) writes the merged
 *      DACL back.
 *
 * The ACEs are marked SUB_CONTAINERS_AND_OBJECTS_INHERIT when the target is
 * a directory so files/subdirs created later inherit the grant; the explicit
 * recursion in grant_acl_recursive additionally stamps existing children.
 */
static HRESULT grant_read_execute_on_path(PCWSTR path, BOOL isDir,
                                          PSID *sids, DWORD sidCount) {
    PACL oldDacl = NULL;
    PACL newDacl = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    EXPLICIT_ACCESSW *ea = NULL;
    DWORD winErr;
    HRESULT hr = S_OK;
    DWORD i;

    ea = (EXPLICIT_ACCESSW *)LocalAlloc(LMEM_FIXED | LMEM_ZEROINIT,
                                        sidCount * sizeof(EXPLICIT_ACCESSW));
    if (ea == NULL) return E_OUTOFMEMORY;

    for (i = 0; i < sidCount; i++) {
        ea[i].grfAccessPermissions = GENERIC_READ | GENERIC_EXECUTE;
        ea[i].grfAccessMode = SET_ACCESS;
        /* Directories propagate the grant to future children; files have no
         * inheritance flags. */
        ea[i].grfInheritance = isDir
            ? (SUB_CONTAINERS_AND_OBJECTS_INHERIT)
            : (NO_INHERITANCE);
        ea[i].Trustee.pMultipleTrustee = NULL;
        ea[i].Trustee.MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE;
        ea[i].Trustee.TrusteeForm = TRUSTEE_IS_SID;
        ea[i].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
        ea[i].Trustee.ptstrName = (LPWSTR)sids[i];
    }

    /* Read the current DACL. ERROR_SUCCESS with oldDacl == NULL means the
     * object has no DACL (full access); SetEntriesInAclW treats a NULL old
     * DACL as "start empty" and still produces a valid merged DACL. */
    winErr = GetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION,
                                   NULL, NULL, &oldDacl, NULL, &sd);
    if (winErr != ERROR_SUCCESS) {
        hr = HRESULT_FROM_WIN32(winErr);
        goto cleanup;
    }

    winErr = SetEntriesInAclW(sidCount, ea, oldDacl, &newDacl);
    if (winErr != ERROR_SUCCESS) {
        hr = HRESULT_FROM_WIN32(winErr);
        goto cleanup;
    }

    winErr = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                   DACL_SECURITY_INFORMATION,
                                   NULL, NULL, newDacl, NULL);
    if (winErr != ERROR_SUCCESS) {
        hr = HRESULT_FROM_WIN32(winErr);
        goto cleanup;
    }
    hr = S_OK;

cleanup:
    if (newDacl != NULL) LocalFree(newDacl);
    if (sd != NULL) LocalFree(sd);
    if (ea != NULL) LocalFree(ea);
    return hr;
}

/*
 * grant_acl_recursive -- grant READ+EXECUTE on a directory and every file /
 * subdirectory beneath it.
 *
 * FindFirstFileW / FindNextFileW walk; "." and ".." are skipped; subdirs are
 * recursed into. Long paths (>= MAX_PATH) are handled by prefixing the
 * search/find paths with "\\?\" when they are absolute — the staged copy dir
 * is always an absolute per-session path, so the prefix is applied
 * unconditionally to the walk but NOT to the path handed to
 * GetNamedSecurityInfoW/SetNamedSecurityInfoW (which accept long paths
 * natively on Win10).
 *
 * A failure on ANY entry aborts the walk with a failure HRESULT (fail-closed
 * — a partially-granted copy dir must not look like success).
 */
static HRESULT grant_acl_recursive(PCWSTR dir, PSID *sids, DWORD sidCount,
                                   int depth) {
    WCHAR searchPath[MAX_PATH * 2];
    WCHAR childPath[MAX_PATH * 2];
    WIN32_FIND_DATAW fd;
    HANDLE hFind = INVALID_HANDLE_VALUE;
    HRESULT hr = S_OK;
    DWORD err;

    /* Defensive recursion cap — the staged copy tree is shallow; 64 levels
     * is generous and prevents a pathological symlink/junction loop.
     * ERROR_STACK_OVERFLOW (1001L) is the closest real Win32 code for a
     * recursion cap. */
    if (depth > 64) {
        return HRESULT_FROM_WIN32(ERROR_STACK_OVERFLOW);
    }

    if (swprintf_s(searchPath, ARRAYSIZE(searchPath),
                   L"\\\\?\\%s\\*", dir) < 0) {
        return E_UNEXPECTED;
    }

    hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) {
        err = GetLastError();
        if (err == ERROR_FILE_NOT_FOUND) {
            /* Empty dir — nothing to grant on but the dir itself. */
            return S_OK;
        }
        return HRESULT_FROM_WIN32(err);
    }

    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) {
            continue;
        }
        if (swprintf_s(childPath, ARRAYSIZE(childPath),
                       L"%s\\%s", dir, fd.cFileName) < 0) {
            hr = E_UNEXPECTED;
            break;
        }
        {
            BOOL childIsDir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            hr = grant_read_execute_on_path(childPath, childIsDir, sids, sidCount);
            if (FAILED(hr)) break;
            if (childIsDir) {
                hr = grant_acl_recursive(childPath, sids, sidCount, depth + 1);
                if (FAILED(hr)) break;
            }
        }
    } while (FindNextFileW(hFind, &fd));

    if (hFind != INVALID_HANDLE_VALUE) {
        FindClose(hFind);
    }
    /* Distinguish a loop that ended cleanly from one that broke on error. */
    if (SUCCEEDED(hr)) {
        err = GetLastError();
        if (err != ERROR_NO_MORE_FILES) {
            hr = HRESULT_FROM_WIN32(err);
        }
    }
    return hr;
}

static void usage_grant_acl(void) {
    fwprintf(stderr,
        L"octopus-sandbox-helper: usage:\n"
        L"  octopus-sandbox-helper.exe grant-acl --pkg <moniker> --path <dir>\n");
}

/*
 * cmd_grant_acl -- grant the package's LPAC SIDs READ+EXECUTE on the staged
 * copy dir, recursively. Exit 0 on success; non-zero on any failure.
 */
static int cmd_grant_acl(int argc, wchar_t **argv, int startIdx) {
    PCWSTR pkg = NULL;
    PCWSTR path = NULL;
    PSID *sids = NULL;
    DWORD sidCount = 0;
    HRESULT hr;
    int i;
    DWORD si;
    DWORD attrs;

    for (i = startIdx; i < argc; i++) {
        if (i + 1 >= argc) { usage_grant_acl(); return 2; }
        if (wcscmp(argv[i], L"--pkg") == 0) {
            pkg = argv[++i];
        } else if (wcscmp(argv[i], L"--path") == 0) {
            path = argv[++i];
        } else {
            usage_grant_acl();
            return 2;
        }
    }
    if (pkg == NULL || path == NULL) {
        usage_grant_acl();
        return 2;
    }

    /* The target must exist and be a directory — granting on a non-existent
     * or non-directory path is a usage error, fail-closed. */
    attrs = GetFileAttributesW(path);
    if (attrs == INVALID_FILE_ATTRIBUTES) {
        return fail_win32(L"grant-acl GetFileAttributesW", GetLastError());
    }
    if ((attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        fwprintf(stderr, L"octopus-sandbox-helper: grant-acl path is not a directory\n");
        return 1;
    }

    hr = collect_lpac_sids(pkg, &sids, &sidCount);
    if (FAILED(hr)) {
        return fail_hr(L"grant-acl collect_lpac_sids", hr);
    }

    /* DIAGNOSTIC (run 5, SID-match): print every SID about to be granted, as
     * a string, so it can be compared against the "[run] token ..." lines the
     * launch emits. The LPAC access check intersects user/group SIDs with
     * AppContainer SIDs, so the granted set MUST contain a SID the token
     * actually presents (the package/AppContainer SID or a capability SID). */
    for (si = 0; si < sidCount; si++) {
        LPWSTR sidStr = NULL;
        if (sids[si] != NULL && ConvertSidToStringSidW(sids[si], &sidStr)) {
            fwprintf(stderr, L"[grant] sid[%lu]=%ls\n", (unsigned long)si, sidStr);
            LocalFree(sidStr);
        }
    }
    fflush(stderr);

    /* Grant on the root dir itself, then recurse into children. */
    hr = grant_read_execute_on_path(path, TRUE, sids, sidCount);
    if (SUCCEEDED(hr)) {
        hr = grant_acl_recursive(path, sids, sidCount, 0);
    }

    for (si = 0; si < sidCount; si++) {
        if (sids[si] != NULL) LocalFree(sids[si]);
    }
    LocalFree(sids);

    if (FAILED(hr)) {
        return fail_hr(L"grant-acl", hr);
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Subcommand: teardown                                                */
/* ------------------------------------------------------------------ */

/* How long to wait for the Job's active-process count to reach 0 after
 * TerminateJobObject, and the poll interval. TerminateJobObject is
 * asynchronous in that already-running threads take a moment to unwind; the
 * process count typically drops to 0 within a few milliseconds. 5 s is a
 * generous upper bound for a single Node child; if it is still non-zero
 * after that, something is genuinely stuck and teardown must fail closed. */
#define OCT_TEARDOWN_TIMEOUT_MS 5000
#define OCT_TEARDOWN_POLL_MS    50

/*
 * delete_tree_recursive -- recursively delete a directory and its contents.
 *
 * FindFirstFileW / FindNextFileW walk; "." / ".." skipped; files deleted
 * with DeleteFileW, subdirs recursed into then removed with RemoveDirectoryW
 * (bottom-up, so a directory is empty before it is removed). Read-only
 * attributes are cleared before DeleteFileW / RemoveDirectoryW because both
 * fail on read-only entries. The root dir itself is removed last.
 *
 * Fail-closed: a failure on any entry aborts and returns a failure HRESULT,
 * leaving whatever could not be deleted in place.
 */
static HRESULT delete_tree_recursive(PCWSTR dir, int depth) {
    WCHAR searchPath[MAX_PATH * 2];
    WCHAR childPath[MAX_PATH * 2];
    WIN32_FIND_DATAW fd;
    HANDLE hFind = INVALID_HANDLE_VALUE;
    HRESULT hr = S_OK;
    DWORD err;

    /* Recursion cap (see grant_acl_recursive); ERROR_STACK_OVERFLOW (1001L)
     * is the closest real Win32 code for a recursion cap. */
    if (depth > 64) {
        return HRESULT_FROM_WIN32(ERROR_STACK_OVERFLOW);
    }

    if (swprintf_s(searchPath, ARRAYSIZE(searchPath),
                   L"\\\\?\\%s\\*", dir) < 0) {
        return E_UNEXPECTED;
    }

    hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) {
        err = GetLastError();
        if (err == ERROR_FILE_NOT_FOUND) {
            /* Already empty; just remove the dir itself below. */
        } else {
            return HRESULT_FROM_WIN32(err);
        }
    }

    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) {
                continue;
            }
            if (swprintf_s(childPath, ARRAYSIZE(childPath),
                           L"%s\\%s", dir, fd.cFileName) < 0) {
                hr = E_UNEXPECTED;
                break;
            }
            {
                BOOL childIsDir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                /* Clear read-only so delete/remove does not fail on it. */
                if ((fd.dwFileAttributes & FILE_ATTRIBUTE_READONLY) != 0) {
                    (void)SetFileAttributesW(childPath,
                        fd.dwFileAttributes & ~FILE_ATTRIBUTE_READONLY);
                }
                if (childIsDir) {
                    hr = delete_tree_recursive(childPath, depth + 1);
                    if (FAILED(hr)) break;
                } else {
                    if (!DeleteFileW(childPath)) {
                        hr = HRESULT_FROM_WIN32(GetLastError());
                        break;
                    }
                }
            }
        } while (FindNextFileW(hFind, &fd));

        FindClose(hFind);
        if (SUCCEEDED(hr)) {
            err = GetLastError();
            if (err != ERROR_NO_MORE_FILES) {
                hr = HRESULT_FROM_WIN32(err);
            }
        }
        if (FAILED(hr)) return hr;
    }

    /* The directory is now empty (or was already). Remove it. Clear its own
     * read-only bit first. */
    {
        DWORD dirAttrs = GetFileAttributesW(dir);
        if (dirAttrs != INVALID_FILE_ATTRIBUTES &&
            (dirAttrs & FILE_ATTRIBUTE_READONLY) != 0) {
            (void)SetFileAttributesW(dir, dirAttrs & ~FILE_ATTRIBUTE_READONLY);
        }
    }
    if (!RemoveDirectoryW(dir)) {
        return HRESULT_FROM_WIN32(GetLastError());
    }
    return S_OK;
}

static void usage_teardown(void) {
    fwprintf(stderr,
        L"octopus-sandbox-helper: usage:\n"
        L"  octopus-sandbox-helper.exe teardown --job <name> --pkg <moniker>\n"
        L"      --copydir <dir>\n");
}

/*
 * cmd_teardown -- kill the named Job's process tree, confirm it is dead,
 * then delete the AppContainer profile and the staged copy dir.
 *
 * FAIL-CLOSED INVARIANT (security-critical): if the Job cannot be confirmed
 * dead (OpenJobObjectW fails for a reason OTHER than not-found, or the
 * active-process count does not reach 0 within the timeout), this exits
 * NON-ZERO and LEAVES the profile + copy dir in place. That leftover state
 * is what lets the Task 9 companion service keep the WFP gate closed — a
 * live or unconfirmed-dead skill must never have its gate-related state
 * deleted out from under the service. The copy dir and profile are deleted
 * ONLY after confirmed Job death.
 *
 * Job-death determination:
 *   - OpenJobObjectW returns ERROR_FILE_NOT_FOUND -> the Job is already gone
 *     -> already dead, proceed (this is the crash-safe path where a prior
 *     helper died and the Job was cleaned up by KILL_ON_JOB_CLOSE).
 *   - Otherwise TerminateJobObject, then poll BasicAccountingInfo
 *     .ActiveProcesses until 0 or the bounded timeout.
 *   - Still non-zero after the timeout -> FAIL, leave state, exit non-zero.
 */
static int cmd_teardown(int argc, wchar_t **argv, int startIdx) {
    PCWSTR job = NULL;
    PCWSTR pkg = NULL;
    PCWSTR copydir = NULL;
    HANDLE hJob = NULL;
    HRESULT hr = S_OK;
    DWORD err;
    BOOL jobConfirmedDead = FALSE;
    int i;

    for (i = startIdx; i < argc; i++) {
        if (i + 1 >= argc) { usage_teardown(); return 2; }
        if (wcscmp(argv[i], L"--job") == 0) {
            job = argv[++i];
        } else if (wcscmp(argv[i], L"--pkg") == 0) {
            pkg = argv[++i];
        } else if (wcscmp(argv[i], L"--copydir") == 0) {
            copydir = argv[++i];
        } else {
            usage_teardown();
            return 2;
        }
    }
    if (job == NULL || pkg == NULL || copydir == NULL) {
        usage_teardown();
        return 2;
    }

    /* ---- confirm Job death ------------------------------------------- */

    hJob = OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY,
                          FALSE /* bInheritHandle */, job);
    if (hJob == NULL) {
        err = GetLastError();
        if (err == ERROR_FILE_NOT_FOUND) {
            /* Job already gone -> already dead. Proceed. */
            jobConfirmedDead = TRUE;
        } else {
            /* Cannot even open the Job to check it. Fail closed: we do NOT
             * know the skill is dead, so we must NOT delete state. */
            return fail_win32(L"teardown OpenJobObjectW", err);
        }
    } else {
        if (!TerminateJobObject(hJob, 1)) {
            err = GetLastError();
            /* Terminate failed — Job death unconfirmed. Fail closed. */
            CloseHandle(hJob);
            return fail_win32(L"teardown TerminateJobObject", err);
        }

        /* Poll until ActiveProcesses hits 0 or the timeout expires. */
        {
            DWORD waited = 0;
            for (;;) {
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
                DWORD retLen = 0;
                ZeroMemory(&acct, sizeof(acct));
                if (!QueryInformationJobObject(hJob,
                        JobObjectBasicAccountingInformation,
                        &acct, sizeof(acct), &retLen)) {
                    err = GetLastError();
                    CloseHandle(hJob);
                    /* Cannot confirm death -> fail closed. */
                    return fail_win32(L"teardown QueryInformationJobObject", err);
                }
                if (acct.ActiveProcesses == 0) {
                    jobConfirmedDead = TRUE;
                    break;
                }
                if (waited >= OCT_TEARDOWN_TIMEOUT_MS) {
                    break; /* timed out, still alive */
                }
                Sleep(OCT_TEARDOWN_POLL_MS);
                waited += OCT_TEARDOWN_POLL_MS;
            }
        }
        CloseHandle(hJob);
        hJob = NULL;
    }

    /* ---- fail closed if death is unconfirmed ------------------------- */
    if (!jobConfirmedDead) {
        fwprintf(stderr,
            L"octopus-sandbox-helper: teardown could NOT confirm Job '%ls' dead "
            L"within %lu ms -- leaving profile and copy dir in place so the "
            L"companion service keeps the egress gate closed\n",
            job, (unsigned long)OCT_TEARDOWN_TIMEOUT_MS);
        return 1;
    }

    /* ---- confirmed dead: delete profile + copy dir ------------------- */

    /* DeleteAppContainerProfile on a possibly-already-deleted profile
     * returns S_OK (deleting a non-existent profile is a success), so this
     * is idempotent. A genuine failure is fail-closed but does NOT resurrect
     * the gate concern (the Job is already dead) — still report non-zero. */
    hr = DeleteAppContainerProfile(pkg);
    if (FAILED(hr)) {
        return fail_hr(L"teardown DeleteAppContainerProfile", hr);
    }

    /* Delete the copy dir wholesale. If it does not exist (already cleaned
     * by a prior teardown), treat as success — teardown is idempotent. */
    {
        DWORD attrs = GetFileAttributesW(copydir);
        if (attrs == INVALID_FILE_ATTRIBUTES) {
            DWORD gerr = GetLastError();
            if (gerr == ERROR_FILE_NOT_FOUND || gerr == ERROR_PATH_NOT_FOUND) {
                return 0; /* already gone; profile deleted above */
            }
            return fail_win32(L"teardown GetFileAttributesW(copydir)", gerr);
        }
        if ((attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
            fwprintf(stderr,
                L"octopus-sandbox-helper: teardown copydir is not a directory\n");
            return 1;
        }
    }
    hr = delete_tree_recursive(copydir, 0);
    if (FAILED(hr)) {
        return fail_hr(L"teardown delete copy dir", hr);
    }

    return 0;
}

/* ==================================================================
 * RUN-10 DIAGNOSTIC: cmd_diag_launch -- pinpoint the ACCESS_DENIED.
 *
 * Run-8/run-9 CI: the Option-3 restricted token builds cleanly ("[run]
 * restricted token built") but CreateProcessWithTokenW returns
 * ERROR_ACCESS_DENIED (hr=0x80070005) on the windows-latest runner, for
 * BOTH logon flags (LOGON_WITH_PROFILE run-8, LOGON_NETCREDENTIALS_ONLY
 * run-9). So the denial is NOT (only) the profile load. This subcommand
 * decomposes the remaining access checks in ONE CI run.
 *
 * Impersonation probes -- the production-form restricted token is
 * impersonated on the helper's own thread (plus the helper's own identity
 * as baseline) and attempts the three objects a CreateProcess access check
 * can touch:
 *   P1  CreateFileW(node.exe, GENERIC_READ|GENERIC_EXECUTE)  -- image DACL
 *   P2  OpenWindowStationW(L"WinSta0", MAXIMUM_ALLOWED)      -- winsta
 *   P3  OpenDesktopW(L"Default", MAXIMUM_ALLOWED)            -- desktop
 *
 * Launch battery -- each arm builds its own token, launches node
 * CREATE_SUSPENDED with `-e "process.exit(0)"`, then terminates the child
 * immediately (no user code ever runs, no Job is involved -- this isolates
 * the launch access check itself):
 *   G  plain duplicate (no restriction at all)     NETCRED + NO_WINDOW
 *   A  production form (Low + admins deny-only)    NETCRED            (run-9 repro)
 *   B  production form                             NETCRED + NO_WINDOW  (run-10 fix?)
 *   C  production form                             WITH_PROFILE + NO_WINDOW
 *   D  restricted but Medium integrity (no Low)    NETCRED + NO_WINDOW
 *   E  Low integrity but admins NOT deny-only      NETCRED + NO_WINDOW
 *
 * Interpretation key:
 *   G fails too          -> the denial is NOT the restriction: it is the
 *                           session / winsta / CreateProcessWithTokenW
 *                           itself on this runner (escalate: service context
 *                           or explicit desktop).
 *   G ok, A/B fail       -> some hardening denies; D vs B isolates the
 *                           integrity label, E vs B isolates admins-deny-only.
 *   B ok                 -> CREATE_NO_WINDOW is the production fix (arm A is
 *                           the failing without-control in the same run).
 *
 * Output: "[diag] ..." lines on stderr. Exit 0 once the battery ran to
 * completion -- launch failures are DATA here, not failures. Exit 1 on a
 * structural error (baseline token cannot even be built), 2 on usage.
 * Diagnostic-only: never wired to the production launch path.
 *
 * RUN-10 RESULT (CI 31359232747): G plain-duplicate OK; A/B/C/E FAIL;
 * D (Medium integrity, admins deny-only) OK -> the LOW-INTEGRITY LABEL is
 * the denying factor, not admins-deny-only, not the winsta/desktop (P2/P3
 * OK for every identity), and the Low token cannot even open node.exe for
 * READ|EXECUTE (P1 err=5) while the helper identity can. Run-11 extends
 * this battery with the label experiment: stage a private copy of node.exe
 * in the temp dir, probe+launch it unlabeled (arm H), then relabel it to
 * Low integrity (NO_WRITE_UP) and probe+launch again (arm F). If F passes,
 * the production remedy is to launch node from a Low-labeled sandbox-private
 * copy, which the trusted-closure design already implies.
 * ============================================================== */

#define OCT_DIAG_PATH_MAX    1024
#define OCT_DIAG_CMDLINE_MAX 2048

/* Build one battery token. Flags: applyRestrict=0 returns a plain duplicate
 * of our own token (the G baseline, no CreateRestrictedToken);
 * applyRestrict=1 applies DISABLE_MAX_PRIVILEGE (+ optional admins deny-only
 * + optional Low integrity). impersonationForm=1 returns an
 * impersonation-level duplicate (for SetThreadToken) instead of the primary.
 * Fail-closed: any step's failure frees everything and returns the HRESULT.
 * (The parameter is named applyRestrict, not restrict: `restrict` is a
 * reserved keyword under /std:c17.) */
static HRESULT diag_make_token(int applyRestrict, int lowIntegrity, int denyAdmins,
                               int impersonationForm, HANDLE *outToken) {
    HANDLE hToken = NULL;
    HANDLE hPrimary = NULL;
    HANDLE hRestricted = NULL;
    HANDLE hFinal = NULL;
    PSID pAdminSid = NULL;
    PSID pLowSid = NULL;
    SID_AND_ATTRIBUTES disableSids[1];
    DWORD disableSidCount = 0;
    TOKEN_MANDATORY_LABEL tml;
    DWORD adminSidSize = 0;
    HRESULT hr = S_OK;

    if (!OpenProcessToken(GetCurrentProcess(),
                          TOKEN_DUPLICATE | TOKEN_QUERY, &hToken)) {
        hr = HRESULT_FROM_WIN32(GetLastError());
        goto done;
    }
    if (!DuplicateTokenEx(hToken, TOKEN_ALL_ACCESS, NULL,
                          SecurityImpersonation, TokenPrimary, &hPrimary)) {
        hr = HRESULT_FROM_WIN32(GetLastError());
        goto done;
    }

    if (!applyRestrict) {
        /* G baseline: an unrestricted copy of our own token. */
        if (impersonationForm) {
            if (!DuplicateTokenEx(hPrimary, TOKEN_ALL_ACCESS, NULL,
                                  SecurityImpersonation, TokenImpersonation,
                                  &hFinal)) {
                hr = HRESULT_FROM_WIN32(GetLastError());
                goto done;
            }
        } else {
            hFinal = hPrimary;
            hPrimary = NULL;
        }
        *outToken = hFinal;
        goto done;
    }

    if (denyAdmins) {
        adminSidSize = (DWORD)SECURITY_MAX_SID_SIZE;
        pAdminSid = (PSID)LocalAlloc(LMEM_FIXED, adminSidSize);
        if (pAdminSid == NULL) { hr = E_OUTOFMEMORY; goto done; }
        if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL,
                                pAdminSid, &adminSidSize)) {
            hr = HRESULT_FROM_WIN32(GetLastError());
            goto done;
        }
        disableSids[0].Sid = pAdminSid;
        disableSids[0].Attributes = 0; /* deny-only */
        disableSidCount = 1;
    }

    if (!CreateRestrictedToken(hPrimary, DISABLE_MAX_PRIVILEGE,
                               disableSidCount, disableSids,
                               0, NULL, 0, NULL, &hRestricted)) {
        hr = HRESULT_FROM_WIN32(GetLastError());
        goto done;
    }

    if (lowIntegrity) {
        if (!ConvertStringSidToSidW(L"S-1-16-4096", &pLowSid)) {
            hr = HRESULT_FROM_WIN32(GetLastError());
            goto done;
        }
        ZeroMemory(&tml, sizeof(tml));
        tml.Label.Sid = pLowSid;
        tml.Label.Attributes = SE_GROUP_INTEGRITY;
        if (!SetTokenInformation(hRestricted, TokenIntegrityLevel,
                                 &tml, (DWORD)sizeof(tml))) {
            hr = HRESULT_FROM_WIN32(GetLastError());
            goto done;
        }
    }

    if (impersonationForm) {
        if (!DuplicateTokenEx(hRestricted, TOKEN_ALL_ACCESS, NULL,
                              SecurityImpersonation, TokenImpersonation,
                              &hFinal)) {
            hr = HRESULT_FROM_WIN32(GetLastError());
            goto done;
        }
    } else {
        hFinal = hRestricted;
        hRestricted = NULL;
    }
    *outToken = hFinal;

done:
    if (hToken) CloseHandle(hToken);
    if (hPrimary) CloseHandle(hPrimary);
    if (hRestricted) CloseHandle(hRestricted);
    if (FAILED(hr) && hFinal) CloseHandle(hFinal);
    if (pAdminSid) LocalFree(pAdminSid);
    if (pLowSid) LocalFree(pLowSid);
    return hr;
}

/* The three access-check probes under ONE identity (who labels the output:
 * either the helper's own identity or an impersonated restricted token).
 * P1a/P1b split the image open: read-only vs read+execute — run-10 showed
 * the Low token fails P1b; the split localizes which access bits deny. */
static void diag_probe_as(const WCHAR *who, const WCHAR *nodePath) {
    HANDLE hFile = INVALID_HANDLE_VALUE;
    HWINSTA hWinsta = NULL;
    HDESK hDesktop = NULL;
    DWORD err = 0;

    hFile = CreateFileW(nodePath, GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile != INVALID_HANDLE_VALUE) {
        fwprintf(stderr, L"[diag] %ls P1a image read-only: OK\n", who);
        CloseHandle(hFile);
    } else {
        err = GetLastError();
        fwprintf(stderr, L"[diag] %ls P1a image read-only: FAIL err=%lu\n",
                 who, (unsigned long)err);
    }

    hFile = CreateFileW(nodePath, GENERIC_READ | GENERIC_EXECUTE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile != INVALID_HANDLE_VALUE) {
        fwprintf(stderr, L"[diag] %ls P1b image read+exec: OK\n", who);
        CloseHandle(hFile);
    } else {
        err = GetLastError();
        fwprintf(stderr, L"[diag] %ls P1b image read+exec: FAIL err=%lu\n",
                 who, (unsigned long)err);
    }

    hWinsta = OpenWindowStationW(L"WinSta0", FALSE, MAXIMUM_ALLOWED);
    if (hWinsta != NULL) {
        fwprintf(stderr, L"[diag] %ls P2 OpenWindowStationW(WinSta0): OK\n", who);
        CloseWindowStation(hWinsta);
    } else {
        err = GetLastError();
        fwprintf(stderr, L"[diag] %ls P2 OpenWindowStationW(WinSta0): FAIL err=%lu\n",
                 who, (unsigned long)err);
    }

    hDesktop = OpenDesktopW(L"Default", 0, FALSE, MAXIMUM_ALLOWED);
    if (hDesktop != NULL) {
        fwprintf(stderr, L"[diag] %ls P3 OpenDesktopW(Default): OK\n", who);
        CloseDesktop(hDesktop);
    } else {
        err = GetLastError();
        fwprintf(stderr, L"[diag] %ls P3 OpenDesktopW(Default): FAIL err=%lu\n",
                 who, (unsigned long)err);
    }
    fflush(stderr);
}

/* One battery arm: launch node suspended under `token`, report OK/FAIL,
 * terminate immediately. No Job, no stdio relay — this isolates the
 * CreateProcessWithTokenW access check. */
static void diag_try_launch(const WCHAR *tag, HANDLE token, DWORD logonFlags,
                            DWORD extraCreateFlags, const WCHAR *nodePath) {
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    WCHAR cmdLine[OCT_DIAG_CMDLINE_MAX];
    int rc = 0;
    DWORD err = 0;

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    rc = swprintf_s(cmdLine, ARRAYSIZE(cmdLine),
                    L"\"%ls\" -e \"process.exit(0)\"", nodePath);
    if (rc < 0) {
        fwprintf(stderr, L"[diag] %ls: cmdline build failed\n", tag);
        fflush(stderr);
        return;
    }

    if (CreateProcessWithTokenW(token, logonFlags, NULL, cmdLine,
                                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                                extraCreateFlags,
                                NULL,   /* inherit caller environment */
                                NULL,   /* inherit cwd */
                                &si, &pi)) {
        fwprintf(stderr, L"[diag] %ls: OK pid=%lu\n", tag,
                 (unsigned long)pi.dwProcessId);
        TerminateProcess(pi.hProcess, 99);
        WaitForSingleObject(pi.hProcess, 3000);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    } else {
        err = GetLastError();
        fwprintf(stderr, L"[diag] %ls: FAIL hr=0x%08lx (err=%lu)\n", tag,
                 (unsigned long)HRESULT_FROM_WIN32(err), (unsigned long)err);
    }
    fflush(stderr);
}

static void diag_run_battery(const WCHAR *nodePath) {
    HANDLE t = NULL;
    HRESULT hr = S_OK;

    /* G -- baseline: plain duplicate, no restriction at all. */
    hr = diag_make_token(0, 0, 0, 0, &t);
    if (SUCCEEDED(hr)) {
        diag_try_launch(L"G plain-duplicate NETCRED+NO_WINDOW", t,
                        LOGON_NETCREDENTIALS_ONLY, CREATE_NO_WINDOW, nodePath);
        CloseHandle(t);
    } else {
        fwprintf(stderr, L"[diag] G token build failed hr=0x%08lx\n", (unsigned long)hr);
    }

    /* A/B/C -- the exact production token form, three launch shapes. */
    hr = diag_make_token(1, 1, 1, 0, &t);
    if (SUCCEEDED(hr)) {
        diag_try_launch(L"A low+denyadmins NETCRED (run-9 repro)", t,
                        LOGON_NETCREDENTIALS_ONLY, 0, nodePath);
        diag_try_launch(L"B low+denyadmins NETCRED+NO_WINDOW", t,
                        LOGON_NETCREDENTIALS_ONLY, CREATE_NO_WINDOW, nodePath);
        diag_try_launch(L"C low+denyadmins WITH_PROFILE+NO_WINDOW", t,
                        LOGON_WITH_PROFILE, CREATE_NO_WINDOW, nodePath);
        CloseHandle(t);
    } else {
        fwprintf(stderr, L"[diag] A/B/C token build failed hr=0x%08lx\n", (unsigned long)hr);
    }

    /* D -- same restriction but NO Low-integrity lowering. */
    hr = diag_make_token(1, 0, 1, 0, &t);
    if (SUCCEEDED(hr)) {
        diag_try_launch(L"D medium+denyadmins NETCRED+NO_WINDOW", t,
                        LOGON_NETCREDENTIALS_ONLY, CREATE_NO_WINDOW, nodePath);
        CloseHandle(t);
    } else {
        fwprintf(stderr, L"[diag] D token build failed hr=0x%08lx\n", (unsigned long)hr);
    }

    /* E -- Low integrity but admins NOT deny-only. */
    hr = diag_make_token(1, 1, 0, 0, &t);
    if (SUCCEEDED(hr)) {
        diag_try_launch(L"E low-only NETCRED+NO_WINDOW", t,
                        LOGON_NETCREDENTIALS_ONLY, CREATE_NO_WINDOW, nodePath);
        CloseHandle(t);
    } else {
        fwprintf(stderr, L"[diag] E token build failed hr=0x%08lx\n", (unsigned long)hr);
    }
    fflush(stderr);
}

/* Print the file's explicit mandatory-integrity label (SID + policy mask),
 * or NO_EXPLICIT_LABEL when the SACL carries none (unlabeled objects behave
 * as Medium). LABEL_SECURITY_INFORMATION reads are permitted without
 * SeSecurityPrivilege; the helper is admin regardless. */
static void diag_print_file_label(const WCHAR *path) {
    PSECURITY_DESCRIPTOR psd = NULL;
    PACL psacl = NULL;
    BOOL saclPresent = FALSE;
    BOOL saclDefaulted = FALSE;
    DWORD err = 0;
    DWORD i = 0;
    int found = 0;

    err = GetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                                LABEL_SECURITY_INFORMATION,
                                NULL, NULL, NULL, &psacl, &psd);
    if (err != ERROR_SUCCESS || psd == NULL) {
        fwprintf(stderr, L"[diag] label query %ls: FAIL err=%lu\n",
                 path, (unsigned long)err);
        return;
    }
    if (!GetSecurityDescriptorSacl(psd, &saclPresent, &psacl, &saclDefaulted)
        || !saclPresent || psacl == NULL) {
        fwprintf(stderr, L"[diag] label %ls: NO_EXPLICIT_LABEL\n", path);
        LocalFree(psd);
        return;
    }
    for (i = 0; i < psacl->AceCount; i++) {
        LPVOID pace = NULL;
        SYSTEM_MANDATORY_LABEL_ACE *pmla = NULL;
        WCHAR *sidStr = NULL;
        if (!GetAce(psacl, i, &pace)) continue;
        if (((PACE_HEADER)pace)->AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE) continue;
        pmla = (SYSTEM_MANDATORY_LABEL_ACE *)pace;
        if (ConvertSidToStringSidW((PSID)&pmla->SidStart, &sidStr)) {
            fwprintf(stderr, L"[diag] label %ls: %ls policy=0x%lx\n",
                     path, sidStr, (unsigned long)pmla->Mask);
            LocalFree(sidStr);
        }
        found = 1;
    }
    if (!found) {
        fwprintf(stderr, L"[diag] label %ls: SACL without mandatory ACE\n", path);
    }
    LocalFree(psd);
}

/* Set the file's mandatory label to Low (S-1-16-4096) with the standard
 * NO_WRITE_UP policy. Returns ERROR_SUCCESS or the failing error code. */
static DWORD diag_set_low_label(const WCHAR *path) {
    BYTE aclBuf[256];
    PACL pacl = (PACL)aclBuf;
    PSID pLowSid = NULL;
    DWORD err = ERROR_SUCCESS;

    if (!ConvertStringSidToSidW(L"S-1-16-4096", &pLowSid)) {
        return GetLastError();
    }
    if (!InitializeAcl(pacl, (DWORD)sizeof(aclBuf), ACL_REVISION)) {
        err = GetLastError();
        LocalFree(pLowSid);
        return err;
    }
    if (!AddMandatoryAce(pacl, ACL_REVISION, 0,
                         SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, pLowSid)) {
        err = GetLastError();
        LocalFree(pLowSid);
        return err;
    }
    err = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                LABEL_SECURITY_INFORMATION,
                                NULL, NULL, NULL, pacl);
    LocalFree(pLowSid);
    return err;
}

/* RUN-11 label experiment. Run-10 proved the Low-integrity label is the
 * denying factor and that the Low token cannot even open the hostedtoolcache
 * node.exe for read+execute. This stages a private copy in the temp dir and
 * tests whether a Low-labeled copy unblocks the Low token:
 *   - probe the unlabeled copy under the Low token,
 *   - arm H: launch from the unlabeled copy,
 *   - relabel the copy Low (NO_WRITE_UP), probe again,
 *   - arm F: launch from the Low-labeled copy.
 * The copy is deleted afterwards; a crash cannot leak it (the lane is
 * ephemeral). */
static void diag_run_label_battery(const WCHAR *nodePath) {
    WCHAR tmpDir[MAX_PATH];
    WCHAR copyPath[OCT_DIAG_PATH_MAX];
    HANDLE hImp = NULL;
    HANDLE t = NULL;
    HRESULT hr = S_OK;
    DWORD err = 0;
    DWORD n = 0;

    n = GetTempPathW(ARRAYSIZE(tmpDir), tmpDir);
    if (n == 0 || n >= ARRAYSIZE(tmpDir)) {
        fwprintf(stderr, L"[diag] GetTempPathW failed err=%lu\n",
                 (unsigned long)GetLastError());
        return;
    }
    if (swprintf_s(copyPath, ARRAYSIZE(copyPath), L"%lsoct-diag-node-%lu.exe",
                   tmpDir, (unsigned long)GetCurrentProcessId()) < 0) {
        fwprintf(stderr, L"[diag] copy path build failed\n");
        return;
    }
    if (!CopyFileW(nodePath, copyPath, FALSE)) {
        fwprintf(stderr, L"[diag] CopyFileW failed err=%lu\n",
                 (unsigned long)GetLastError());
        return;
    }
    fwprintf(stderr, L"[diag] staged copy %ls\n", copyPath);
    diag_print_file_label(copyPath);

    /* Probe the UNLABELED copy under the Low restricted token. */
    hr = diag_make_token(1, 1, 1, 1, &hImp);
    if (SUCCEEDED(hr)) {
        if (SetThreadToken(NULL, hImp)) {
            diag_probe_as(L"restricted-low vs UNLABELED-copy", copyPath);
            RevertToSelf();
        }
        CloseHandle(hImp);
    } else {
        fwprintf(stderr, L"[diag] label-battery impersonation token failed hr=0x%08lx\n",
                 (unsigned long)hr);
    }

    /* H: launch from the unlabeled copy under the Low primary token. */
    hr = diag_make_token(1, 1, 1, 0, &t);
    if (SUCCEEDED(hr)) {
        diag_try_launch(L"H low+denyadmins UNLABELED-copy NETCRED+NO_WINDOW", t,
                        LOGON_NETCREDENTIALS_ONLY, CREATE_NO_WINDOW, copyPath);
        CloseHandle(t);
    }

    /* Relabel the copy Low + NO_WRITE_UP and verify. */
    err = diag_set_low_label(copyPath);
    if (err == ERROR_SUCCESS) {
        fwprintf(stderr, L"[diag] copy relabeled to Low\n");
    } else {
        fwprintf(stderr, L"[diag] copy relabel FAILED err=%lu\n", (unsigned long)err);
    }
    diag_print_file_label(copyPath);

    /* Probe + arm F: the LOW-labeled copy under the Low restricted token. */
    hr = diag_make_token(1, 1, 1, 1, &hImp);
    if (SUCCEEDED(hr)) {
        if (SetThreadToken(NULL, hImp)) {
            diag_probe_as(L"restricted-low vs LOW-labeled-copy", copyPath);
            RevertToSelf();
        }
        CloseHandle(hImp);
    }
    hr = diag_make_token(1, 1, 1, 0, &t);
    if (SUCCEEDED(hr)) {
        diag_try_launch(L"F low+denyadmins LOW-labeled-copy NETCRED+NO_WINDOW", t,
                        LOGON_NETCREDENTIALS_ONLY, CREATE_NO_WINDOW, copyPath);
        CloseHandle(t);
    }

    DeleteFileW(copyPath);
    fflush(stderr);
}

static int cmd_diag_launch(int argc, wchar_t **argv, int startIdx) {
    WCHAR nodePath[OCT_DIAG_PATH_MAX];
    HANDLE hProdImp = NULL;
    HANDLE hMedImp = NULL;
    HRESULT hr = S_OK;
    DWORD sessionId = 0;
    int i = 0;

    nodePath[0] = L'\0';
    for (i = startIdx; i < argc; i++) {
        if (wcscmp(argv[i], L"--node") == 0 && i + 1 < argc) {
            wcsncpy_s(nodePath, ARRAYSIZE(nodePath), argv[i + 1], _TRUNCATE);
            i++;
        }
    }
    if (nodePath[0] == L'\0') {
        fwprintf(stderr,
            L"octopus-sandbox-helper: diag-launch requires --node <path>\n");
        return 2;
    }

    if (!ProcessIdToSessionId(GetCurrentProcessId(), &sessionId)) {
        sessionId = 0xFFFFFFFFUL;
    }
    fwprintf(stderr, L"[diag] battery start node=%ls sessionId=%lu\n",
             nodePath, (unsigned long)sessionId);
    diag_print_file_label(nodePath);
    fflush(stderr);

    /* Baseline probes under the helper's own identity. */
    diag_probe_as(L"baseline(helper-identity)", nodePath);

    /* Probes under a Medium-integrity restricted token (admins deny-only,
     * NO Low label). Run-10 arm D launched fine at Medium, so these probes
     * are expected OK — the control for the Low-integrity gradient. */
    hr = diag_make_token(1, 0, 1, 1, &hMedImp);
    if (SUCCEEDED(hr)) {
        if (SetThreadToken(NULL, hMedImp)) {
            diag_probe_as(L"restricted(medium+denyadmins-impersonated)", nodePath);
            RevertToSelf();
        } else {
            fwprintf(stderr, L"[diag] SetThreadToken(medium) failed err=%lu\n",
                     (unsigned long)GetLastError());
        }
        CloseHandle(hMedImp);
    } else {
        fwprintf(stderr, L"[diag] medium impersonation-token build failed hr=0x%08lx\n",
                 (unsigned long)hr);
    }

    /* Probes under the production-form restricted token (impersonated). */
    hr = diag_make_token(1, 1, 1, 1, &hProdImp);
    if (SUCCEEDED(hr)) {
        if (SetThreadToken(NULL, hProdImp)) {
            diag_probe_as(L"restricted(low+denyadmins-impersonated)", nodePath);
            RevertToSelf();
        } else {
            fwprintf(stderr, L"[diag] SetThreadToken failed err=%lu\n",
                     (unsigned long)GetLastError());
        }
        CloseHandle(hProdImp);
    } else {
        fwprintf(stderr, L"[diag] impersonation-token build failed hr=0x%08lx\n",
                 (unsigned long)hr);
    }

    diag_run_battery(nodePath);
    diag_run_label_battery(nodePath);

    fwprintf(stderr, L"[diag] battery complete\n");
    fflush(stderr);
    return 0;
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
        L"      -- <argv...>\n"
        L"  octopus-sandbox-helper.exe grant-acl --pkg <moniker> --path <dir>\n"
        L"  octopus-sandbox-helper.exe teardown --job <name> --pkg <moniker>\n"
        L"      --copydir <dir>\n"
        L"  octopus-sandbox-helper.exe diag-launch --node <nodePath>\n");
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

    /* The minimal LPAC child launched by `run --selftest` (run-5 controlled
     * experiment). Not a user-facing subcommand; launched only as the
     * sandboxed child. */
    if (wcscmp(argv[1], L"run-probe-child") == 0) {
        /* noreturn (ExitProcess(3) inside); declared __declspec(noreturn) so
         * no trailing return is needed here — that would be C4702 under /WX. */
        cmd_run_probe_child();
    }

    if (wcscmp(argv[1], L"grant-acl") == 0) {
        return cmd_grant_acl(argc, argv, 2);
    }

    if (wcscmp(argv[1], L"teardown") == 0) {
        return cmd_teardown(argc, argv, 2);
    }

    /* RUN-10 DIAGNOSTIC: decompose the restricted-token launch
     * ACCESS_DENIED. Log-only; never used by the production launch. */
    if (wcscmp(argv[1], L"diag-launch") == 0) {
        return cmd_diag_launch(argc, argv, 2);
    }

    /* Unknown subcommand. Task 9 adds the privileged companion-service RPC
     * arm(s) here; keep this a plain if/else chain so adding them is a
     * one-line change each. */
    fwprintf(stderr, L"octopus-sandbox-helper: unknown subcommand '%ls'\n", argv[1]);
    usage();
    return 2;
}
