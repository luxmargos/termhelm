import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  killManagedTerminalWindows: vi.fn(),
  launchManagedTerminalWindows: vi.fn(),
  launchTerminalWindows: vi.fn()
}));

vi.mock('../src/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/index.js')>(),
  ...api
}));

import { runTerminalWindowsCli } from '../src/cli-runner.js';

const originalExitCode = process.exitCode;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  api.killManagedTerminalWindows.mockResolvedValue({
    status: 'killed',
    label: 'dev',
    sessionId: '00000000-0000-4000-8000-000000000001'
  });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    sink: {
      log: (message: string) => stdout.push(message),
      error: (message: string) => stderr.push(message)
    }
  };
}

function configFile(
  options?: Record<string, unknown>,
  targets: Record<string, unknown>[] = [{ title: 'api', command: 'pnpm dev' }]
): string {
  const directory = mkdtempSync(join(tmpdir(), 'termhelm-cli-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'termhelm.json');
  writeFileSync(path, JSON.stringify({
    targets,
    ...(options === undefined ? {} : { options })
  }));
  return path;
}

describe('CLI entry point', () => {
  it('uses plain launch when no inline label is present', async () => {
    const messages = output();
    await expect(runTerminalWindowsCli([
      'launch', '--title', 'api', '--command', 'pnpm dev'
    ], messages.sink)).resolves.toBe(0);

    expect(api.launchTerminalWindows).toHaveBeenCalledOnce();
    expect(api.launchManagedTerminalWindows).not.toHaveBeenCalled();
    expect(messages.stderr).toEqual([]);
  });

  it('uses managed launch when an inline label is present', async () => {
    const messages = output();
    await expect(runTerminalWindowsCli([
      'launch', '--label', 'dev', '--title', 'api', '--command', 'pnpm dev'
    ], messages.sink)).resolves.toBe(0);

    expect(api.launchManagedTerminalWindows).toHaveBeenCalledWith(
      [expect.objectContaining({ title: 'api', command: 'pnpm dev' })],
      expect.objectContaining({ label: 'dev', labelScope: { type: 'user' } })
    );
    expect(api.launchTerminalWindows).not.toHaveBeenCalled();
  });

  it('selects plain or managed config launch based on options.label', async () => {
    const messages = output();
    const plain = configFile({ exitAfterCommand: false });
    const managed = configFile({ label: 'dev' });

    await expect(runTerminalWindowsCli(['launch', '--config', plain], messages.sink)).resolves.toBe(0);
    expect(api.launchTerminalWindows).toHaveBeenCalledOnce();

    await expect(runTerminalWindowsCli(['launch', '--config', managed], messages.sink)).resolves.toBe(0);
    expect(api.launchManagedTerminalWindows).toHaveBeenCalledWith(
      [expect.objectContaining({ title: 'api' })],
      expect.objectContaining({ label: 'dev' })
    );
  });

  it('kills by an inline label', async () => {
    const messages = output();
    await expect(runTerminalWindowsCli(['kill', '--label', 'dev'], messages.sink)).resolves.toBe(0);

    expect(api.killManagedTerminalWindows).toHaveBeenCalledWith('dev', {
      labelScope: { type: 'user' },
      timeoutMs: undefined
    });
    expect(messages.stdout).toEqual(['Killed managed terminal session "dev".']);
    expect(messages.stderr).toEqual([]);
  });

  it('uses config identity and derived shutdown timing for kill without validating targets', async () => {
    const messages = output();
    const path = configFile({
      label: 'dev',
      labelScope: { type: 'project', root: '.' },
      shutdownDelayMs: 20_000,
      closeWaitTimeoutMs: 20_000
    }, [{ title: 'api', cwd: './missing-target-directory', command: 'pnpm dev' }]);

    await expect(runTerminalWindowsCli(['kill', '--config', path], messages.sink)).resolves.toBe(0);
    expect(api.killManagedTerminalWindows).toHaveBeenCalledWith('dev', {
      labelScope: { type: 'project', root: expect.any(String) },
      timeoutMs: 43_000
    });
  });

  it('reports a missing kill label as a CLI error', async () => {
    api.killManagedTerminalWindows.mockResolvedValueOnce({ status: 'not-found', label: 'missing' });
    const messages = output();
    const status = await runTerminalWindowsCli(['kill', '--label', 'missing'], messages.sink);

    expect(status).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(messages.stdout).toEqual([]);
    expect(messages.stderr).toEqual([
      'termhelm: No managed terminal session was found for label "missing".'
    ]);
  });
});
