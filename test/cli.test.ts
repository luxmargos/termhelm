import { afterEach, describe, expect, it } from 'vitest';
import { MANAGED_TERMINAL_LABEL_ERROR } from '../src/config.js';
import { runTerminalWindowsCli } from '../src/cli-runner.js';

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe('CLI entry point', () => {
  it('prefixes a missing managed label error and returns status 1', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = await runTerminalWindowsCli([
      'managed',
      '--title', 'api',
      '--cwd', '.',
      '--command', 'pnpm dev'
    ], {
      log: message => stdout.push(message),
      error: message => stderr.push(message)
    });

    expect(status).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([`terminal-windows: ${MANAGED_TERMINAL_LABEL_ERROR}`]);
  });
});
