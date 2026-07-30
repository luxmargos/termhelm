import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  killManagedTerminalWindows,
  launchDetachedManagedTerminalWindows
} from '../src/index.js';
import { launchDetachedManagedTerminalWindowsWithHooks } from '../src/detached.js';
import { launchMacTerminalController } from '../src/platforms/macos.js';
import { posixShellQuote } from '../src/shell.js';

const manualEnabled = process.platform === 'darwin'
  && process.env.TERMHELM_MANUAL_MACOS === '1';
const temporaryDirectories: string[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for macOS detached lifecycle state.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(!manualEnabled)('manual Terminal.app identity verification', () => {
  it('preserves the caller PATH through a real Terminal login shell', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'termhelm-macos-path-'));
    temporaryDirectories.push(stateDirectory);
    const executableDirectory = join(stateDirectory, 'bin');
    const executablePath = join(executableDirectory, 'termhelm-runtime-probe');
    mkdirSync(executableDirectory);
    const outputPath = join(stateDirectory, 'resolved-runtime.txt');
    writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(executablePath, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${executableDirectory}${delimiter}${previousPath ?? ''}`;
    let controller: ReturnType<typeof launchMacTerminalController> | undefined;
    try {
      controller = launchMacTerminalController(
        {
          title: 'termhelm manual PATH check',
          cwd: process.cwd(),
          command: `command -v termhelm-runtime-probe > '${outputPath}'`
        },
        { exitAfterCommand: true, autoClose: true },
        { stateDirectory, gracefulShutdownMs: 100 }
      );
      expect(controller.waitUntilReady(10_000)).toBe(true);
      expect(controller.waitUntilStopped(10_000)).toBe(true);
      expect(readFileSync(outputPath, 'utf8').trim()).toBe(executablePath);
      expect(controller.terminalUiOutcome(true)).toBe('closed');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      controller?.requestClose();
      controller?.waitUntilStopped(10_000);
      controller?.dispose();
    }
  }, 30_000);

  it('survives launcher return, cleans targets after abrupt hidden-supervisor death, and recovers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'termhelm-macos-detached-'));
    temporaryDirectories.push(directory);
    const label = `macos-detached-${randomUUID()}`;
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
      closeWaitTimeoutMs: 3_000,
      replaceTimeoutMs: 6_000,
      autoClose: true
    } as const;

    try {
      let supervisorPid: number | undefined;
      await launchDetachedManagedTerminalWindowsWithHooks([{
        title: 'TermHelm hidden detached macOS supervisor',
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
        title: 'TermHelm recovered detached macOS supervisor',
        cwd: directory,
        command: command('recovered')
      }], options);
      await waitFor(() => existsSync(join(directory, 'recovered-started')));
      await expect(killManagedTerminalWindows(label, { timeoutMs: 6_000 })).resolves.toMatchObject({
        status: 'killed'
      });
      await waitFor(() => existsSync(join(directory, 'recovered-stopped')));
    } finally {
      await killManagedTerminalWindows(label, { timeoutMs: 6_000 }).catch(() => undefined);
    }
  }, 60_000);

  it('captures a real window/TTY pair and closes that exact tab', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'termhelm-macos-manual-'));
    temporaryDirectories.push(stateDirectory);
    const controller = launchMacTerminalController(
      {
        title: 'termhelm manual identity check',
        cwd: process.cwd(),
        command: 'sleep 30'
      },
      { exitAfterCommand: true },
      { stateDirectory, gracefulShutdownMs: 100 }
    );
    try {
      expect(controller.waitUntilReady(10_000)).toBe(true);
      expect(controller.windowId).toBeTypeOf('number');
      expect(controller.tty).toMatch(/^\/dev\//);
      expect(controller.close(10_000)).toBe(true);
      expect(controller.terminalUiOutcome(true)).toBe('closed');
    } finally {
      controller.requestClose();
      controller.waitUntilStopped(10_000);
      controller.dispose();
    }
  }, 30_000);
});
