import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedTerminalLaunchOptions, TerminalLaunchOptions, TerminalTarget, TerminalWindowSession } from './types.js';
import { validateTerminalTarget } from './config.js';
import { closeMacTerminalWindows, launchMacTerminal, waitForMacTerminalWindowsToSettle } from './platforms/macos.js';
import { closeWindowsTerminalWindows, launchWindowsTerminal } from './platforms/windows.js';
import { launchLinuxTerminal, resolveLinuxLauncher } from './platforms/linux.js';
import { createSupervisorRecord, removeSupervisorRecordIfOwned, replacePreviousManagedTerminalWindows, shutdownCompletePath, writeSupervisorRecord } from './manager.js';

export type { LinuxLauncher, ManagedTerminalLaunchOptions, TerminalLaunchCommand, TerminalLaunchOptions, TerminalTarget, TerminalWindowSession, TerminalWindowsConfig } from './types.js';
export { readTerminalWindowsConfig, validateTerminalTarget, validateTerminalWindowsConfig } from './config.js';
export { appleScriptString, buildDefaultPosixCommand, buildPosixCommand, buildPosixEnvPrefix, buildSupervisedPosixCommand, posixShellQuote, powershellQuote, windowsCmdQuote, windowsEchoEscape } from './shell.js';

function noopTerminalWindowSession(): TerminalWindowSession {
  return { close() {} };
}

export function launchTerminalWindows(targets: TerminalTarget[], options: TerminalLaunchOptions = {}): TerminalWindowSession {
  const validatedTargets = targets.map((target, index) => validateTerminalTarget(target, `targets[${index}]`));
  if (process.platform === 'darwin') {
    const windowIds: number[] = [];
    const shutdownCompletePaths: string[] = [];
    for (const target of validatedTargets) {
      const launchOptions = { ...options };
      if (options.shutdownStateDirectory) {
        launchOptions.shutdownCompletePath = shutdownCompletePath(options.shutdownStateDirectory, target.title);
        shutdownCompletePaths.push(launchOptions.shutdownCompletePath);
      }
      const windowId = launchMacTerminal(target, launchOptions);
      if (windowId !== null) windowIds.push(windowId);
    }
    return {
      close() {
        waitForMacTerminalWindowsToSettle(windowIds, shutdownCompletePaths, options.closeWaitTimeoutMs ?? 6000);
        closeMacTerminalWindows(windowIds, { titles: validatedTargets.map(target => target.title), useCustomTitleClose: options.useMacTerminalCustomTitleClose });
      }
    };
  }
  if (process.platform === 'win32') {
    const pids: number[] = [];
    for (const target of validatedTargets) {
      const pid = launchWindowsTerminal(target, options);
      if (pid !== null) pids.push(pid);
    }
    return { close: () => closeWindowsTerminalWindows(pids) };
  }
  if (process.platform === 'linux') {
    const launcher = resolveLinuxLauncher();
    if (!launcher) throw new Error('No supported terminal emulator was found. Set TERMINAL or install gnome-terminal, konsole, xterm, or another supported terminal.');
    for (const target of validatedTargets) launchLinuxTerminal(target, launcher, options);
    return noopTerminalWindowSession();
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export function launchManagedTerminalWindows(targets: TerminalTarget[], options: ManagedTerminalLaunchOptions = {}): Promise<void> {
  const label = options.label ?? 'terminal-windows';
  const shutdownDelayMs = options.shutdownDelayMs ?? 2500;
  const closeWaitTimeoutMs = options.closeWaitTimeoutMs ?? 6000;
  const replaceTimeoutMs = options.replaceTimeoutMs ?? shutdownDelayMs + closeWaitTimeoutMs + 3000;
  const replaceLabels = options.replaceLabels ?? [label];
  replacePreviousManagedTerminalWindows(replaceLabels, label, replaceTimeoutMs);
  const directory = mkdtempSync(join(tmpdir(), 'terminal-windows-supervisor-'));
  const shutdownTokenPath = join(directory, 'alive');
  writeFileSync(shutdownTokenPath, `${process.pid}\n`, 'utf8');
  let isShuttingDown = false;
  let session: TerminalWindowSession = noopTerminalWindowSession();
  const removeShutdownToken = () => rmSync(shutdownTokenPath, { force: true });
  const removeShutdownDirectory = () => rmSync(directory, { recursive: true, force: true });
  const cleanup = (exitCode?: number): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    removeShutdownToken();
    setTimeout(() => {
      session.close();
      removeSupervisorRecordIfOwned(label, process.pid);
      removeShutdownDirectory();
      if (exitCode !== undefined) process.exit(exitCode);
    }, shutdownDelayMs).unref();
  };
  try {
    writeSupervisorRecord(label, createSupervisorRecord({ label, shutdownTokenPath, shutdownStateDirectory: directory, targets: targets.map(target => ({ title: target.title })) }));
    const launchOptions: TerminalLaunchOptions = { supervisorPid: process.pid, shutdownTokenPath, shutdownStateDirectory: directory, closeWaitTimeoutMs, useMacTerminalCustomTitleClose: options.useMacTerminalCustomTitleClose };
    if (options.exitAfterCommand !== undefined || process.platform === 'linux') launchOptions.exitAfterCommand = options.exitAfterCommand ?? true;
    session = launchTerminalWindows(targets, launchOptions);
  } catch (error) {
    removeShutdownToken();
    removeSupervisorRecordIfOwned(label, process.pid);
    removeShutdownDirectory();
    throw error;
  }
  return new Promise(resolve => {
    process.once('SIGINT', () => cleanup(130));
    process.once('SIGTERM', () => cleanup(143));
    process.once('SIGHUP', () => cleanup(129));
    process.once('beforeExit', () => cleanup());
    process.once('exit', () => {
      removeShutdownToken();
      removeSupervisorRecordIfOwned(label, process.pid);
    });
    const interval = setInterval(() => {
      if (!existsSync(shutdownTokenPath)) {
        cleanup();
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}
