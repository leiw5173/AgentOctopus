export function dbg(enabled: boolean, msg: string): void {
  if (!enabled) return;
  process.stdout.write(`\x1b[2m[debug] ${msg}\x1b[0m\n`);
}
