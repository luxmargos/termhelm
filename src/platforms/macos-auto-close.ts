import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appleScriptString } from '../shell.js';
import type { TerminalUiCloseOutcome } from '../types.js';

const POLL_INTERVAL_MS = 100;

type MacTerminalTabState = 'busy' | 'idle' | 'missing' | 'shared' | 'unknown';
type TerminalMarkerState = 'stopped' | 'failed';

interface MacAutoClosePayload {
  windowId: number;
  tty: string;
  sessionId: string;
  targetId: string;
  stoppedPath: string;
  failedPath: string;
  watcherTokenPath: string;
  idleTimeoutMs: number;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function validatePayload(value: unknown): MacAutoClosePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('macOS auto-close payload must be an object.');
  }
  const payload = value as Record<string, unknown>;
  if (!Number.isSafeInteger(payload.windowId) || Number(payload.windowId) <= 0) {
    throw new Error('macOS auto-close window ID is invalid.');
  }
  for (const key of ['tty', 'sessionId', 'targetId', 'stoppedPath', 'failedPath', 'watcherTokenPath'] as const) {
    if (typeof payload[key] !== 'string' || payload[key].length === 0 || payload[key].includes('\0')) {
      throw new Error(`macOS auto-close ${key} is invalid.`);
    }
  }
  if (!Number.isSafeInteger(payload.idleTimeoutMs) || Number(payload.idleTimeoutMs) < 0) {
    throw new Error('macOS auto-close idle timeout is invalid.');
  }
  return {
    windowId: Number(payload.windowId),
    tty: payload.tty as string,
    sessionId: payload.sessionId as string,
    targetId: payload.targetId as string,
    stoppedPath: payload.stoppedPath as string,
    failedPath: payload.failedPath as string,
    watcherTokenPath: payload.watcherTokenPath as string,
    idleTimeoutMs: Number(payload.idleTimeoutMs)
  };
}

export function buildMacTerminalTabStateScript(windowId: number, tty: string): string[] {
  return [
    'tell application "Terminal"',
    `set targetWindowId to ${Number(windowId)}`,
    `set targetTty to ${appleScriptString(tty)}`,
    'try',
    '  set targetWindow to first window whose id is targetWindowId',
    '  if (count of tabs of targetWindow) is not 1 then return "shared"',
    '  repeat with targetTab in tabs of targetWindow',
    '    if (tty of targetTab as text) is targetTty then',
    '      if busy of targetTab then return "busy"',
    '      return "idle"',
    '    end if',
    '  end repeat',
    '  return "missing"',
    'on error',
    '  return "missing"',
    'end try',
    'end tell'
  ];
}

export function macTerminalTabState(windowId: number, tty: string): MacTerminalTabState {
  const result = spawnSync(
    'osascript',
    buildMacTerminalTabStateScript(windowId, tty).flatMap(line => ['-e', line]),
    { encoding: 'utf8' }
  );
  if (result.error || result.status !== 0) return 'unknown';
  const state = result.stdout.trim();
  return state === 'busy' || state === 'idle' || state === 'missing' || state === 'shared'
    ? state
    : 'unknown';
}

export function waitForMacTerminalTabToSettle(
  windowId: number,
  tty: string,
  timeoutMs: number,
  cancelled: () => boolean = () => false
): boolean {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (cancelled()) return false;
    const state = macTerminalTabState(windowId, tty);
    if (state === 'idle' || state === 'missing') return !cancelled();
    if (state === 'shared') return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    sleepSync(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

export function buildCloseMacTerminalTabScript(windowId: number, tty: string): string[] {
  return [
    'tell application "Terminal"',
    `set targetWindowId to ${Number(windowId)}`,
    `set targetTty to ${appleScriptString(tty)}`,
    'try',
    '  set targetWindow to first window whose id is targetWindowId',
    'on error',
    '  return "missing"',
    'end try',
    'if (count of tabs of targetWindow) is not 1 then return "shared"',
    'repeat with targetTab in tabs of targetWindow',
    '  if (tty of targetTab as text) is targetTty then',
    '    if busy of targetTab then return "busy"',
    '    close targetWindow',
    '    return "closed"',
    '  end if',
    'end repeat',
    'return "missing"',
    'end tell'
  ];
}

export function closeMacTerminalTab(windowId: number, tty: string): TerminalUiCloseOutcome {
  const script = buildCloseMacTerminalTabScript(windowId, tty);
  const result = spawnSync('osascript', script.flatMap(line => ['-e', line]), { encoding: 'utf8' });
  if (result.error || result.status !== 0) return 'unsupported';
  const outcome = result.stdout.trim();
  if (outcome === 'closed' || outcome === 'missing') return 'closed';
  if (outcome === 'shared') return 'refused-shared';
  return outcome === 'busy' ? 'host-managed' : 'unsupported';
}

export function markerIsAuthoritative(
  path: string,
  payload: MacAutoClosePayload,
  expectedState: TerminalMarkerState
): boolean {
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return marker.version === 2
      && marker.sessionId === payload.sessionId
      && marker.targetId === payload.targetId
      && marker.state === expectedState
      && typeof marker.updatedAt === 'string';
  } catch {
    return false;
  }
}

async function runAutoClose(payload: MacAutoClosePayload): Promise<void> {
  try {
    while (existsSync(payload.watcherTokenPath)) {
      if (existsSync(payload.stoppedPath)) {
        if (!markerIsAuthoritative(payload.stoppedPath, payload, 'stopped')) return;
        const cancelled = () => !existsSync(payload.watcherTokenPath);
        if (!waitForMacTerminalTabToSettle(payload.windowId, payload.tty, payload.idleTimeoutMs, cancelled)) return;
        if (cancelled()) return;
        closeMacTerminalTab(payload.windowId, payload.tty);
        return;
      }
      if (existsSync(payload.failedPath)) {
        if (!markerIsAuthoritative(payload.failedPath, payload, 'failed')) return;
        const cancelled = () => !existsSync(payload.watcherTokenPath);
        if (!waitForMacTerminalTabToSettle(payload.windowId, payload.tty, payload.idleTimeoutMs, cancelled)) return;
        if (cancelled()) return;
        closeMacTerminalTab(payload.windowId, payload.tty);
        return;
      }
      sleepSync(POLL_INTERVAL_MS);
    }
  } finally {
    rmSync(payload.watcherTokenPath, { force: true });
  }
}

async function main(): Promise<void> {
  const encodedPayload = process.argv[2];
  if (!encodedPayload) throw new Error('macOS auto-close payload is required.');
  const payload = validatePayload(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')));
  await runAutoClose(payload);
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  void main().catch(error => {
    process.stderr.write(`termhelm macOS auto-close: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
