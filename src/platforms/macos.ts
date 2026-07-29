import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  InternalTerminalLaunchOptions,
  ResolvedTerminalTarget,
  TerminalUiCloseOutcome
} from '../types.js';
import { appleScriptString, buildPosixCommand, posixShellQuote } from '../shell.js';
import {
  abandonTerminalControl,
  createTerminalControlPaths,
  MarkerTerminalProcessController,
  TerminalControllerLaunchError,
  writeTerminalStateMarker,
  type TerminalControllerOptions,
  type TerminalProcessController
} from './controller.js';
import {
  buildCloseMacTerminalTabScript,
  closeMacTerminalTab,
  macTerminalTabState,
  waitForMacTerminalTabToSettle
} from './macos-auto-close.js';
import { macAutomationEnvironment, macInheritedTargetEnvironment } from './macos-environment.js';
import { cleanupPosixSidecarLaunch, createPosixSidecarLaunch } from './posix-sidecar.js';

export { buildCloseMacTerminalTabScript, closeMacTerminalTab } from './macos-auto-close.js';

const legacyMacTerminalIdentities = new Map<number, { windowId: number; tty: string }>();
let nextLegacyMacControllerId = 1;

interface MacTerminalIdentity {
  windowId: number | null;
  tty: string | null;
}

class MacTerminalMayHaveLaunchedError extends Error {}

export function parseMacTerminalIdentityOutput(output: string): { windowId: number; tty: string } {
  const identityParts = output.trim().split(/\r?\n/);
  const [windowIdText = '', tty = ''] = identityParts;
  const windowId = Number(windowIdText);
  if (
    identityParts.length !== 2 ||
    !/^[1-9][0-9]*$/.test(windowIdText) ||
    !Number.isSafeInteger(windowId) ||
    tty.length === 0
  ) {
    throw new MacTerminalMayHaveLaunchedError('Terminal launched but returned an invalid window identity.');
  }
  return { windowId, tty };
}

export interface MacTerminalController extends TerminalProcessController {
  readonly windowId: number | null;
  readonly tty: string | null;
}

class MacTerminalControllerImpl extends MarkerTerminalProcessController implements MacTerminalController {
  readonly windowId: number | null;
  readonly tty: string | null;

  constructor(
    control: ReturnType<typeof createTerminalControlPaths>,
    identity: MacTerminalIdentity,
    private readonly idleTimeoutMs: number,
    private readonly sidecarLaunch?: NonNullable<InternalTerminalLaunchOptions['posixSidecar']>
  ) {
    super(control);
    this.windowId = identity.windowId;
    this.tty = identity.tty;
  }

  override terminalUiOutcome(autoClose: boolean): TerminalUiCloseOutcome {
    if (!autoClose) return 'preserved';
    if (this.windowId === null || this.tty === null) return 'unsupported';
    let state = macTerminalTabState(this.windowId, this.tty);
    if (state === 'missing') return 'closed';
    if (state === 'shared') return 'refused-shared';
    if (state === 'unknown') return 'unsupported';
    if (state === 'busy' && !waitForMacTerminalTabToSettle(this.windowId, this.tty, this.idleTimeoutMs)) {
      state = macTerminalTabState(this.windowId, this.tty);
      if (state === 'missing') return 'closed';
      if (state === 'shared') return 'refused-shared';
      return 'host-managed';
    }
    return closeMacTerminalTab(this.windowId, this.tty);
  }

  override dispose(): void {
    if (this.sidecarLaunch) cleanupPosixSidecarLaunch(this.sidecarLaunch);
    super.dispose();
  }
}

function createMacTerminalLaunchCommand(
  command: string,
  control?: ReturnType<typeof createTerminalControlPaths>
): { command: string; launchScriptPath: string | null } {
  if (!control) return { command, launchScriptPath: null };

  const launchScriptPath = join(control.directory, `${control.id}.launch.sh`);
  if (/[\r\n]/.test(launchScriptPath)) {
    throw new Error('macOS Terminal launch paths cannot contain line breaks.');
  }
  writeFileSync(
    launchScriptPath,
    `/bin/rm -f ${posixShellQuote(launchScriptPath)}\n${command}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  return {
    command: `/bin/bash ${posixShellQuote(launchScriptPath)}`,
    launchScriptPath
  };
}

function launchMacTerminalIdentity(
  target: ResolvedTerminalTarget,
  options: InternalTerminalLaunchOptions,
  control?: ReturnType<typeof createTerminalControlPaths>
): MacTerminalIdentity {
  const launch = createMacTerminalLaunchCommand(buildPosixCommand(target, options, control), control);
  const result = (() => {
    try {
      return spawnSync('osascript', [
        '-e', 'tell application "Terminal"',
        '-e', `set targetTab to do script ${appleScriptString(launch.command)}`,
        '-e', `set custom title of targetTab to ${appleScriptString(target.title)}`,
        '-e', 'set targetTty to (tty of targetTab) as text',
        '-e', 'activate',
        '-e', 'repeat with candidateWindow in windows',
        '-e', '  repeat with candidateTab in tabs of candidateWindow',
        '-e', '    if ((tty of candidateTab) as text) is targetTty then',
        '-e', '      return (((id of candidateWindow) as text) & linefeed & targetTty)',
        '-e', '    end if',
        '-e', '  end repeat',
        '-e', 'end repeat',
        '-e', 'error "Unable to identify the launched Terminal tab by TTY."',
        '-e', 'end tell'
      ], { encoding: 'utf8', env: macAutomationEnvironment() });
    } catch (error) {
      if (launch.launchScriptPath) rmSync(launch.launchScriptPath, { force: true });
      throw error;
    }
  })();

  if (result.error) {
    if (launch.launchScriptPath) rmSync(launch.launchScriptPath, { force: true });
    throw new Error(`Failed to launch Terminal: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new MacTerminalMayHaveLaunchedError(
      `Terminal launch command failed with exit code ${result.status}.\n${result.stderr}`
    );
  }
  return parseMacTerminalIdentityOutput(result.stdout);
}

export function launchMacTerminal(target: ResolvedTerminalTarget, options: InternalTerminalLaunchOptions = {}): number | null {
  const identity = launchMacTerminalIdentity(target, options);
  if (identity.windowId !== null && identity.tty !== null) {
    while (legacyMacTerminalIdentities.has(nextLegacyMacControllerId)) nextLegacyMacControllerId += 1;
    const controllerId = nextLegacyMacControllerId;
    nextLegacyMacControllerId = Number.isSafeInteger(nextLegacyMacControllerId + 1) ? nextLegacyMacControllerId + 1 : 1;
    legacyMacTerminalIdentities.set(controllerId, { windowId: identity.windowId, tty: identity.tty });
    return controllerId;
  }
  return null;
}

function startMacTerminalAutoCloseWatcher(
  control: ReturnType<typeof createTerminalControlPaths>,
  identity: { windowId: number; tty: string },
  idleTimeoutMs: number
): void {
  const watcherTokenPath = join(control.directory, `${control.id}.auto-close-watcher`);
  writeFileSync(watcherTokenPath, `${control.sessionId}:${control.id}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
  const payload = Buffer.from(JSON.stringify({
    windowId: identity.windowId,
    tty: identity.tty,
    sessionId: control.sessionId,
    targetId: control.id,
    stoppedPath: control.stoppedPath,
    failedPath: control.failedPath,
    watcherTokenPath,
    idleTimeoutMs
  }), 'utf8').toString('base64url');
  const scriptPath = fileURLToPath(new URL('./macos-auto-close.js', import.meta.url));
  const watcher = spawn(process.execPath, [scriptPath, payload], {
    detached: true,
    stdio: 'ignore'
  });
  watcher.once('error', () => rmSync(watcherTokenPath, { force: true }));
  if (watcher.pid === undefined) {
    rmSync(watcherTokenPath, { force: true });
    throw new Error('Failed to start the macOS terminal auto-close watcher.');
  }
  watcher.unref();
}

export function launchMacTerminalController(
  target: ResolvedTerminalTarget,
  options: InternalTerminalLaunchOptions = {},
  controllerOptions: TerminalControllerOptions = {}
): MacTerminalController {
  const control = createTerminalControlPaths({
    ...controllerOptions,
    stateDirectory: controllerOptions.stateDirectory ?? options.shutdownStateDirectory,
    gracefulShutdownMs: controllerOptions.gracefulShutdownMs
  });
  let sidecarLaunch: NonNullable<InternalTerminalLaunchOptions['posixSidecar']> | undefined;
  try {
    sidecarLaunch = createPosixSidecarLaunch(
      target,
      control,
      options,
      macInheritedTargetEnvironment()
    );
    const controlledOptions: InternalTerminalLaunchOptions = { ...options, posixSidecar: sidecarLaunch };
    const identity = launchMacTerminalIdentity(target, controlledOptions, control);
    const idleTimeoutMs = options.closeWaitTimeoutMs ?? 6_000;
    const controller = new MacTerminalControllerImpl(control, identity, idleTimeoutMs, sidecarLaunch);
    const needsDetachedAutoClose = options.autoClose
      && options.supervisorPid === undefined
      && options.controlEndpoint === undefined;
    if (needsDetachedAutoClose && identity.windowId !== null && identity.tty !== null) {
      try {
        startMacTerminalAutoCloseWatcher(control, {
          windowId: identity.windowId,
          tty: identity.tty
        }, idleTimeoutMs);
      } catch (error) {
        controller.requestClose();
        throw new TerminalControllerLaunchError(
          'macOS Terminal launched but its auto-close watcher could not start.',
          controller,
          error
        );
      }
    }
    return controller;
  } catch (error) {
    if (error instanceof TerminalControllerLaunchError) throw error;
    if (error instanceof MacTerminalMayHaveLaunchedError) {
      const controller = new MacTerminalControllerImpl(control, { windowId: null, tty: null }, 0, sidecarLaunch);
      controller.requestClose();
      throw new TerminalControllerLaunchError(
        'macOS Terminal may have launched a target before identity capture failed.',
        controller,
        error
      );
    }
    if (sidecarLaunch) cleanupPosixSidecarLaunch(sidecarLaunch);
    try {
      writeTerminalStateMarker(control, 'failed');
    } catch {
      // Preserve the original launch failure.
    }
    abandonTerminalControl(control);
    throw error;
  }
}

function areMacTerminalWindowsIdle(windowIds: number[]): boolean {
  return windowIds.every(controllerId => {
    const identity = legacyMacTerminalIdentities.get(controllerId);
    if (!identity) return true;
    const state = macTerminalTabState(identity.windowId, identity.tty);
    return state === 'idle' || state === 'missing';
  });
}

export function waitForMacTerminalWindowsToSettle(windowIds: number[], _shutdownCompletePaths: string[], timeoutMs: number): void {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (areMacTerminalWindowsIdle(windowIds)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

export function closeMacTerminalWindows(windowIds: number[]): void {
  if (windowIds.length === 0) return;
  for (const controllerId of windowIds) {
    const identity = legacyMacTerminalIdentities.get(controllerId);
    if (!identity) continue;
    closeMacTerminalTab(identity.windowId, identity.tty);
    legacyMacTerminalIdentities.delete(controllerId);
  }
}
