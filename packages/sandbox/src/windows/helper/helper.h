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
