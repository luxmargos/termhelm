import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
