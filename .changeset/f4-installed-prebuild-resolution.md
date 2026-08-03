---
"@agentoctopus/core": patch
---

Resolve VM native prebuilds via the package graph (F4).

defaultPrebuildRoot() walked up from import.meta.url to find
packages/sandbox-vm-native — correct in the monorepo source tree, but in an
npm install core/dist/ lives at node_modules/@agentoctopus/core/dist/, so the
walk resolved to node_modules/packages/sandbox-vm-native (nonexistent). The
existence check converted that into a clean unavailable, but an installed
@agentoctopus/core could never locate the VM prebuilds even when
@agentoctopus/sandbox-vm-native was installed alongside it.

Resolve the native package's prebuilds/<platform> dir via
require.resolve('@agentoctopus/sandbox-vm-native/package.json') first (walks
node_modules the same way import does), falling back to the source-tree walk
only for monorepo dev. The helper and image-builder paths now derive from one
consistent resolved dir.
