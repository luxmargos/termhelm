import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn()
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: childProcess.spawn };
});

import {
  launchLinuxTerminalController,
  linuxLauncherForExecutable,
  resolveLinuxControllerShell,
  resolveLinuxLauncher
} from '../src/platforms/linux.js';
import { posixShellQuote } from '../src/shell.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'termhelm-linux-platform-'));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(path, 0o700);
}

afterEach(() => {
  childProcess.spawn.mockReset();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Linux terminal platform', () => {
  it('resolves a controller shell from PATH independently of the login shell', () => {
    const first = temporaryDirectory();
    const second = temporaryDirectory();
    const zsh = join(first, 'zsh');
    const bash = join(second, 'bash');
    executable(zsh);
    executable(bash);

    expect(resolveLinuxControllerShell({
      PATH: [first, second].join(delimiter),
      SHELL: '/usr/bin/fish'
    })).toBe(realpathSync(bash));

    rmSync(bash);
    expect(resolveLinuxControllerShell({
      PATH: [first, second].join(delimiter),
      SHELL: '/bin/dash'
    })).toBe(realpathSync(zsh));
    expect(resolveLinuxControllerShell({ PATH: second, SHELL: '/usr/bin/fish' })).toBeNull();
  });

  it('builds exact argv from verified emulator capabilities and resolves the Debian alternative', () => {
    const directory = temporaryDirectory();
    const target = { title: 'adapter title', cwd: directory, command: 'unused' };
    const shell = '/bin/bash';
    const command = ". '/private/launch.sh'";
    const expectations = [
      {
        id: 'gnome-terminal',
        args: ['--wait', '--title', target.title, '--', shell, '-lc', command],
        holdFlag: null
      },
      {
        id: 'konsole',
        args: ['--separate', '--hold', '-p', `tabtitle=${target.title}`, '-e', shell, '-lc', command],
        holdFlag: '--hold'
      },
      {
        id: 'xfce4-terminal',
        args: [
          '--disable-server', '--hold', '--title', target.title,
          '--command', `${posixShellQuote(shell)} -lc ${posixShellQuote(command)}`
        ],
        holdFlag: '--hold'
      },
      {
        id: 'xterm',
        args: ['-hold', '-T', target.title, '-e', shell, '-lc', command],
        holdFlag: '-hold'
      }
    ] as const;

    for (const expectation of expectations) {
      const path = join(directory, expectation.id);
      executable(path);
      const launcher = linuxLauncherForExecutable(path)!;
      expect(launcher.adapterId).toBe(expectation.id);
      expect(launcher.executable).toBe(realpathSync(path));
      expect(launcher(target, shell, command, { holdOpen: true })).toEqual({
        command: realpathSync(path),
        args: expectation.args
      });
      if (expectation.holdFlag === null) expect(launcher.capabilities?.holdOpen).toBe(false);
      else expect(launcher.capabilities?.holdOpen).toBe(true);
    }

    const alternative = join(directory, 'x-terminal-emulator');
    symlinkSync(join(directory, 'xterm'), alternative);
    expect(linuxLauncherForExecutable(alternative)?.adapterId).toBe('xterm');
  });

  it('fails closed for an unknown explicit TERMINAL even when a supported emulator is also on PATH', () => {
    const directory = temporaryDirectory();
    executable(join(directory, 'xterm'));
    executable(join(directory, 'custom-terminal'));
    expect(resolveLinuxLauncher({ PATH: directory, TERMINAL: 'custom-terminal' })).toBeNull();
    expect(resolveLinuxLauncher({ PATH: directory })?.adapterId).toBe('xterm');
  });

  it('passes only a private script path to the emulator and keeps secrets in mode-0600 payloads', () => {
    const terminalChild = Object.assign(new EventEmitter(), {
      pid: 4321,
      unref: vi.fn()
    });
    childProcess.spawn.mockReturnValue(terminalChild);
    let observedShell = '';
    let observedCommand = '';
    const launcher = vi.fn((_target: unknown, shell: string, command: string) => {
      observedShell = shell;
      observedCommand = command;
      return { command: '/fake-terminal', args: ['--', shell, '-lc', command] };
    });
    const secretCommand = 'printf termhelm-command-secret';
    const secretValue = 'termhelm-environment-secret';
    const controller = launchLinuxTerminalController({
      title: 'display title',
      cwd: temporaryDirectory(),
      command: secretCommand,
      env: { TERMHELM_SECRET: secretValue }
    }, launcher);
    const controlDirectory = dirname(controller.readyPath);

    try {
      expect(observedShell).toMatch(/(?:^|\/)bash$|(?:^|\/)zsh$/);
      expect(observedCommand).toMatch(/^\. '.+\.launch\.sh'$/);
      expect(observedCommand).not.toContain(secretCommand);
      expect(observedCommand).not.toContain(secretValue);
      const watcherCall = childProcess.spawn.mock.calls.at(-1)!;
      expect(watcherCall[0]).toBe(process.execPath);
      expect(watcherCall[1]).toEqual([
        expect.stringMatching(/linux-launcher-watch\.js$/),
        expect.stringMatching(/\.launcher-watch\.json$/)
      ]);
      expect(watcherCall[2]).toEqual({ detached: true, stdio: 'ignore' });
      const watcherPayloadPath = (watcherCall[1] as string[])[1]!;
      const watcherPayload = JSON.parse(readFileSync(watcherPayloadPath, 'utf8')) as {
        executable: string;
        args: string[];
      };
      expect(watcherPayload).toMatchObject({
        executable: '/fake-terminal',
        args: ['--', observedShell, '-lc', observedCommand]
      });
      expect(JSON.stringify(watcherPayload)).not.toContain(secretCommand);
      expect(JSON.stringify(watcherPayload)).not.toContain(secretValue);

      const launchScriptName = readdirSync(controlDirectory).find(name => name.endsWith('.launch.sh'));
      expect(launchScriptName).toBeDefined();
      const launchScriptPath = join(controlDirectory, launchScriptName!);
      expect(statSync(launchScriptPath).mode & 0o777).toBe(0o600);
      const launchScript = readFileSync(launchScriptPath, 'utf8');
      expect(launchScript).not.toContain(secretCommand);
      expect(launchScript).not.toContain(secretValue);

      const payloadFiles = readdirSync(controlDirectory).filter(name => name.endsWith('.payload'));
      expect(payloadFiles).toHaveLength(2);
      for (const name of payloadFiles) {
        expect(statSync(join(controlDirectory, name)).mode & 0o777).toBe(0o600);
      }
    } finally {
      terminalChild.emit('error', new Error('synthetic launcher failure'));
      expect(existsSync(controller.failedPath)).toBe(true);
      expect(readdirSync(controlDirectory).some(name => name.endsWith('.payload'))).toBe(false);
      expect(readdirSync(controlDirectory).some(name => name.endsWith('.launch.sh'))).toBe(false);
      controller.dispose();
    }
    expect(existsSync(controlDirectory)).toBe(false);
  });
});
