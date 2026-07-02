import { spawn, spawnSync } from 'node:child_process';
import type { LinuxLauncher, TerminalLaunchOptions, TerminalTarget } from '../types.js';
import { buildPosixCommand, posixShellQuote } from '../shell.js';

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
      return (target, shell, posixCommand) => ({ command, args: ['--title', target.title, '--command', `${shell} -lc ${posixShellQuote(posixCommand)}`] });
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

export function launchLinuxTerminal(target: TerminalTarget, launcher: LinuxLauncher, options: TerminalLaunchOptions = {}): void {
  const shell = process.env.SHELL || '/bin/sh';
  const posixCommand = buildPosixCommand(target, options);
  const launchCommand = launcher(target, shell, posixCommand);
  const child = spawn(launchCommand.command, launchCommand.args, { detached: true, stdio: 'ignore' });
  child.unref();
}
