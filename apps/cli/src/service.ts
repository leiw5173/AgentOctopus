import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ServiceCommand {
  label: string;
  args: string[];
}

export function getRepoRoot(currentModuleUrl: string = import.meta.url): string {
  const currentFile = fileURLToPath(currentModuleUrl);
  const currentDir = path.dirname(currentFile);
  return path.resolve(currentDir, '../../..');
}

export function getServiceCommands(): ServiceCommand[] {
  return [
    {
      label: 'web',
      args: ['--filter', 'web', 'dev'],
    },
    {
      label: 'gateway',
      args: ['--filter', '@agentoctopus/gateway', 'start:agent'],
    },
  ];
}

function prefixStream(stream: NodeJS.ReadableStream | null, label: string, writer: NodeJS.WriteStream) {
  if (!stream) {
    return;
  }

  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      writer.write(`[${label}] ${line}\n`);
    }
  });

  stream.on('end', () => {
    if (buffer.length > 0) {
      writer.write(`[${label}] ${buffer}\n`);
    }
  });
}

export async function startService(rootDir: string = getRepoRoot()): Promise<void> {
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const children: ChildProcess[] = [];
  let shuttingDown = false;

  const stopAll = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) {
        child.kill(signal);
      }
    }
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    stopAll(signal);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await new Promise<void>((resolve, reject) => {
      let exited = 0;

      for (const command of getServiceCommands()) {
        const child = spawn(pnpmCommand, command.args, {
          cwd: rootDir,
          env: process.env,
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        children.push(child);

        prefixStream(child.stdout, command.label, process.stdout);
        prefixStream(child.stderr, command.label, process.stderr);

        child.on('error', (error) => {
          stopAll();
          reject(error);
        });

        child.on('exit', (code, signal) => {
          exited += 1;

          if (!shuttingDown && (code !== 0 || signal)) {
            stopAll();
            reject(
              new Error(
                `${command.label} exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? 1}`})`
              )
            );
            return;
          }

          if (exited === children.length) {
            resolve();
          }
        });
      }
    });
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  }
}
