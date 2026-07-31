---
"@agentoctopus/core": patch
---

Mark the dynamic `import('@agentoctopus/sandbox-vm-native')` with `/* webpackIgnore: true */` so Turbopack (Next.js web app) does not statically resolve and bundle it. The VM backend is a runtime-only optional native package (libkrun microVM); Turbopack would otherwise pull in koffi's native `.node` binding — a "non-ecmascript placeable asset" that fails the apps/web build. `serverExternalPackages` cannot externalize a dynamic-import specifier. With webpackIgnore, the import is left as-is: plain Node (CLI, gateway) resolves it normally; the web app's serverless runtime throws, and createVmBackend's catch returns the fail-closed `unavailable` path it already takes (the web app never selects the VM backend).
