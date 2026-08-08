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

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* OCTOPUS_SANDBOX_HELPER_H */
