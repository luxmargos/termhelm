import { spawn, spawnSync } from 'node:child_process';
import type { InternalTerminalLaunchOptions, LinuxLauncher, ResolvedTerminalTarget } from '../types.js';
import { buildPosixCommand, posixShellQuote } from '../shell.js';
import {
  abandonTerminalControl,
  createTerminalControlPaths,
  MarkerTerminalProcessController,
  writeTerminalStateMarker,
  type TerminalControllerOptions,
  type TerminalProcessController
} from './controller.js';
import { createPosixSidecarLaunch } from './posix-sidecar.js';

export interface LinuxTerminalController extends TerminalProcessController {
  readonly launcherPid: number | null;
}

class LinuxTerminalControllerImpl extends MarkerTerminalProcessController implements LinuxTerminalController {
  readonly launcherPid: number | null;

  constructor(control: ReturnType<typeof createTerminalControlPaths>, launcherPid: number | null) {
    super(control);
    this.launcherPid = launcherPid;
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-lc', `command -v ${posixShellQuote(command)} >/dev/null 2>&1`], { stdio: 'ignore' });
  return result.status === 0;
}

function linuxLauncherFor(command: string): LinuxLauncher {
  const basename = command.split('/').pop() ?? command;
  switch (basename) {
    case 'gnome-terminal':
    case 'kgx':
      return (target, shell, posixCommand) => ({ command, args: ['--title', target.title, '--', shell, '-lc', posixCommand] });
    case 'konsole':
      return (target, shell, posixCommand) => ({ command, args: ['--new-tab', '--title', target.title, '-e', shell, '-lc', posixCommand] });
    case 'xfce4-terminal':
      return (target, shell, posixCommand) => ({
        command,
        args: ['--title', target.title, '--command', `${posixShellQuote(shell)} -lc ${posixShellQuote(posixCommand)}`]
      });
    case 'mate-terminal':
      return (target, shell, posixCommand) => ({ command, args: ['--title', target.title, '--', shell, '-lc', posixCommand] });
    case 'lxterminal':
      return (target, shell, posixCommand) => ({ command, args: ['--title', target.title, '-e', shell, '-lc', posixCommand] });
    case 'xterm':
    case 'x-terminal-emulator':
      return (target, shell, posixCommand) => ({ command, args: ['-T', target.title, '-e', shell, '-lc', posixCommand] });
    default:
      return (_target, shell, posixCommand) => ({ command, args: ['-e', shell, '-lc', posixCommand] });
  }
}

export function resolveLinuxLauncher(): LinuxLauncher | null {
  const terminal = process.env.TERMINAL;
  if (terminal && commandExists(terminal)) return linuxLauncherFor(terminal);
  for (const command of ['gnome-terminal', 'kgx', 'konsole', 'xfce4-terminal', 'mate-terminal', 'lxterminal', 'xterm', 'x-terminal-emulator']) {
    if (commandExists(command)) return linuxLauncherFor(command);
  }
  return null;
}

export function launchLinuxTerminalController(
  target: ResolvedTerminalTarget,
  launcher: LinuxLauncher,
  options: InternalTerminalLaunchOptions = {},
  controllerOptions: TerminalControllerOptions = {}
): LinuxTerminalController {
  const control = createTerminalControlPaths({
    ...controllerOptions,
    stateDirectory: controllerOptions.stateDirectory ?? options.shutdownStateDirectory,
    gracefulShutdownMs: controllerOptions.gracefulShutdownMs
  });
  const shell = process.env.SHELL || '/bin/sh';
  const controlledOptions: InternalTerminalLaunchOptions = {
    ...options,
    posixSidecar: createPosixSidecarLaunch(target, control, options)
  };
  const posixCommand = buildPosixCommand(target, controlledOptions, control);
  const launchCommand = launcher(target, shell, posixCommand);
  try {
    const child = spawn(launchCommand.command, launchCommand.args, { detached: true, stdio: 'ignore' });
    if (child.pid === undefined) {
      // Node reports many exec failures asynchronously. Consume that event,
      // but fail synchronously before a controller can claim readiness.
      child.once('error', () => undefined);
      throw new Error(`Failed to start Linux terminal launcher: ${launchCommand.command}`);
    }
    const controller = new LinuxTerminalControllerImpl(control, child.pid ?? null);
    child.once('error', error => {
      controller.requestClose();
      try {
        writeTerminalStateMarker(control, 'failed');
      } catch {
        // The owning supervisor may already have removed the state directory.
      }
    });
    child.unref();
    return controller;
  } catch (error) {
    try {
      writeTerminalStateMarker(control, 'failed');
    } catch {
      // Preserve the original launch failure.
    }
    abandonTerminalControl(control);
    throw error;
  }
}

export function launchLinuxTerminal(target: ResolvedTerminalTarget, launcher: LinuxLauncher, options: InternalTerminalLaunchOptions = {}): void {
  const shell = process.env.SHELL || '/bin/sh';
  const posixCommand = buildPosixCommand(target, options);
  const launchCommand = launcher(target, shell, posixCommand);
  const child = spawn(launchCommand.command, launchCommand.args, { detached: true, stdio: 'ignore' });
  child.unref();
}
