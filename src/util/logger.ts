/**
 * Minimal logger: timestamped lines to stdout/stderr and, when configured,
 * appended to a log file so long unattended runs leave a trace on disk.
 */
import * as fs from 'fs';
import * as path from 'path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = 'info';
let logFile: string | undefined;
const startedAt = Date.now();

function stamp(): string {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(7);
  return `[${new Date().toISOString()} +${elapsed}s]`;
}

function write(level: Level, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      /* logging must never break the run */
    }
  }
}

export const log = {
  debug: (m: string): void => write('debug', m),
  info: (m: string): void => write('info', m),
  warn: (m: string): void => write('warn', m),
  error: (m: string): void => write('error', m),
  /** Enables debug output. */
  setDebug(enabled: boolean): void {
    minLevel = enabled ? 'debug' : 'info';
  },
  /** Mirrors every line to `file` (directory is created on demand). */
  setFile(file: string | undefined): void {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    logFile = file;
  },
};

/** Formats an unknown thrown value for a log line. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
