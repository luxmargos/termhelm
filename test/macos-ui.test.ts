import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 4242, once: vi.fn(), unref: vi.fn() })),
  spawnSync: vi.fn()
}));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync
}));

import { closeMacTerminalTab, launchMacTerminalController } from '../src/platforms/macos.js';
import {
  buildMacTerminalTabStateScript,
  markerIsAuthoritative,
  waitForMacTerminalTabToSettle
} from '../src/platforms/macos-auto-close.js';

describe('mocked macOS Terminal UI cleanup', () => {
  beforeEach(() => {
    childProcess.spawn.mockClear();
    childProcess.spawnSync.mockReset();
  });

  it('closes only the owned window matching both captured window ID and TTY', () => {
    closeMacTerminalTab(731, '/dev/ttys042');

    expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
    const [executable, args, options] = childProcess.spawnSync.mock.calls[0]!;
    expect(executable).toBe('osascript');
    expect(options).toEqual({ stdio: 'ignore' });
    const script = (args as string[]).filter((_, index) => index % 2 === 1).join('\n');
    expect(script).toContain('targetWindowId to 731');
    expect(script).toContain('targetTty to "/dev/ttys042"');
    expect(script).toContain('first window whose id is targetWindowId');
    expect(script).toContain('tty of targetTab as text) is targetTty');
    expect(script).toContain('count of tabs of targetWindow) is not 1');
    expect(script).toContain('if busy of targetTab then return');
    expect(script).toContain('close targetWindow');
    expect(script).not.toContain('custom title');
  });

  it('builds idle detection from exact window ID and TTY without title selection', () => {
    const script = buildMacTerminalTabStateScript(731, '/dev/ttys042').join('\n');
    expect(script).toContain('first window whose id is targetWindowId');
    expect(script).toContain('tty of targetTab as text) is targetTty');
    expect(script).toContain('count of tabs of targetWindow) is not 1');
    expect(script).toContain('busy of targetTab');
    expect(script).not.toContain('custom title');
  });

  it('refuses shared windows immediately and honors cancellation before polling', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: 'shared\n', stderr: '', error: undefined });
    expect(waitForMacTerminalTabToSettle(731, '/dev/ttys042', 6_000)).toBe(false);
    expect(childProcess.spawnSync).toHaveBeenCalledOnce();

    childProcess.spawnSync.mockClear();
    expect(waitForMacTerminalTabToSettle(731, '/dev/ttys042', 6_000, () => true)).toBe(false);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('starts a detached exact-identity watcher when autoClose is enabled', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '731\n/dev/ttys042\n',
      stderr: '',
      error: undefined
    });
    const controller = launchMacTerminalController(
      { title: 'auto close', cwd: process.cwd(), command: 'exit 0' },
      { autoClose: true, closeWaitTimeoutMs: 3210 }
    );
    const controlDirectory = dirname(controller.readyPath);

    try {
      expect(childProcess.spawn).toHaveBeenCalledOnce();
      const [executable, args, options] = childProcess.spawn.mock.calls[0]!;
      expect(executable).toBe(process.execPath);
      expect((args as string[])[0]).toMatch(/macos-auto-close\.js$/);
      const payload = JSON.parse(Buffer.from((args as string[])[1]!, 'base64url').toString('utf8'));
      expect(payload).toMatchObject({
        windowId: 731,
        tty: '/dev/ttys042',
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        targetId: controller.id,
        stoppedPath: controller.stoppedPath,
        failedPath: controller.failedPath,
        watcherTokenPath: join(controlDirectory, `${controller.id}.auto-close-watcher`),
        idleTimeoutMs: 3210
      });
      expect(existsSync(payload.watcherTokenPath)).toBe(true);
      expect(statSync(payload.watcherTokenPath).mode & 0o777).toBe(0o600);
      expect(options).toEqual({ detached: true, stdio: 'ignore' });
      expect(JSON.stringify(payload)).not.toContain('auto close');
    } finally {
      rmSync(controlDirectory, { recursive: true, force: true });
    }
  });

  it('rejects malformed or wrong-identity completion markers before UI closure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'termhelm-macos-marker-'));
    const markerPath = join(directory, 'stopped.json');
    const payload = {
      windowId: 731,
      tty: '/dev/ttys042',
      sessionId: '11111111-1111-4111-8111-111111111111',
      targetId: '22222222-2222-4222-8222-222222222222',
      stoppedPath: markerPath,
      failedPath: join(directory, 'failed.json'),
      watcherTokenPath: join(directory, 'watcher'),
      idleTimeoutMs: 100
    };
    try {
      writeFileSync(markerPath, '{malformed', { mode: 0o600 });
      expect(markerIsAuthoritative(markerPath, payload, 'stopped')).toBe(false);
      writeFileSync(markerPath, JSON.stringify({
        version: 2,
        sessionId: payload.sessionId,
        targetId: '33333333-3333-4333-8333-333333333333',
        state: 'stopped',
        updatedAt: new Date().toISOString()
      }), { mode: 0o600 });
      expect(markerIsAuthoritative(markerPath, payload, 'stopped')).toBe(false);
      writeFileSync(markerPath, JSON.stringify({
        version: 2,
        sessionId: payload.sessionId,
        targetId: payload.targetId,
        state: 'stopped',
        updatedAt: new Date().toISOString()
      }), { mode: 0o600 });
      expect(markerIsAuthoritative(markerPath, payload, 'stopped')).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the live managed supervisor for auto-close instead of a detached watcher', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '731\n/dev/ttys042\n',
      stderr: '',
      error: undefined
    });
    const controller = launchMacTerminalController(
      { title: 'managed auto close', cwd: process.cwd(), command: 'exit 0' },
      { autoClose: true, supervisorPid: 123 }
    );
    const controlDirectory = dirname(controller.readyPath);
    try {
      expect(childProcess.spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(controlDirectory, { recursive: true, force: true });
    }
  });

  it('does not start an auto-close watcher by default', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '731\n/dev/ttys042\n',
      stderr: '',
      error: undefined
    });
    const controller = launchMacTerminalController({
      title: 'preserve terminal',
      cwd: process.cwd(),
      command: 'exit 0'
    });
    const controlDirectory = dirname(controller.readyPath);
    try {
      expect(childProcess.spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(controlDirectory, { recursive: true, force: true });
    }
  });

  it('sources managed launch logic from a private script instead of submitting multiline shell input', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '731\n/dev/ttys042\n',
      stderr: '',
      error: undefined
    });

    const controller = launchMacTerminalController({
      title: 'private launch',
      cwd: process.cwd(),
      command: 'printf managed-command-sentinel',
      env: { TERMHELM_SECRET_SENTINEL: 'private-value' }
    });
    const controlDirectory = dirname(controller.readyPath);
    const launchScriptPath = join(controlDirectory, `${controller.id}.launch.sh`);

    try {
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
      const [executable, args, options] = childProcess.spawnSync.mock.calls[0]!;
      expect(executable).toBe('osascript');
      expect(options).toEqual({ encoding: 'utf8' });
      const doScript = (args as string[]).find(argument => argument.startsWith('set targetTab to do script '));
      expect(doScript).toBeDefined();
      expect(doScript).toBe(`set targetTab to do script ". '${launchScriptPath}'"`);
      expect(doScript).not.toMatch(/[\r\n]/);
      expect(doScript).not.toContain('termhelm_runner_');
      expect(doScript).not.toContain('managed-command-sentinel');
      expect(doScript).not.toContain('TERMHELM_SECRET_SENTINEL');

      expect(existsSync(launchScriptPath)).toBe(true);
      expect(statSync(launchScriptPath).mode & 0o777).toBe(0o600);
      const launchScript = readFileSync(launchScriptPath, 'utf8');
      expect(launchScript.startsWith(`/bin/rm -f '${launchScriptPath}'\n`)).toBe(true);
      expect(launchScript).toContain(`termhelm_runner_${controller.id.replace(/-/g, '_')}`);
    } finally {
      rmSync(controlDirectory, { recursive: true, force: true });
    }
  });

  it('removes the private launch script when osascript cannot start', () => {
    const controlDirectory = mkdtempSync(join(tmpdir(), 'termhelm-macos-ui-'));
    childProcess.spawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('osascript is unavailable')
    });

    try {
      expect(() => launchMacTerminalController(
        {
          title: 'failed private launch',
          cwd: process.cwd(),
          command: 'exit 0'
        },
        {},
        { controlDirectory }
      )).toThrow('Failed to launch Terminal: osascript is unavailable');
      expect(readdirSync(controlDirectory).some(name => name.endsWith('.launch.sh'))).toBe(false);
    } finally {
      rmSync(controlDirectory, { recursive: true, force: true });
    }
  });
});
