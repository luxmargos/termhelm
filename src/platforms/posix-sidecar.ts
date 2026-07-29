import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  watchManagedSupervisor,
  type ManagedControllerState,
  type ManagedSupervisorWatch
} from '../control.js';
import type { InternalTerminalLaunchOptions, ResolvedTerminalTarget } from '../types.js';
import type { TerminalControlPaths } from './controller.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POLL_INTERVAL_MS = 50;
const SOLO_SNAPSHOT_COUNT = 2;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024;
const PS_TIMEOUT_MS = 2_000;

export interface PosixSidecarPayload {
  version: 2;
  sessionId: string;
  targetId: string;
  targetTokenPath: string;
  supervisorTokenPath?: string;
  readyPath: string;
  stoppingPath: string;
  stoppedPath: string;
  failedPath: string;
  forcedPath: string;
  gracefulShutdownMs: number;
  forcedConfirmationMs: number;
  controlEndpoint?: string;
  authenticationToken?: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
  exitMessage?: string;
  exitAfterCommand: boolean;
}

function encodedPayload(payload: PosixSidecarPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function writePrivatePayloadFile(path: string, payload: PosixSidecarPayload): void {
  writeFileSync(path, `${encodedPayload(payload)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function readAndRemovePrivatePayloadFile(path: string): PosixSidecarPayload {
  const resolvedPath = validatePath(path, 'payload path');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PAYLOAD_BYTES * 2) {
      throw new Error('POSIX controller payload file is invalid.');
    }
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error('POSIX controller payload file is not owned by the current user.');
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error('POSIX controller payload file permissions are unsafe.');
    }
    return parsePosixSidecarPayload(readFileSync(descriptor, 'utf8').trim());
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(resolvedPath, { force: true });
  }
}

export function cleanupPosixSidecarLaunch(
  launch: NonNullable<InternalTerminalLaunchOptions['posixSidecar']>
): void {
  rmSync(launch.payloadPath, { force: true });
  rmSync(launch.finalizerPayloadPath, { force: true });
}

function bundledPosixSidecarScriptPath(): string {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith('.js') && existsSync(modulePath)) return modulePath;
  const developmentBuildPath = resolve(dirname(modulePath), '..', '..', 'dist', 'platforms', 'posix-sidecar.js');
  if (existsSync(developmentBuildPath)) return developmentBuildPath;
  return modulePath;
}

export function createPosixSidecarLaunch(
  target: ResolvedTerminalTarget,
  control: TerminalControlPaths,
  options: InternalTerminalLaunchOptions
): NonNullable<InternalTerminalLaunchOptions['posixSidecar']> {
  const payload: PosixSidecarPayload = {
    version: 2,
    sessionId: control.sessionId,
    targetId: control.id,
    targetTokenPath: control.targetTokenPath,
    readyPath: control.readyPath,
    stoppingPath: control.stoppingPath,
    stoppedPath: control.stoppedPath,
    failedPath: control.failedPath,
    forcedPath: control.forcedPath,
    gracefulShutdownMs: control.gracefulShutdownMs,
    forcedConfirmationMs: options.closeWaitTimeoutMs ?? 6_000,
    cwd: target.cwd,
    command: target.command,
    exitAfterCommand: options.exitAfterCommand ?? true
  };
  if (target.env !== undefined) payload.env = target.env;
  if (target.exitMessage !== undefined) payload.exitMessage = target.exitMessage;
  if (options.shutdownTokenPath) payload.supervisorTokenPath = options.shutdownTokenPath;
  if (options.controlEndpoint && options.authenticationToken) {
    payload.controlEndpoint = options.controlEndpoint;
    payload.authenticationToken = options.authenticationToken;
  }
  const finalizerPayload: PosixSidecarPayload = {
    ...payload,
    cwd: control.directory,
    command: '',
    exitAfterCommand: true
  };
  delete finalizerPayload.env;
  delete finalizerPayload.exitMessage;
  delete finalizerPayload.supervisorTokenPath;
  delete finalizerPayload.controlEndpoint;
  delete finalizerPayload.authenticationToken;

  const payloadPath = join(control.directory, `${control.id}.runner.payload`);
  const finalizerPayloadPath = join(control.directory, `${control.id}.finalizer.payload`);
  try {
    writePrivatePayloadFile(payloadPath, payload);
    writePrivatePayloadFile(finalizerPayloadPath, finalizerPayload);
  } catch (error) {
    rmSync(payloadPath, { force: true });
    rmSync(finalizerPayloadPath, { force: true });
    throw error;
  }
  return {
    executablePath: process.execPath,
    scriptPath: bundledPosixSidecarScriptPath(),
    payloadPath,
    finalizerPayloadPath
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`POSIX controller ${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

function validatePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`POSIX controller ${name} must be an absolute path.`);
  }
  return resolve(value);
}

function validateString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`POSIX controller ${name} must be a string without NUL characters.`);
  }
  return value;
}

function validateMilliseconds(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 0x7fff_ffff) {
    throw new Error(`POSIX controller ${name} must be a finite non-negative duration.`);
  }
  return Math.ceil(value);
}

function validateEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error('POSIX controller environment must be an object.');
  const environment = Object.create(null) as Record<string, string>;
  for (const [name, entry] of Object.entries(value)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || typeof entry !== 'string' || entry.includes('\0')) {
      throw new Error('POSIX controller environment entries must have valid names and string values without NUL characters.');
    }
    environment[name] = entry;
  }
  return environment;
}

export function parsePosixSidecarPayload(encoded: string): PosixSidecarPayload {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_PAYLOAD_BYTES * 2) {
    throw new Error('POSIX controller payload is invalid.');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error('POSIX controller payload is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('POSIX controller payload is invalid.');
  }
  if (!isObject(value) || value.version !== 2) throw new Error('POSIX controller payload version is invalid.');

  const targetTokenPath = validatePath(value.targetTokenPath, 'target token path');
  const readyPath = validatePath(value.readyPath, 'ready marker path');
  const stoppingPath = validatePath(value.stoppingPath, 'stopping marker path');
  const stoppedPath = validatePath(value.stoppedPath, 'stopped marker path');
  const failedPath = validatePath(value.failedPath, 'failed marker path');
  const forcedPath = validatePath(value.forcedPath, 'forced marker path');
  const controlDirectory = realpathSync(dirname(targetTokenPath));
  for (const path of [readyPath, stoppingPath, stoppedPath, failedPath, forcedPath]) {
    if (realpathSync(dirname(path)) !== controlDirectory) {
      throw new Error('POSIX controller marker paths must share the private target directory.');
    }
  }

  if (typeof value.exitAfterCommand !== 'boolean') {
    throw new Error('POSIX controller exit-after-command setting must be a boolean.');
  }
  const payload: PosixSidecarPayload = {
    version: 2,
    sessionId: validateUuid(value.sessionId, 'session ID'),
    targetId: validateUuid(value.targetId, 'target ID'),
    targetTokenPath,
    readyPath,
    stoppingPath,
    stoppedPath,
    failedPath,
    forcedPath,
    gracefulShutdownMs: validateMilliseconds(value.gracefulShutdownMs, 'graceful shutdown timeout'),
    forcedConfirmationMs: validateMilliseconds(value.forcedConfirmationMs, 'forced confirmation timeout'),
    cwd: validatePath(value.cwd, 'working directory'),
    command: validateString(value.command, 'command'),
    exitAfterCommand: value.exitAfterCommand
  };
  const environment = validateEnvironment(value.env);
  if (environment !== undefined) payload.env = environment;
  if (value.exitMessage !== undefined) payload.exitMessage = validateString(value.exitMessage, 'exit message');
  if (value.supervisorTokenPath !== undefined) {
    payload.supervisorTokenPath = validatePath(value.supervisorTokenPath, 'supervisor token path');
  }
  if (value.controlEndpoint !== undefined || value.authenticationToken !== undefined) {
    payload.controlEndpoint = validatePath(value.controlEndpoint, 'control endpoint');
    if (typeof value.authenticationToken !== 'string' || !TOKEN_PATTERN.test(value.authenticationToken)) {
      throw new Error('POSIX controller authentication token is invalid.');
    }
    payload.authenticationToken = value.authenticationToken;
  }
  return payload;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, Math.max(0, milliseconds)));
}

function marker(payload: PosixSidecarPayload, state: ManagedControllerState | 'failed' | 'forced'): string {
  return `${JSON.stringify({
    version: 2,
    sessionId: payload.sessionId,
    targetId: payload.targetId,
    state,
    updatedAt: new Date().toISOString()
  })}\n`;
}

function writeMarker(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function statePath(payload: PosixSidecarPayload, state: ManagedControllerState): string {
  return state === 'ready'
    ? payload.readyPath
    : state === 'stopping'
      ? payload.stoppingPath
      : payload.stoppedPath;
}

async function reportState(
  watch: ManagedSupervisorWatch | null,
  payload: PosixSidecarPayload,
  state: ManagedControllerState
): Promise<void> {
  if (watch) await watch.sendState(state);
  writeMarker(statePath(payload, state), marker(payload, state));
}

function writeFailed(payload: PosixSidecarPayload): void {
  writeMarker(payload.failedPath, marker(payload, 'failed'));
}

function writeForced(payload: PosixSidecarPayload): void {
  writeMarker(payload.forcedPath, marker(payload, 'forced'));
}

function runnerCompletionPath(payload: PosixSidecarPayload): string {
  return `${payload.stoppedPath}.runner-complete`;
}

function writeRunnerCompletion(payload: PosixSidecarPayload): void {
  writeMarker(runnerCompletionPath(payload), `${payload.sessionId}:${payload.targetId}\n`);
}

function groupPresence(processGroupId: number): 'present' | 'absent' | 'ambiguous' {
  try {
    process.kill(-processGroupId, 0);
    return 'present';
  } catch (error) {
    if (isObject(error) && error.code === 'ESRCH') return 'absent';
    if (isObject(error) && error.code === 'EPERM') return 'ambiguous';
    throw error;
  }
}

export function probePosixGroupAbsence(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return false;
  return groupPresence(processGroupId) === 'absent';
}

async function inspectProcessGroup(processGroupId: number): Promise<number[]> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn('ps', ['-axo', 'pid=,pgid='], {
      detached: true,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveOutput(stdout);
    };
    const abandonInspection = (error: Error): void => {
      finish(error);
      // The snapshot is only an optimization, so close its pipes and let the
      // PATH-resolved ps child exit naturally. A saved numeric PID is never
      // promoted to signal authority, even for this auxiliary process.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const addOutput = (chunk: Buffer, isError: boolean): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PS_OUTPUT_BYTES) {
        abandonInspection(new Error('POSIX controller process-group membership output exceeded its limit.'));
        return;
      }
      if (isError) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    const timer = setTimeout(() => {
      abandonInspection(new Error('POSIX controller process-group membership inspection timed out.'));
    }, PS_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => addOutput(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => addOutput(chunk, true));
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null || stderr.length > 0) {
        finish(new Error('POSIX controller could not inspect process-group membership safely.'));
      } else {
        finish();
      }
    });
  });
  const members = new Set<number>();
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(line);
    if (!match) throw new Error('POSIX controller received ambiguous process-group membership data.');
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid <= 0) {
      throw new Error('POSIX controller received invalid process-group membership data.');
    }
    if (pgid === processGroupId) members.add(pid);
  }
  return [...members].sort((left, right) => left - right);
}

interface OwnedChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface OwnedChild {
  child: ChildProcess;
  started: Promise<void>;
  result: Promise<OwnedChildResult>;
  currentResult: OwnedChildResult | null;
}

function spawnOwnedShell(payload: PosixSidecarPayload, fallback: boolean): OwnedChild {
  const shell = process.env.SHELL || '/bin/sh';
  const commandScriptPath = fallback
    ? null
    : join(dirname(payload.targetTokenPath), `${payload.targetId}.command`);
  if (commandScriptPath !== null) {
    writeFileSync(commandScriptPath, `${payload.command}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    chmodSync(commandScriptPath, 0o600);
  }
  const child = spawn(shell, fallback ? ['-l'] : ['-l', commandScriptPath!], {
    cwd: payload.cwd,
    env: {
      ...process.env,
      ...payload.env,
      ...(fallback ? { TERMHELM_INTERNAL_FALLBACK_SHELL: '1' } : {})
    },
    // An interactive shell attached directly to the terminal enables job
    // control and moves itself into a new process group. Keep fallback input
    // behind the runner so the shell remains in the pinned owned group.
    stdio: fallback ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    detached: false
  });
  let releaseFallbackInput = (): void => {
    if (commandScriptPath !== null) rmSync(commandScriptPath, { force: true });
  };
  if (fallback) {
    const input = child.stdin;
    if (input === null) throw new Error('POSIX fallback shell input pipe is unavailable.');
    const ignoreClosedInput = (): void => undefined;
    let released = false;
    input.on('error', ignoreClosedInput);
    // The user's interactive shell owns its own interrupt policy. Injecting
    // Bourne-only trap syntax would corrupt fish, tcsh, and other valid shells.
    process.stdin.pipe(input);
    releaseFallbackInput = () => {
      if (released) return;
      released = true;
      process.stdin.unpipe(input);
      input.removeListener('error', ignoreClosedInput);
      if (commandScriptPath !== null) rmSync(commandScriptPath, { force: true });
    };
  }
  let currentResult: OwnedChildResult | null = null;
  const started = new Promise<void>((resolveStarted, reject) => {
    child.once('spawn', resolveStarted);
    child.once('error', error => {
      releaseFallbackInput();
      reject(error);
    });
  });
  const result = new Promise<OwnedChildResult>(resolveResult => {
    child.once('error', error => {
      releaseFallbackInput();
      currentResult = { code: null, signal: null, error };
      resolveResult(currentResult);
    });
    child.once('close', (code, signal) => {
      if (currentResult !== null) return;
      releaseFallbackInput();
      currentResult = { code, signal };
      resolveResult(currentResult);
    });
  });
  const owned: OwnedChild = {
    child,
    started,
    result,
    get currentResult() { return currentResult; },
    set currentResult(value) { currentResult = value; }
  };
  return owned;
}

function childExitStatus(result: OwnedChildResult): number {
  if (result.error) return 1;
  if (result.code !== null) return result.code;
  if (result.signal === null) return 1;
  const signalNumber = osConstants.signals[result.signal];
  return typeof signalNumber === 'number' ? 128 + signalNumber : 1;
}

function ownershipTokensExist(payload: PosixSidecarPayload): boolean {
  return existsSync(payload.targetTokenPath)
    && (payload.supervisorTokenPath === undefined || existsSync(payload.supervisorTokenPath));
}

async function waitForChildOrShutdown(
  payload: PosixSidecarPayload,
  owned: OwnedChild,
  shutdownRequested: () => boolean
): Promise<OwnedChildResult | null> {
  while (owned.currentResult === null) {
    if (shutdownRequested() || !ownershipTokensExist(payload)) return null;
    await delay(POLL_INTERVAL_MS);
  }
  return owned.currentResult;
}

async function drainOwnedGroup(
  payload: PosixSidecarPayload,
  reportStopping: () => Promise<void>,
  completionOnForcedExit: boolean,
  naturalCompletion = false
): Promise<void> {
  if (naturalCompletion) {
    try {
      const members = await inspectProcessGroup(process.pid);
      if (members.length === 1 && members[0] === process.pid) return;
    } catch {
      // Continue with conservative descendant cleanup.
    }
  }
  await reportStopping();
  process.kill(0, 'SIGTERM');
  const deadline = Date.now() + payload.gracefulShutdownMs;
  let consecutiveSoloSnapshots = 0;
  while (Date.now() < deadline) {
    try {
      const members = await inspectProcessGroup(process.pid);
      consecutiveSoloSnapshots = members.length === 1 && members[0] === process.pid
        ? consecutiveSoloSnapshots + 1
        : 0;
      if (consecutiveSoloSnapshots >= SOLO_SNAPSHOT_COUNT) return;
    } catch {
      // Membership snapshots are only an early-exit optimization. The wrapper's
      // post-exit ESRCH observation is the sole completion authority.
      consecutiveSoloSnapshots = 0;
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  writeForced(payload);
  if (completionOnForcedExit) writeRunnerCompletion(payload);
  process.kill(0, 'SIGKILL');
  await new Promise<never>(() => undefined);
}

export async function runPosixRunner(payload: PosixSidecarPayload): Promise<number> {
  if (process.platform === 'win32') throw new Error('POSIX controller cannot run on Windows.');
  const initialMembers = await inspectProcessGroup(process.pid);
  if (initialMembers.length !== 1 || initialMembers[0] !== process.pid) {
    throw new Error('POSIX controller runner does not exclusively lead its initial process group.');
  }
  if (!ownershipTokensExist(payload)) {
    throw new Error('POSIX controller ownership disappeared before readiness.');
  }

  let watch: ManagedSupervisorWatch | null = null;
  let shutdownRequested = false;
  let stoppingReported = false;
  let launched = false;
  const requestShutdown = (): void => { shutdownRequested = true; };
  const onSignal = (): void => requestShutdown();
  const onInterrupt = (): void => {
    // The foreground child receives the same terminal SIGINT. The group
    // leader absorbs its copy so Ctrl+C interrupts work without becoming a
    // supervisor shutdown request.
  };
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onSignal);

  const reportStopping = async (): Promise<void> => {
    if (stoppingReported) return;
    stoppingReported = true;
    try {
      await reportState(watch, payload, 'stopping');
    } catch {
      writeMarker(payload.stoppingPath, marker(payload, 'stopping'));
    }
  };

  try {
    if (payload.controlEndpoint && payload.authenticationToken) {
      watch = await watchManagedSupervisor({
        endpoint: payload.controlEndpoint,
        authenticationToken: payload.authenticationToken,
        requestId: randomUUID(),
        sessionId: payload.sessionId,
        targetId: payload.targetId,
        timeoutMs: 5_000
      });
      void watch.disconnected.then(requestShutdown);
    }

    if (shutdownRequested || !ownershipTokensExist(payload)) {
      throw new Error('POSIX controller ownership disappeared before target launch.');
    }

    let owned = spawnOwnedShell(payload, false);
    await owned.started;
    launched = true;
    await reportState(watch, payload, 'ready').catch(() => {
      writeMarker(payload.readyPath, marker(payload, 'ready'));
      requestShutdown();
    });

    let groupDrained = false;
    let result = await waitForChildOrShutdown(payload, owned, () => shutdownRequested);
    if (result === null) {
      await drainOwnedGroup(payload, reportStopping, true);
      groupDrained = true;
      result = await owned.result;
    }

    if (payload.exitMessage !== undefined) process.stdout.write(`\n${payload.exitMessage}\n`);
    let status = childExitStatus(result);
    if (!payload.exitAfterCommand && !shutdownRequested && ownershipTokensExist(payload)) {
      owned = spawnOwnedShell(payload, true);
      await owned.started;
      const fallbackResult = await waitForChildOrShutdown(payload, owned, () => shutdownRequested);
      if (fallbackResult === null) {
        await drainOwnedGroup(payload, reportStopping, true);
        groupDrained = true;
        status = childExitStatus(await owned.result);
      } else {
        status = childExitStatus(fallbackResult);
      }
    }

    if (!groupDrained) {
      await drainOwnedGroup(payload, async () => {
        if (shutdownRequested || !ownershipTokensExist(payload)) await reportStopping();
      }, true, true);
    }
    await watch?.close().catch(() => undefined);
    writeRunnerCompletion(payload);
    return status;
  } catch (error) {
    if (launched) {
      try {
        await drainOwnedGroup(payload, reportStopping, false);
      } catch {
        // The wrapper retains the record unless it later proves ESRCH. It never
        // replaces a failed self-signal with numeric-PGID kill authority.
      }
    }
    throw error;
  } finally {
    process.removeListener('SIGHUP', onSignal);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onSignal);
  }
}

export async function finalizePosixRunner(
  payload: PosixSidecarPayload,
  processGroupId: number,
  observedAbsent: boolean
): Promise<boolean> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('POSIX controller process group ID is invalid.');
  }
  // `failed` is a terminal acknowledgement, not merely a diagnostic. Never
  // publish it while the original group is present or identity is ambiguous.
  if (!observedAbsent || groupPresence(processGroupId) !== 'absent') return false;
  if (
    existsSync(payload.failedPath) ||
    !existsSync(payload.readyPath) ||
    !existsSync(runnerCompletionPath(payload))
  ) {
    if (!existsSync(payload.failedPath)) writeFailed(payload);
    rmSync(runnerCompletionPath(payload), { force: true });
    return false;
  }

  // The private marker is the authoritative local acknowledgement. Publish it
  // immediately after the wrapper's independent absence check instead of
  // delaying finalization on an optional supervisor reconnection: the server
  // may itself be awaiting this marker while processing a stop request.
  writeMarker(payload.stoppedPath, marker(payload, 'stopped'));
  rmSync(runnerCompletionPath(payload), { force: true });
  return true;
}

export async function waitAndFinalizePosixRunner(
  payload: PosixSidecarPayload,
  processGroupId: number
): Promise<boolean> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('POSIX controller process group ID is invalid.');
  }
  const deadline = Date.now() + payload.forcedConfirmationMs;
  for (;;) {
    if (probePosixGroupAbsence(processGroupId)) {
      // Finalization performs its own immediate absence recheck so a recycled
      // PGID can cause only a safe false failure, never a false acknowledgement.
      return await finalizePosixRunner(payload, processGroupId, true);
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return false;
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'probe') {
    process.exitCode = probePosixGroupAbsence(Number(process.argv[3])) ? 0 : 1;
    return;
  }
  const payloadPath = process.argv[3];
  if (!payloadPath) throw new Error('POSIX controller payload path is required.');
  const payload = readAndRemovePrivatePayloadFile(payloadPath);
  if (mode === 'run') {
    process.exitCode = await runPosixRunner(payload);
    return;
  }
  if (mode === 'wait-finalize') {
    process.exitCode = await waitAndFinalizePosixRunner(payload, Number(process.argv[4])) ? 0 : 1;
    return;
  }
  if (mode === 'finalize') {
    const processGroupId = Number(process.argv[4]);
    const observedAbsent = process.argv[5] === 'absent';
    process.exitCode = await finalizePosixRunner(payload, processGroupId, observedAbsent) ? 0 : 1;
    return;
  }
  throw new Error('POSIX controller mode is invalid.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`termhelm POSIX controller: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
