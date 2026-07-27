/**
 * Plan 4, Task 3 (Step 0) — interface-only stub for the named network
 * namespace handle the OS backend passes into the phased launcher.
 *
 * Task 4 extends THIS FILE with the implementations (`setupNetns`,
 * `authorizeProxyEndpoint`, `buildNetnsCommands`). The contract is declared
 * here so the Task 3 launch-spec builder + tests can compile against it.
 *
 * Leaf-package rule: this file imports nothing.
 */

export interface NetnsHandle {
  /** Kernel-visible namespace name (e.g. `octn-deadbeef`). */
  readonly name: string;
  /** Host path handed to setns() (e.g. `/run/netns/octn-deadbeef`). */
  readonly path: string;
  /** veth interface name on the host side. */
  readonly hostIf: string;
  /** veth interface name inside the skill namespace. */
  readonly skillIf: string;
  /** Link-local address the egress proxy listens on inside the namespace. */
  readonly proxyIp: string;
  /** Link-local address assigned to the skill side of the veth pair. */
  readonly skillIp: string;
  /** TCP port the egress proxy listens on inside the namespace. */
  readonly proxyPort: number;
  /** Per-session nftables table holding the allowlist rules. */
  readonly nftTable: string;
  /** Idempotent teardown of the namespace, veth pair, and nft table. */
  cleanup(): Promise<void>;
}
