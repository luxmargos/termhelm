import { spawnSync } from 'node:child_process';
import type { InternalTerminalLaunchOptions, ResolvedTerminalTarget } from '../types.js';
import { appleScriptString, buildPosixCommand } from '../shell.js';
import {
  abandonTerminalControl,
  createTerminalControlPaths,
  MarkerTerminalProcessController,
  TerminalControllerLaunchError,
  writeTerminalStateMarker,
  type TerminalControllerOptions,
  type TerminalProcessController
} from './controller.js';
import { createPosixSidecarLaunch } from './posix-sidecar.js';

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

  constructor(control: ReturnType<typeof createTerminalControlPaths>, identity: MacTerminalIdentity) {
    super(control);
    this.windowId = identity.windowId;
    this.tty = identity.tty;
  }

  override close(timeoutMs = 6000): boolean {
    const stopped = super.close(timeoutMs);
    if (stopped && this.windowId !== null && this.tty !== null) {
      closeMacTerminalTab(this.windowId, this.tty);
    }
    return stopped;
  }
}

function launchMacTerminalIdentity(
  target: ResolvedTerminalTarget,
  options: InternalTerminalLaunchOptions,
  control?: ReturnType<typeof createTerminalControlPaths>
): MacTerminalIdentity {
  const command = buildPosixCommand(target, options, control);
  const result = spawnSync('osascript', [
    '-e', 'tell application "Terminal"',
    '-e', `set targetTab to do script ${appleScriptString(command)}`,
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
  ], { encoding: 'utf8' });

  if (result.error) throw new Error(`Failed to launch Terminal: ${result.error.message}`);
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
  try {
    const controlledOptions: InternalTerminalLaunchOptions = {
      ...options,
      posixSidecar: createPosixSidecarLaunch(target, control, options)
    };
    return new MacTerminalControllerImpl(control, launchMacTerminalIdentity(target, controlledOptions, control));
  } catch (error) {
    if (error instanceof MacTerminalMayHaveLaunchedError) {
      const controller = new MacTerminalControllerImpl(control, { windowId: null, tty: null });
      controller.requestClose();
      throw new TerminalControllerLaunchError(
        'macOS Terminal may have launched a target before identity capture failed.',
        controller,
        error
      );
    }
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
  const ownedWindowIds = windowIds
    .map(controllerId => legacyMacTerminalIdentities.get(controllerId)?.windowId)
    .filter((windowId): windowId is number => windowId !== undefined);
  if (ownedWindowIds.length === 0) return true;
  const result = spawnSync('osascript', [
    '-e', 'tell application "Terminal"',
    '-e', `set targetWindowIds to {${ownedWindowIds.join(',')}}`,
    '-e', 'repeat with targetWindowId in targetWindowIds',
    '-e', '  try',
    '-e', '    set targetWindow to first window whose id is targetWindowId',
    '-e', '    repeat with targetTab in tabs of targetWindow',
    '-e', '      if busy of targetTab then return "busy"',
    '-e', '    end repeat',
    '-e', '  end try',
    '-e', 'end repeat',
    '-e', 'return "idle"',
    '-e', 'end tell'
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return false;
  return result.stdout.trim() === 'idle';
}

export function waitForMacTerminalWindowsToSettle(windowIds: number[], _shutdownCompletePaths: string[], timeoutMs: number): void {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (areMacTerminalWindowsIdle(windowIds)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

export function buildCloseMacTerminalTabScript(windowId: number, tty: string): string[] {
  return [
    'tell application "Terminal"',
    `set targetWindowId to ${Number(windowId)}`,
    `set targetTty to ${appleScriptString(tty)}`,
    'try',
    '  set targetWindow to first window whose id is targetWindowId',
    '  repeat with targetTab in tabs of targetWindow',
    '    if tty of targetTab is targetTty then',
    '      close targetTab',
    '      return',
    '    end if',
    '  end repeat',
    'end try',
    'end tell'
  ];
}

export function closeMacTerminalTab(windowId: number, tty: string): void {
  const script = buildCloseMacTerminalTabScript(windowId, tty);
  spawnSync('osascript', script.flatMap(line => ['-e', line]), { stdio: 'ignore' });
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
