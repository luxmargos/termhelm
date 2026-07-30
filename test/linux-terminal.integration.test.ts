import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  killManagedTerminalWindows,
  launchDetachedManagedTerminalWindows,
  launchTerminalWindows,
  startManagedTerminalWindows
} from '../src/index.js';
import { launchDetachedManagedTerminalWindowsWithHooks } from '../src/detached.js';
import { posixShellQuote } from '../src/shell.js';

const xterm = process.platform === 'linux'
  ? spawnSync('sh', ['-lc', 'command -v xterm'], { encoding: 'utf8' }).stdout.trim()
  : '';
const enabled = process.platform === 'linux'
  && process.env.TERMHELM_LINUX_GUI_TEST === '1'
  && Boolean(process.env.DISPLAY)
  && xterm.length > 0;
const temporaryDirectories: string[] = [];
const originalTerminal = process.env.TERMINAL;
const originalShell = process.env.SHELL;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'termhelm-linux-gui-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Linux terminal integration state.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  if (originalTerminal === undefined) delete process.env.TERMINAL;
  else process.env.TERMINAL = originalTerminal;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(!enabled)('native Linux xterm lifecycle', () => {
  it('launches through Xvfb/xterm, reaches readiness, and observes natural completion', async () => {
    process.env.TERMINAL = xterm;
    const directory = temporaryDirectory();
    const completedPath = join(directory, 'completed');
    const session = launchTerminalWindows([{
      title: 'TermHelm xterm natural completion',
      cwd: directory,
      command: `: > ${posixShellQuote(completedPath)}`
    }], { autoClose: true });

    await waitFor(() => existsSync(completedPath));
    await expect(session.closed).resolves.toMatchObject({
      uiCloseResults: [{ outcome: 'closed' }]
    });
  }, 30_000);

  it('preserves an xterm through native hold-open behavior when autoClose is false', async () => {
    process.env.TERMINAL = xterm;
    const directory = temporaryDirectory();
    const session = launchTerminalWindows([{
      title: 'TermHelm xterm hold',
      cwd: directory,
      command: 'exit 0'
    }], { autoClose: false });

    await expect(session.closed).resolves.toMatchObject({
      uiCloseResults: [{ outcome: 'preserved' }]
    });
    spawnSync('pkill', ['-TERM', 'xterm'], { stdio: 'ignore' });
  }, 30_000);

  it('runs target scripts with bash, zsh, dash, and fish while retaining the private controller shell', async () => {
    process.env.TERMINAL = xterm;
    const shells = ['bash', 'zsh', 'dash', 'fish'].map(name => ({
      name,
      path: spawnSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
    }));
    expect(shells.every(shell => shell.path.length > 0), JSON.stringify(shells)).toBe(true);
    for (const shell of shells) {
      process.env.SHELL = shell.path;
      const directory = temporaryDirectory();
      const outputPath = join(directory, `${shell.name}.txt`);
      const session = launchTerminalWindows([{
        title: `TermHelm ${shell.name} target shell`,
        cwd: directory,
        command: `printf '%s' ${shell.name} > ${posixShellQuote(outputPath)}`
      }], { autoClose: true });
      await session.closed;
      expect(existsSync(outputPath)).toBe(true);
    }
  }, 30_000);

  it('fails closed and cleans private launch state when an exact launcher rejects before start', () => {
    const directory = temporaryDirectory();
    const rejectingXterm = join(directory, 'xterm');
    writeFileSync(rejectingXterm, '#!/bin/sh\nexit 7\n', 'utf8');
    chmodSync(rejectingXterm, 0o700);
    process.env.TERMINAL = rejectingXterm;
    expect(() => launchTerminalWindows([{
      title: 'TermHelm rejected xterm',
      cwd: directory,
      command: 'exit 0'
    }], { autoClose: true })).toThrow('did not acknowledge readiness');
  }, 30_000);

  it('keeps a detached supervisor hidden, fails closed on abrupt supervisor death, and recovers the label', async () => {
    process.env.TERMINAL = xterm;
    const directory = temporaryDirectory();
    const label = `linux-detached-${randomUUID()}`;
    const lifecycleScript = join(directory, 'detached-lifecycle.mjs');
    writeFileSync(lifecycleScript, [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const [directory, generation] = process.argv.slice(2);',
      "writeFileSync(join(directory, generation + '-started'), String(process.pid));",
      "const stop = () => { writeFileSync(join(directory, generation + '-stopped'), 'stopped'); process.exit(0); };",
      "process.on('SIGTERM', stop);",
      "process.on('SIGHUP', stop);",
      'setInterval(() => {}, 1000);'
    ].join('\n'));
    const command = (generation: string) => [
      posixShellQuote(process.execPath),
      posixShellQuote(lifecycleScript),
      posixShellQuote(directory),
      posixShellQuote(generation)
    ].join(' ');
    const options = {
      label,
      shutdownDelayMs: 100,
      closeWaitTimeoutMs: 2_000,
      replaceTimeoutMs: 5_000,
      autoClose: true
    } as const;

    try {
      let supervisorPid: number | undefined;
      await launchDetachedManagedTerminalWindowsWithHooks([{
        title: 'TermHelm hidden detached Linux supervisor',
        cwd: directory,
        command: command('first')
      }], options, {
        onSupervisorSpawn: pid => { supervisorPid = pid; }
      });
      await waitFor(() => existsSync(join(directory, 'first-started')));
      expect(supervisorPid).toBeTypeOf('number');
      process.kill(supervisorPid!, 'SIGKILL');
      await waitFor(() => existsSync(join(directory, 'first-stopped')));

      await launchDetachedManagedTerminalWindows([{
        title: 'TermHelm recovered detached Linux supervisor',
        cwd: directory,
        command: command('recovered')
      }], options);
      await waitFor(() => existsSync(join(directory, 'recovered-started')));
      await expect(killManagedTerminalWindows(label, { timeoutMs: 5_000 })).resolves.toMatchObject({
        status: 'killed'
      });
      await waitFor(() => existsSync(join(directory, 'recovered-stopped')));
    } finally {
      await killManagedTerminalWindows(label, { timeoutMs: 5_000 }).catch(() => undefined);
    }
  }, 45_000);

  it('replaces an authenticated managed xterm tree and confirms forced cleanup', async () => {
    process.env.TERMINAL = xterm;
    const directory = temporaryDirectory();
    const label = `linux-xterm-${randomUUID()}`;
    const stubbornCommand = `${posixShellQuote(process.execPath)} -e ${posixShellQuote(
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"
    )}`;
    const first = startManagedTerminalWindows([{
      title: 'TermHelm xterm first',
      cwd: directory,
      command: stubbornCommand
    }], {
      label,
      shutdownDelayMs: 50,
      closeWaitTimeoutMs: 2_000,
      replaceTimeoutMs: 5_000,
      autoClose: true
    });
    await first.ready;

    const replacement = startManagedTerminalWindows([{
      title: 'TermHelm xterm replacement',
      cwd: directory,
      command: 'exit 0'
    }], {
      label,
      shutdownDelayMs: 50,
      closeWaitTimeoutMs: 2_000,
      replaceTimeoutMs: 5_000,
      autoClose: true
    });
    await replacement.ready;
    const replaced = await first.closed;
    expect(replaced.reason).toBe('replaced');
    expect(replaced.forcedTargetIds).toHaveLength(1);
    await replacement.closed;
  }, 30_000);
});
