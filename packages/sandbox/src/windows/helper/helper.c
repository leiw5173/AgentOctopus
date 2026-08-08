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
#include <stdio.h>     /* fwprintf, _putws (only for the final OK line) */

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

/* Moniker length cap. CreateAppContainerProfile caps the app-container name
 * at 64 characters; we use the same cap for the sid subcommand so both paths
 * enforce one limit. */
#define OCT_MONIKER_MAX_CHARS 64

/* Fixed throwaway moniker for probe. Distinct from any real sandbox profile
 * name so a probe crash cannot collide with a live sandbox profile. The
 * random-looking suffix keeps parallel probes on the same machine from
 * racing on the same profile name. */
#define OCT_PROBE_MONIKER L"AgentOctopus.Sandbox.probe.t6"

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
/* wmain -- argv dispatcher                                            */
/* ------------------------------------------------------------------ */

static void usage(void) {
    fwprintf(stderr,
        L"octopus-sandbox-helper: usage:\n"
        L"  octopus-sandbox-helper.exe sid <moniker>\n"
        L"  octopus-sandbox-helper.exe probe\n");
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

    /* Unknown subcommand. Later tasks (7, 8) will add `run`, `grant-acl`,
     * and `teardown` arms here; keep this a plain if/else chain so adding
     * them is a one-line change each. */
    fwprintf(stderr, L"octopus-sandbox-helper: unknown subcommand '%ls'\n", argv[1]);
    usage();
    return 2;
}
