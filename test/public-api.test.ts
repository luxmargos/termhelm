import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const managerActivity = vi.hoisted(() => ({
  ensureSessionDirectory: vi.fn(),
  writeSessionRecord: vi.fn()
}));

const controlActivity = vi.hoisted(() => {
  const close = vi.fn(async () => {});
  return {
    close,
    open: vi.fn(async (input: { endpoint: string }) => ({ endpoint: input.endpoint, close, closeGracefully: close }))
  };
});

const platformActivity = vi.hoisted(() => {
  const launchError = (): never => {
    throw new Error('Mock controller launch blocked by public API test.');
  };
  return {
    resolveLinuxLauncher: vi.fn(() => () => ({ command: 'mock-terminal', args: [] })),
    resolveWindowsControllerBackend: vi.fn(() => ({
      executable: 'powershell.exe',
      scriptPath: 'C:\\mock\\termhelm-controller.ps1'
    })),
    launchLinuxTerminalController: vi.fn(launchError),
    launchMacTerminalController: vi.fn(launchError),
    launchWindowsTerminalController: vi.fn(launchError)
  };
});

vi.mock('../src/manager.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/manager.js')>();
  return {
    ...actual,
    ensureManagedSessionDirectory: (...args: Parameters<typeof actual.ensureManagedSessionDirectory>) => {
      managerActivity.ensureSessionDirectory(...args);
      return actual.ensureManagedSessionDirectory(...args);
    },
    writeManagedSessionRecord: (...args: Parameters<typeof actual.writeManagedSessionRecord>) => {
      managerActivity.writeSessionRecord(...args);
      return actual.writeManagedSessionRecord(...args);
    }
  };
});

vi.mock('../src/control.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/control.js')>();
  return { ...actual, openManagedControlServer: controlActivity.open };
});

vi.mock('../src/platforms/linux.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/platforms/linux.js')>();
  return {
    ...actual,
    resolveLinuxLauncher: platformActivity.resolveLinuxLauncher,
    launchLinuxTerminalController: platformActivity.launchLinuxTerminalController
  };
});

vi.mock('../src/platforms/macos.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/platforms/macos.js')>();
  return { ...actual, launchMacTerminalController: platformActivity.launchMacTerminalController };
});

vi.mock('../src/platforms/windows.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/platforms/windows.js')>();
  return {
    ...actual,
    resolveWindowsControllerBackend: platformActivity.resolveWindowsControllerBackend,
    launchWindowsTerminalController: platformActivity.launchWindowsTerminalController
  };
});

import {
  launchDetachedManagedTerminalWindows,
  launchManagedTerminalWindows,
  launchTerminalWindows,
  MANAGED_TERMINAL_LABEL_ERROR,
  readTerminalWindowsConfig,
  startManagedTerminalWindows
} from '../src/index.js';
import { parseTerminalWindowsCliArgs } from '../src/cli-core.js';

const temporaryDirectories: string[] = [];
const target = { title: 'display only', command: 'mock command' };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed public API boundary', () => {
  it('throws synchronously for a missing label before any managed side effect', async () => {
    const listenerCounts = new Map(
      ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map(event => [event, process.listenerCount(event)])
    );

    expect(() => startManagedTerminalWindows([target], undefined as never)).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
    await expect(launchManagedTerminalWindows([target], undefined as never)).rejects.toThrow(MANAGED_TERMINAL_LABEL_ERROR);
    await expect(launchDetachedManagedTerminalWindows([target], undefined as never)).rejects.toThrow(
      MANAGED_TERMINAL_LABEL_ERROR
    );

    expect(managerActivity.ensureSessionDirectory).not.toHaveBeenCalled();
    expect(managerActivity.writeSessionRecord).not.toHaveBeenCalled();
    expect(controlActivity.open).not.toHaveBeenCalled();
    expect(platformActivity.resolveLinuxLauncher).not.toHaveBeenCalled();
    expect(platformActivity.resolveWindowsControllerBackend).not.toHaveBeenCalled();
    expect(platformActivity.launchLinuxTerminalController).not.toHaveBeenCalled();
    expect(platformActivity.launchMacTerminalController).not.toHaveBeenCalled();
    expect(platformActivity.launchWindowsTerminalController).not.toHaveBeenCalled();
    for (const [event, count] of listenerCounts) expect(process.listenerCount(event)).toBe(count);
  });

  it('returns the documented session shape and confirms mocked launch rollback', async () => {
    const exitListenersBefore = process.listenerCount('exit');
    const session = startManagedTerminalWindows([target], {
      label: `public-api-${randomUUID()}`,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 100,
      replaceTimeoutMs: 2_000
    });

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session.label).toMatch(/^public-api-/);
    expect(session.ready).toBeInstanceOf(Promise);
    expect(session.closed).toBeInstanceOf(Promise);
    expect(session.close).toBeTypeOf('function');
    expect(process.listenerCount('exit')).toBe(exitListenersBefore + 1);

    await expect(session.ready).rejects.toThrow('Mock controller launch blocked');
    const closed = await session.closed;
    expect(closed).toMatchObject({ reason: 'launch-failed', forcedTargetIds: [], warnings: [] });
    expect(closed.uiCloseResults).toHaveLength(1);
    expect(closed.uiCloseResults[0]?.outcome).toBe('unsupported');
    await expect(session.close()).resolves.toBe(closed);
    expect(managerActivity.ensureSessionDirectory).toHaveBeenCalledTimes(1);
    expect(managerActivity.writeSessionRecord).toHaveBeenCalledTimes(1);
    expect(controlActivity.open).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('exit')).toBe(exitListenersBefore);
  });

  it('resolves config project roots from the config file and inline roots from cwd', () => {
    const directory = mkdtempSync(join(tmpdir(), 'termhelm-public-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'termhelm.json');
    writeFileSync(configPath, JSON.stringify({
      targets: [{ title: 'api', cwd: '.', command: 'mock command' }],
      options: { label: 'dev', labelScope: { type: 'project', root: '.' } }
    }));

    const config = readTerminalWindowsConfig(configPath);
    const inline = parseTerminalWindowsCliArgs([
      'launch',
      '--label', 'dev',
      '--label-scope', 'project',
      '--project-root', '.',
      '--title', 'api',
      '--cwd', '.',
      '--command', 'mock command'
    ]);

    expect(config.options?.labelScope).toEqual({ type: 'project', root: realpathSync(directory) });
    expect(inline.managedOptions?.labelScope).toEqual({ type: 'project', root: realpathSync(process.cwd()) });
    expect(config.options?.labelScope).not.toEqual(inline.managedOptions?.labelScope);
  });
});

describe('plain and packaged public API boundary', () => {
  it('does not pass raw JavaScript controller metadata into a plain launch', async () => {
    const controller = {
      id: randomUUID(),
      readyPath: '/mock/ready',
      stoppingPath: '/mock/stopping',
      stoppedPath: '/mock/stopped',
      failedPath: '/mock/failed',
      forcedPath: '/mock/forced',
      requestClose: vi.fn(),
      waitUntilReady: vi.fn(() => true),
      waitUntilStopped: vi.fn(() => true),
      wasForced: vi.fn(() => false),
      close: vi.fn(() => true),
      dispose: vi.fn()
    };
    const launch = process.platform === 'darwin'
      ? platformActivity.launchMacTerminalController
      : process.platform === 'win32'
        ? platformActivity.launchWindowsTerminalController
        : platformActivity.launchLinuxTerminalController;
    launch.mockReturnValueOnce(controller);

    const session = launchTerminalWindows([target], {
      autoClose: true,
      exitAfterCommand: false,
      supervisorPid: 123,
      shutdownTokenPath: '/untrusted/alive',
      shutdownStateDirectory: '/untrusted/state'
    } as never);

    const call = launch.mock.calls.at(-1);
    const passedOptions = call?.[process.platform === 'linux' ? 2 : 1];
    expect(passedOptions).toEqual({ autoClose: true, exitAfterCommand: false });
    if (process.platform === 'linux') {
      expect(call?.[1]).toBe(platformActivity.resolveLinuxLauncher.mock.results.at(-1)?.value);
    } else if (process.platform === 'win32') {
      expect(call?.[2]).toEqual({});
      expect(call?.[3]).toBe(platformActivity.resolveWindowsControllerBackend.mock.results.at(-1)?.value);
    }
    expect(session.closed).toBeInstanceOf(Promise);
    session.close();
    await expect(session.closed).resolves.toEqual({
      uiCloseResults: [{ targetId: controller.id, outcome: 'unsupported' }],
      warnings: []
    });
    expect(controller.close).toHaveBeenCalledTimes(1);
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports natural plain completion and UI outcome without requiring close()', async () => {
    let stopped = false;
    const controller = {
      id: randomUUID(),
      readyPath: '/mock/ready',
      stoppingPath: '/mock/stopping',
      stoppedPath: '/mock/stopped',
      failedPath: '/mock/failed',
      forcedPath: '/mock/forced',
      requestClose: vi.fn(),
      waitUntilReady: vi.fn(() => true),
      waitUntilStopped: vi.fn(() => stopped),
      wasForced: vi.fn(() => false),
      terminalUiOutcome: vi.fn(() => 'preserved' as const),
      close: vi.fn(() => true),
      dispose: vi.fn()
    };
    const launch = process.platform === 'darwin'
      ? platformActivity.launchMacTerminalController
      : process.platform === 'win32'
        ? platformActivity.launchWindowsTerminalController
        : platformActivity.launchLinuxTerminalController;
    launch.mockReturnValueOnce(controller);
    const session = launchTerminalWindows([target], { autoClose: false });
    stopped = true;

    await expect(session.closed).resolves.toEqual({
      uiCloseResults: [{ targetId: controller.id, outcome: 'preserved' }],
      warnings: []
    });
    expect(controller.close).not.toHaveBeenCalled();
    expect(controller.terminalUiOutcome).toHaveBeenCalledWith(false);
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it('starts unreferenced plain completion cleanup even when closed is never accessed', async () => {
    let stopped = false;
    const controller = {
      id: randomUUID(),
      readyPath: '/mock/ready',
      stoppingPath: '/mock/stopping',
      stoppedPath: '/mock/stopped',
      failedPath: '/mock/failed',
      forcedPath: '/mock/forced',
      requestClose: vi.fn(),
      waitUntilReady: vi.fn(() => true),
      waitUntilStopped: vi.fn(() => stopped),
      wasForced: vi.fn(() => false),
      terminalUiOutcome: vi.fn(() => 'preserved' as const),
      close: vi.fn(() => true),
      dispose: vi.fn()
    };
    const launch = process.platform === 'darwin'
      ? platformActivity.launchMacTerminalController
      : process.platform === 'win32'
        ? platformActivity.launchWindowsTerminalController
        : platformActivity.launchLinuxTerminalController;
    launch.mockReturnValueOnce(controller);
    launchTerminalWindows([target], { autoClose: false });
    stopped = true;

    await vi.waitFor(() => expect(controller.dispose).toHaveBeenCalledOnce());
    expect(controller.terminalUiOutcome).toHaveBeenCalledWith(false);
  });

  it('settles plain completion with warnings when UI reporting and disposal fail', async () => {
    const controller = {
      id: randomUUID(),
      readyPath: '/mock/ready',
      stoppingPath: '/mock/stopping',
      stoppedPath: '/mock/stopped',
      failedPath: '/mock/failed',
      forcedPath: '/mock/forced',
      requestClose: vi.fn(),
      waitUntilReady: vi.fn(() => true),
      waitUntilStopped: vi.fn(() => true),
      wasForced: vi.fn(() => false),
      terminalUiOutcome: vi.fn(() => { throw new Error('UI unavailable'); }),
      close: vi.fn(() => true),
      dispose: vi.fn(() => { throw new Error('cleanup unavailable'); })
    };
    const launch = process.platform === 'darwin'
      ? platformActivity.launchMacTerminalController
      : process.platform === 'win32'
        ? platformActivity.launchWindowsTerminalController
        : platformActivity.launchLinuxTerminalController;
    launch.mockReturnValueOnce(controller);
    const session = launchTerminalWindows([target], { autoClose: true });

    const result = await session.closed;
    expect(result.uiCloseResults).toEqual([{ targetId: controller.id, outcome: 'unsupported' }]);
    expect(result.warnings).toEqual([
      expect.stringContaining('UI unavailable'),
      expect.stringContaining('cleanup unavailable')
    ]);
  });

  it('allows a plain session to retry a close that was not yet acknowledged', () => {
    const controller = {
      id: randomUUID(),
      readyPath: '/mock/ready',
      stoppingPath: '/mock/stopping',
      stoppedPath: '/mock/stopped',
      failedPath: '/mock/failed',
      forcedPath: '/mock/forced',
      requestClose: vi.fn(),
      waitUntilReady: vi.fn(() => true),
      waitUntilStopped: vi.fn(() => true),
      wasForced: vi.fn(() => false),
      close: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      dispose: vi.fn()
    };
    const launch = process.platform === 'darwin'
      ? platformActivity.launchMacTerminalController
      : process.platform === 'win32'
        ? platformActivity.launchWindowsTerminalController
        : platformActivity.launchLinuxTerminalController;
    launch.mockReturnValueOnce(controller);
    const session = launchTerminalWindows([target]);
    expect(() => session.close()).toThrow('could not be closed safely');
    expect(controller.dispose).not.toHaveBeenCalled();
    expect(() => session.close()).not.toThrow();
    expect(controller.close).toHaveBeenCalledTimes(2);
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it('rolls back all plain targets when a later target does not become ready', () => {
    const makeController = (ready: boolean) => ({
      id: randomUUID(),
      readyPath: '/mock/ready',
      stoppingPath: '/mock/stopping',
      stoppedPath: '/mock/stopped',
      failedPath: '/mock/failed',
      forcedPath: '/mock/forced',
      requestClose: vi.fn(),
      waitUntilReady: vi.fn(() => ready),
      waitUntilStopped: vi.fn(() => true),
      wasForced: vi.fn(() => false),
      close: vi.fn(() => true),
      dispose: vi.fn()
    });
    const first = makeController(true);
    const second = makeController(false);
    const launch = process.platform === 'darwin'
      ? platformActivity.launchMacTerminalController
      : process.platform === 'win32'
        ? platformActivity.launchWindowsTerminalController
        : platformActivity.launchLinuxTerminalController;
    launch.mockReturnValueOnce(first).mockReturnValueOnce(second);

    expect(() => launchTerminalWindows([target, { ...target, title: 'second' }])).toThrow(
      'did not acknowledge readiness'
    );
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it('exports only the ESM root and package metadata subpath', () => {
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(metadata.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './package.json': './package.json'
    });
    expect(JSON.stringify(metadata.exports)).not.toContain('require');
    expect(Object.keys(metadata.exports).some(key => key.startsWith('./dist/'))).toBe(false);
  });
});
