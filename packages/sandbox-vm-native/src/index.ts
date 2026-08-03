// packages/sandbox-vm-native/src/index.ts
// Leaf package entry. Exports the VM engine + image-builder implementations
// plus the port types from the parent sandbox package. Deep imports into
// @agentoctopus/sandbox/dist (TCB/gate/release helpers) stay internal —
// consumers go through the port surface only.
import type { VmEnginePort, VmImageBuilderPort } from '@agentoctopus/sandbox';
import { VmEngineImpl } from './engine.js';
import { VmImageBuilderImpl } from './image-builder.js';

export { assertExecutablesQualified } from './executables-qualified.js';
export { createLoopbackStatRootfsFile, mountRootfsReadOnly, umount, RootfsMountError } from './rootfs-loopback-mount.js';
export { createExt4StatRootfsFile } from './rootfs-ext4-stat.js';
export type { MountHandle } from './rootfs-loopback-mount.js';
export type { ExecStatResult, AssertExecutablesDeps } from './executables-qualified.js';
export { VmEngineImpl, VmImageBuilderImpl };
export { createNativeDeps } from './native-binding.js';
export type { VmEngineDeps, SpawnFileAction, VmEngineOptions } from './engine.js';
export type { VmEnginePort, VmImageBuilderPort };
