/*
 * helper.h -- public interface for the AgentOctopus Windows sandbox helper
 * (octopus-sandbox-helper.exe). Part of the Windows Trusted Computing Base.
 *
 * Compiled by scripts/build-win-helper.mjs with MSVC:
 *   cl.exe /nologo /c /W4 /WX /O2 /std:c17 helper.c
 *
 * The build script's linkExe() step cannot pass import libraries (a known
 * deferred constraint), so helper.c resolves its own imports via
 *   #pragma comment(lib, "...")
 * for every non-default lib it needs (userenv.lib, advapi32.lib,
 * onecoreuap.lib). kernel32.lib is implicit.
 */
#ifndef OCTOPUS_SANDBOX_HELPER_H
#define OCTOPUS_SANDBOX_HELPER_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * derive_loopback_capability_sid -- derive the LOOPBACK capability SID for a
 * package moniker.
 *
 * The moniker is the package family name / app-container name the caller
 * will later pass to CreateAppContainerProfile(). The returned string is the
 * capability SID produced by copying the moniker's PACKAGE SID
 * (S-1-15-2-...*, first sub-authority SECURITY_APP_PACKAGE_BASE_RID == 2)
 * and rewriting that first sub-authority to SECURITY_CAPABILITY_BASE_RID
 * (== 3). The result therefore always matches ^S-1-15-3-.
 *
 * Parameters:
 *   moniker  [in]  NUL-terminated package moniker (e.g. L"AgentOctopus.Sandbox").
 *   outSid   [out] receives a LocalAlloc'd, NUL-terminated SID string on
 *                  success. Caller MUST free with LocalFree(). Set to NULL
 *                  on entry; left NULL on any failure.
 *
 * Returns:
 *   S_OK on success; a failure HRESULT otherwise (from the underlying Win32
 *   call, or E_INVALIDARG / E_OUTOFMEMORY / E_UNEXPECTED as appropriate).
 */
HRESULT derive_loopback_capability_sid(PCWSTR moniker, LPWSTR *outSid);

/*
 * SANDBOX_LAUNCH_ARGS -- input bundle for launch_sandboxed().
 *
 * All string members are PCWSTR inputs owned by the CALLER (the helper does
 * not free them). They must be NUL-terminated. argv is a NULL-terminated
 * array of NUL-terminated argument strings appended after nodePath when the
 * child command line is built; it may be empty (argv[0] == NULL) but the
 * array pointer itself must be non-NULL.
 */
typedef struct SANDBOX_LAUNCH_ARGS {
    PCWSTR  jobName;      /* named Job Object to create/open */
    DWORD   memMb;        /* per-Job memory limit, in MiB (JOB_OBJECT_LIMIT_JOB_MEMORY) */
    PCWSTR  pkgMoniker;   /* package moniker for the AppContainer profile */
    PCWSTR  proxyHostPort;/* "host:port" for HTTP_PROXY / HTTPS_PROXY */
    PCWSTR  caPath;       /* path to the CA bundle for NODE_EXTRA_CA_CERTS */
    PCWSTR  bootstrapPath;/* trusted absolute path to bootstrap.cjs for NODE_OPTIONS */
    PCWSTR  nodePath;     /* trusted absolute path to the verified node.exe */
    PCWSTR *argv;         /* NULL-terminated array of child argv strings */
    /* selfTest (run-5 diagnostic): when non-zero, launch_sandboxed IGNORES
     * nodePath/argv and instead launches the helper EXE ITSELF
     * (GetModuleFileNameW) running the `run-probe-child` subcommand, under
     * the IDENTICAL LPAC token + Job. run-probe-child is a minimal native
     * child that does no V8/CRT-heavy init and ExitProcess(3)es. This is the
     * controlled experiment that isolates "LPAC+Job viability" from
     * "node.exe/V8 init under LPAC": if the self-test child runs clean but
     * node fastfails (0x80000003), node/V8 is the culprit; if the self-test
     * child ALSO fastfails, the LPAC token / file access is broken. The
     * NODE_OPTIONS=--require bootstrap injection is still applied (it is
     * inert for the helper exe, which never reads NODE_OPTIONS). */
    int     selfTest;

    /* ---------------------------------------------------------------
     * RUN-6 ROOT-CAUSE MATRIX — DIAGNOSTIC-ONLY TOGGLES.
     *
     * These three fields exist ONLY for the run-6 single-variable
     * experiment that localizes why node.exe (v22) fast-fails
     * (0x80000003 / STATUS_BREAKPOINT) under the full LPAC+Job sandbox
     * while a minimal no-V8 child (run-probe-child) runs clean. Each one
     * removes exactly ONE layer of the sandbox so the matrix can isolate
     * the trigger. They are set ONLY by the helper's own `run` CLI flags
     * (--skip-job / --skip-lpac / --no-job-mem-limit), NEVER by the
     * production WinSandboxBackend launch path — the win-backend
     * production launch must keep the full LPAC token + Job + memory
     * limit. These flags MUST be removed (or hard-guarded behind a
     * build-time diagnostic macro) before any release; they are not part
     * of the launch contract and weaken isolation when set.
     *
     *   skipJob        — do NOT create/assign the Job Object. The child
     *                    is still CREATE_SUSPENDED -> ResumeThread and the
     *                    stdio relay still runs; only the Job is omitted.
     *   skipLpac       — do NOT attach the AppContainer attribute list
     *                    (plain token, no SECURITY_CAPABILITIES / no
     *                    ALL_APPLICATION_PACKAGES opt-out). The Job is
     *                    still applied unless skipJob is also set.
     *   noJobMemLimit  — create the Job but OMIT JOB_OBJECT_LIMIT_JOB_MEMORY
     *                    (keep KILL_ON_JOB_CLOSE + the active-process cap).
     *                    No effect when skipJob is set (there is no Job).
     * --------------------------------------------------------------- */
    int     skipJob;
    int     skipLpac;
    int     noJobMemLimit;

    /* ---------------------------------------------------------------
     * OPTION-3 PRODUCTION PATH — useRestrictedToken.
     *
     * When non-zero, launch_sandboxed REPLACES the LPAC Step A (the
     * AppContainer SECURITY_CAPABILITIES attribute list) with a hardened
     * CreateRestrictedToken-derived PLAIN token and launches the child via
     * CreateProcessWithTokenW instead of CreateProcessW.
     *
     * Rationale (run-6 matrix conclusion): the LPAC token is the necessary
     * trigger for the Node launch crash (0x80000003); run-7 identified the
     * internal trigger point as Node's Winsock init — every LPAC arm prints
     * "WSAStartup: (10107) A system call has failed." on the child's stderr
     * immediately before the STATUS_BREAKPOINT fail-fast, and no non-LPAC arm
     * does (a symbolizable WER dump was not produced). Moving the
     * production node path off LPAC onto a restricted token + Job Object
     * avoids the crash while retaining a strong, explainable isolation
     * boundary.
     *
     * The restricted token is built as follows (see helper.c Step A'):
     *   - derived from the helper's own primary token (DuplicateTokenEx);
     *   - CreateRestrictedToken with DISABLE_MAX_PRIVILEGE (strips every
     *     privilege except SeChangeNotifyPrivilege);
     *   - a minimal set of high-risk GROUP SIDs made deny-only (currently
     *     ONLY the local Administrators alias SID, WinBuiltinAdministratorsSid);
     *   - integrity level lowered to Low (S-1-16-4096,
     *     SECURITY_MANDATORY_LOW_RID) via SetTokenInformation.
     * The child keeps its normal user identity (file/registry access via its
     * user + logon SIDs are preserved) but loses administrative power and all
     * dangerous privileges.
     *
     * Mutual exclusivity: useRestrictedToken replaces the LPAC Step A. When
     * it is set, NO AppContainer profile / SECURITY_CAPABILITIES /
     * ALL_APPLICATION_PACKAGES opt-out is applied (regardless of skipLpac).
     * It is the production mode; the LPAC path and the run-6 --skip-* flags
     * remain compiled for the diagnostic matrix baseline.
     *
     * The Job Object (KILL_ON_JOB_CLOSE + memory + active-process caps) is
     * UNCHANGED and still applied to the restricted-token child. The stdio
     * relay, environment block, and command-line build are likewise unchanged.
     * --------------------------------------------------------------- */
    int     useRestrictedToken;
} SANDBOX_LAUNCH_ARGS;

/*
 * launch_sandboxed -- race-free suspended-Job + LPAC launch + stdio relay.
 *
 * Enforces the launch order mandated by the AssignProcessToJobObject docs:
 *   1. CreateProcessW(..., CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
 *      EXTENDED_STARTUPINFO_PRESENT, ...) — the child starts frozen, BEFORE
 *      any user code runs.
 *   2. CreateJobObjectW with a non-inheritable SECURITY_ATTRIBUTES
 *      (bInheritHandle = FALSE) and the given name, then
 *      SetInformationJobObject for the extended limit
 *      (JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
 *      and the basic limit (active process cap).
 *   3. AssignProcessToJobObject(job, child) — assign while still suspended.
 *   4. Build the LPAC token via SECURITY_CAPABILITIES +
 *      PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES +
 *      PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY (opt-out) in a
 *      STARTUPINFOEXW. (Built BEFORE CreateProcessW so the attribute list is
 *      attached at process-creation time — see helper.c for why the token
 *      is built before step 1 even though the Job is configured between 1
 *      and 3.)
 *
 * OPTION-3 (useRestrictedToken): when args->useRestrictedToken is non-zero,
 * step 4 (and the LPAC attribute list in step 1) is REPLACED by building a
 * CreateRestrictedToken-hardened plain token (privileges stripped, the local
 * Administrators alias deny-only, Low integrity) and the child is launched
 * with CreateProcessWithTokenW — no EXTENDED_STARTUPINFO_PRESENT and no
 * attribute list. Steps 2/3/5 (Job create/configure, assign-while-suspended,
 * ResumeThread) are UNCHANGED and apply to the restricted-token child
 * identically.
 *   5. ONLY on full success of every prior step, ResumeThread(child) — now
 *      the child runs, fully inside the Job. Any failure before this point
 *      MUST TerminateProcess the suspended child, close its handles, free
 *      every allocated SID / attribute-list / env block, and return a
 *      failure HRESULT. No running or suspended orphan outside the Job is
 *      ever left behind.
 *
 * The child's stdio is relayed over anonymous pipes with overlapped reads so
 * stdout and stderr both stream without deadlock. The child's exit code is
 * propagated via outExitCode.
 *
 * Parameters:
 *   args        [in]  SANDBOX_LAUNCH_ARGS bundle (caller-owned strings).
 *   outExitCode [out] receives the child's DWORD exit code on success.
 *                     Set to 0 on entry; left 0 on any failure before the
 *                     child exits.
 *
 * Returns:
 *   S_OK when the child was launched inside the Job and exited (its code is
 *   in *outExitCode). A failure HRESULT otherwise — any pre-ResumeThread
 *   failure means the child was terminated before running a single
 *   instruction.
 */
HRESULT launch_sandboxed(const SANDBOX_LAUNCH_ARGS *args, DWORD *outExitCode);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* OCTOPUS_SANDBOX_HELPER_H */
