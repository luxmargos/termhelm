import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchMacTerminalController } from '../src/platforms/macos.js';

const manualEnabled = process.platform === 'darwin'
  && process.env.TERMHELM_MANUAL_MACOS === '1';
const temporaryDirectories: string[] = [];

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
