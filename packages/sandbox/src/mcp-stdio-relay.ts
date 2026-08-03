// Trusted MCP stdio framing: newline-delimited JSON. SandboxMcpTransport
// (packages/adapters) builds on these so every backend shares one parser.
export class MalformedFrameError extends Error {
  constructor(public readonly frame: string) {
    super(`malformed MCP stdio frame: ${frame.slice(0, 120)}`);
    this.name = 'MalformedFrameError';
  }
}

export function frameMessage(message: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

export function createFrameParser(onMessage: (message: unknown) => void): (chunk: Uint8Array | string) => void {
  let buffer = '';
  const decoder = new TextDecoder();
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new MalformedFrameError(line); }
      if (parsed === null || typeof parsed !== 'object') throw new MalformedFrameError(line);
      onMessage(parsed);
    }
  };
}
