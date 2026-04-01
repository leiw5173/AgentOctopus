import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  method: string;
  path: string;
  ip: string;
  apiKey?: string;        // masked: ak_****xxxx
  userId?: string;
  tier?: string;
  statusCode: number;
  durationMs: number;
  userAgent?: string;
  query?: string;         // the user's query (truncated)
}

// ─── Configuration ───────────────────────────────────────────────────────────

let _logDir: string | null = null;
let _writeStream: fs.WriteStream | null = null;

function getLogDir(): string {
  if (_logDir) return _logDir;
  const root = process.env.OCTOPUS_ROOT ?? process.cwd();
  _logDir = process.env.AUDIT_LOG_DIR ?? path.join(root, 'logs');
  return _logDir;
}

function ensureLogStream(): fs.WriteStream {
  if (_writeStream) return _writeStream;

  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, 'audit.jsonl');
  _writeStream = fs.createWriteStream(logFile, { flags: 'a' });

  return _writeStream;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '_****' + key.slice(-4);
}

function truncate(str: string, maxLen = 200): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Audit logging middleware.
 *
 * Logs each request to `logs/audit.jsonl` with:
 * - Timestamp, method, path, IP
 * - Masked API key and user ID (if authenticated)
 * - Status code and response time
 * - Truncated query body
 */
export function auditLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  // Hook into response finish to capture status code
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    const entry: AuditEntry = {
      timestamp: new Date(startTime).toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      statusCode: res.statusCode,
      durationMs: duration,
      userAgent: req.headers['user-agent']?.slice(0, 100),
    };

    // Add auth info if available
    const apiKey = (req as any).apiKey;
    if (apiKey) {
      entry.apiKey = maskApiKey(apiKey);
    }

    const apiKeyEntry = (req as any).apiKeyEntry;
    if (apiKeyEntry) {
      entry.userId = apiKeyEntry.userId;
      entry.tier = apiKeyEntry.tier;
    }

    // Capture the query from request body
    if (req.body && typeof req.body === 'object' && req.body.query) {
      entry.query = truncate(String(req.body.query));
    }

    // Write to JSONL file (non-blocking)
    try {
      const stream = ensureLogStream();
      stream.write(JSON.stringify(entry) + '\n');
    } catch {
      // Don't let audit failures break the request
    }

    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
      const statusColor = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
      console.log(
        `[audit] ${statusColor}${res.statusCode}\x1b[0m ${req.method} ${req.path} ` +
        `${duration}ms${entry.apiKey ? ` [${entry.apiKey}]` : ''}`
      );
    }
  });

  next();
}

/** Close the audit log stream (for graceful shutdown). */
export function closeAuditLog(): void {
  if (_writeStream) {
    _writeStream.end();
    _writeStream = null;
  }
}

/** Reset internals (for testing). */
export function resetAuditLogger(): void {
  closeAuditLog();
  _logDir = null;
}
