import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_READY_TIMEOUT_MS = 6000;
const DEFAULT_STOP_TIMEOUT_MS = 6000;

export interface TerminalControlPaths {
  id: string;
  sessionId: string;
  directory: string;
  targetTokenPath: string;
  readyPath: string;
  stoppingPath: string;
  stoppedPath: string;
  failedPath: string;
  forcedPath: string;
  gracefulShutdownMs: number;
  ownsDirectory: boolean;
}

export interface TerminalControllerOptions {
  /** Manager-provided target UUID. A fresh UUID is generated when omitted. */
  id?: string;
  /** Manager-provided session UUID. A fresh UUID is generated when omitted. */
  sessionId?: string;
  /** Existing secure session/targets directory. It is never recursively removed by the controller. */
  controlDirectory?: string;
  stateDirectory?: string;
  targetTokenPath?: string;
  readyPath?: string;
  stoppingPath?: string;
  stoppedPath?: string;
  failedPath?: string;
  forcedPath?: string;
  gracefulShutdownMs?: number;
}

export interface TerminalProcessController {
  readonly id: string;
  readonly readyPath: string;
  readonly stoppingPath: string;
  readonly stoppedPath: string;
  readonly failedPath: string;
  readonly forcedPath: string;
  requestClose(): void;
  waitUntilReady(timeoutMs?: number): boolean;
  waitUntilStopped(timeoutMs?: number): boolean;
  wasForced(): boolean;
  close(timeoutMs?: number): boolean;
  dispose(): void;
}

export class TerminalControllerLaunchError extends Error {
  constructor(
    message: string,
    readonly controller: TerminalProcessController,
    cause: unknown
  ) {
    super(message, { cause });
    this.name = 'TerminalControllerLaunchError';
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function waitForTerminalMarker(path: string, timeoutMs: number): boolean {
  if (existsSync(path)) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
    if (existsSync(path)) return true;
  }
  return existsSync(path);
}

function waitForAnyTerminalMarker(paths: string[], timeoutMs: number): string | null {
  const existing = paths.find(path => existsSync(path));
  if (existing) return existing;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
    const found = paths.find(path => existsSync(path));
    if (found) return found;
  }
  return paths.find(path => existsSync(path)) ?? null;
}

export function writeTerminalMarker(path: string, value = ''): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, value, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
}

export type TerminalMarkerState = 'ready' | 'stopping' | 'stopped' | 'failed';

export function terminalMarkerJson(paths: TerminalControlPaths, state: TerminalMarkerState): string {
  return `${JSON.stringify({
    version: 2,
    sessionId: paths.sessionId,
    targetId: paths.id,
    state,
    updatedAt: new Date().toISOString()
  })}\n`;
}

export function forcedTerminalMarkerJson(paths: TerminalControlPaths): string {
  return `${JSON.stringify({
    version: 2,
    sessionId: paths.sessionId,
    targetId: paths.id,
    state: 'forced',
    updatedAt: new Date().toISOString()
  })}\n`;
}

export function writeTerminalStateMarker(paths: TerminalControlPaths, state: TerminalMarkerState): void {
  const path = state === 'ready'
    ? paths.readyPath
    : state === 'stopped'
      ? paths.stoppedPath
      : state === 'failed'
        ? paths.failedPath
        : paths.stoppingPath;
  writeTerminalMarker(path, terminalMarkerJson(paths, state));
}

function validateControllerId(value: string, description: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid terminal controller ${description}: ${value}`);
  }
  return value.toLowerCase();
}

export function createTerminalControlPaths(options: TerminalControllerOptions = {}): TerminalControlPaths {
  const id = validateControllerId(options.id ?? randomUUID(), 'target ID');
  const sessionId = validateControllerId(options.sessionId ?? randomUUID(), 'session ID');
  const root = options.stateDirectory ?? tmpdir();
  const ownsDirectory = options.controlDirectory === undefined;
  const directory = options.controlDirectory ?? join(root, `terminal-windows-target-${id}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: !ownsDirectory, mode: 0o700 });
  const markerName = (state: string) => ownsDirectory ? state : `${id}.${state}.json`;
  const paths: TerminalControlPaths = {
    id,
    sessionId,
    directory,
    targetTokenPath: options.targetTokenPath ?? join(directory, ownsDirectory ? 'alive' : `${id}.alive`),
    readyPath: options.readyPath ?? join(directory, markerName('ready')),
    stoppingPath: options.stoppingPath ?? join(directory, markerName('stopping')),
    stoppedPath: options.stoppedPath ?? join(directory, markerName('stopped')),
    failedPath: options.failedPath ?? join(directory, markerName('failed')),
    forcedPath: options.forcedPath ?? join(directory, markerName('forced')),
    gracefulShutdownMs: Math.max(0, options.gracefulShutdownMs ?? 2000),
    ownsDirectory
  };
  writeTerminalMarker(paths.targetTokenPath, `${process.pid}\n`);
  return paths;
}

export function abandonTerminalControl(paths: TerminalControlPaths): void {
  if (paths.ownsDirectory) rmSync(paths.directory, { recursive: true, force: true });
  else rmSync(paths.targetTokenPath, { force: true });
}

export class MarkerTerminalProcessController implements TerminalProcessController {
  readonly id: string;
  readonly readyPath: string;
  readonly stoppingPath: string;
  readonly stoppedPath: string;
  readonly failedPath: string;
  readonly forcedPath: string;
  protected readonly control: TerminalControlPaths;

  constructor(control: TerminalControlPaths) {
    this.control = control;
    this.id = control.id;
    this.readyPath = control.readyPath;
    this.stoppingPath = control.stoppingPath;
    this.stoppedPath = control.stoppedPath;
    this.failedPath = control.failedPath;
    this.forcedPath = control.forcedPath;
  }

  requestClose(): void {
    rmSync(this.control.targetTokenPath, { force: true });
  }

  waitUntilReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): boolean {
    return waitForAnyTerminalMarker([this.readyPath, this.failedPath], timeoutMs) === this.readyPath;
  }

  waitUntilStopped(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): boolean {
    return waitForAnyTerminalMarker([this.stoppedPath, this.failedPath], timeoutMs) !== null;
  }

  wasForced(): boolean {
    return existsSync(this.forcedPath);
  }

  close(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): boolean {
    this.requestClose();
    return this.waitUntilStopped(timeoutMs);
  }

  dispose(): void {
    if (!existsSync(this.stoppedPath) && !existsSync(this.failedPath)) {
      throw new Error(`Cannot dispose terminal controller ${this.id} before it has stopped.`);
    }
    if (this.control.ownsDirectory) abandonTerminalControl(this.control);
    else rmSync(this.control.targetTokenPath, { force: true });
  }
}
