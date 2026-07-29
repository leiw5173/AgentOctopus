// packages/sandbox/src/vm/errors.ts
export class ExecutablesUnqualifiedError extends Error {
  constructor(public readonly offending: string[]) {
    super(`executables unqualified: ${offending.join('; ')}`);
    this.name = 'ExecutablesUnqualifiedError';
  }
}

export class LaunchSpecTooLargeError extends Error {
  constructor(public readonly which: 'decoded' | 'argv', public readonly bytes: number) {
    super(`launch spec too large (${which}): ${bytes} bytes`);
    this.name = 'LaunchSpecTooLargeError';
  }
}

export class RunSpecError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RunSpecError'; }
}
