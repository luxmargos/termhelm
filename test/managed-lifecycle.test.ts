import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fakePlatform = vi.hoisted(() => {
  interface FakeController {
    id: string;
    sessionId: string;
    active: boolean;
    onRequestClose?: () => void;
    corruptStoppedMarker(): void;
    finish(forced?: boolean): void;
  }
  const controllers: FakeController[] = [];
  let overlapDetected = false;
  let afterLaunch: ((model: FakeController, controller: Record<string, unknown>) => void) | undefined;

  function writeMarker(options: Record<string, unknown>, state: 'ready' | 'stopped' | 'forced'): void {
    const path = options[`${state}Path`] as string;
    const temporaryPath = `${path}.${process.pid}.test.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({
      version: 2,
      sessionId: options.sessionId,
      targetId: options.id,
      state,
      updatedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  const launch = vi.fn((_target: unknown, _launchOptions: unknown, options: Record<string, unknown>) => {
    const sessionId = options.sessionId as string;
    if (controllers.some(controller => controller.active && controller.sessionId !== sessionId)) {
      overlapDetected = true;
    }
    const model: FakeController = {
      id: options.id as string,
      sessionId,
      active: true,
      corruptStoppedMarker() {
        writeFileSync(options.stoppedPath as string, '{malformed', { mode: 0o600 });
      },
      finish(forced = false) {
        if (!this.active) return;
        if (forced) writeMarker(options, 'forced');
        writeMarker(options, 'stopped');
        this.active = false;
      }
    };
    controllers.push(model);
    writeMarker(options, 'ready');
    const controller = {
      id: model.id,
      readyPath: options.readyPath,
      stoppingPath: options.stoppingPath,
      stoppedPath: options.stoppedPath,
      failedPath: options.failedPath,
      forcedPath: options.forcedPath,
      requestClose: vi.fn(() => model.onRequestClose ? model.onRequestClose() : model.finish()),
      waitUntilReady: vi.fn(() => true),
      waitUntilStopped: vi.fn(() => !model.active),
      wasForced: vi.fn(() => false),
      close: vi.fn(() => {
        if (model.onRequestClose) model.onRequestClose();
        else model.finish();
        return !model.active;
      }),
      dispose: vi.fn()
    };
    afterLaunch?.(model, controller);
    return controller;
  });

  return {
    controllers,
    launch,
    reset() {
      controllers.splice(0);
      overlapDetected = false;
      afterLaunch = undefined;
      launch.mockClear();
    },
    setAfterLaunch(callback: ((model: FakeController, controller: Record<string, unknown>) => void) | undefined) {
      afterLaunch = callback;
    },
    overlapDetected: () => overlapDetected
  };
});

vi.mock('../src/platforms/macos.js', () => ({ launchMacTerminalController: fakePlatform.launch }));
vi.mock('../src/platforms/linux.js', () => ({
  launchLinuxTerminalController: fakePlatform.launch,
  resolveLinuxLauncher: () => () => ({ command: 'fake-terminal', args: [] })
}));
vi.mock('../src/platforms/windows.js', () => ({
  launchWindowsTerminalController: fakePlatform.launch,
  resolveWindowsControllerBackend: () => ({
    kind: 'native',
    helperPath: 'C:\\fake\\terminal-windows-controller.exe'
  }),
  resolveWindowsControllerHelperPath: () => 'C:\\fake\\terminal-windows-controller.exe'
}));

import { launchManagedTerminalWindows, startManagedTerminalWindows } from '../src/managed.js';
import { TerminalControllerLaunchError, type TerminalProcessController } from '../src/platforms/controller.js';
import {
  readManagedLaunchIntents,
  removeManagedSessionRecordIfOwned,
  resolveManagedLabelIdentity,
  managedTerminalRuntimeDirectory,
  withManagedLabelLocks
} from '../src/manager.js';

const target = (title: string) => ({ title, cwd: process.cwd(), command: 'fake command' });

describe('managed lifecycle state machine', () => {
  it('starts the replacement deadline only after platform backend preflight', () => {
    const source = readFileSync('src/managed.ts', 'utf8');
    const initializeStart = source.indexOf('private async initialize(): Promise<void>');
    const initializeSource = source.slice(initializeStart, source.indexOf('\n  private ', initializeStart + 1));
    const preflightIndex = initializeSource.indexOf('const platformBackend = preflightManagedBackend()');
    const deadlineIndex = initializeSource.indexOf('const deadline = Date.now() + this.replaceTimeoutMs');
    const locksIndex = initializeSource.indexOf('await withManagedLabelLocks(');

    expect(initializeStart).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(deadlineIndex).toBeGreaterThan(preflightIndex);
    expect(locksIndex).toBeGreaterThan(deadlineIndex);
  });

  it('handles wrapper shutdown signals and restores signal listeners', async () => {
    fakePlatform.reset();
    const previousExitCode = process.exitCode;
    const listenerCounts = new Map(
      ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, process.listenerCount(signal)])
    );
    try {
      const operation = launchManagedTerminalWindows([target('signal')], {
        label: `signal-${randomUUID()}`,
        shutdownDelayMs: 0,
        closeWaitTimeoutMs: 500,
        replaceTimeoutMs: 3_000
      });
      while (!fakePlatform.controllers.some(controller => controller.active)) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      process.emit('SIGTERM', 'SIGTERM');
      await expect(operation).resolves.toBeUndefined();
      expect(fakePlatform.controllers.some(controller => controller.active)).toBe(false);
      expect(process.exitCode).toBe(143);
      for (const [signal, count] of listenerCounts) {
        expect(process.listenerCount(signal)).toBe(count);
      }
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('replaces by authenticated label acknowledgement without old/new overlap or title selection', async () => {
    fakePlatform.reset();
    const label = `lifecycle-${randomUUID()}`;
    const first = startManagedTerminalWindows([target('duplicate'), target('duplicate')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 500,
      replaceTimeoutMs: 3_000
    });
    await first.ready;

    const latest = startManagedTerminalWindows([target('renamed display title')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 500,
      replaceTimeoutMs: 3_000
    });
    await latest.ready;
    await expect(first.closed).resolves.toMatchObject({ reason: 'replaced' });
    expect(fakePlatform.overlapDetected()).toBe(false);
    expect(fakePlatform.launch).toHaveBeenCalledTimes(3);

    const result = await latest.close();
    await expect(latest.close()).resolves.toBe(result);
    expect(result.reason).toBe('closed');
    expect(readManagedLaunchIntents(resolveManagedLabelIdentity(label))).toEqual([
      expect.objectContaining({ sessionId: latest.id })
    ]);
  });

  it('observes natural completion only after every target UUID is stopped', async () => {
    fakePlatform.reset();
    const session = startManagedTerminalWindows([target('same'), target('same')], {
      label: `natural-${randomUUID()}`,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 500,
      replaceTimeoutMs: 3_000
    });
    await session.ready;
    const owned = fakePlatform.controllers.filter(controller => controller.sessionId === session.id);
    expect(owned).toHaveLength(2);
    owned[0]!.finish();
    let closed = false;
    void session.closed.then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    owned[1]!.finish();
    await expect(session.closed).resolves.toMatchObject({ reason: 'target-exited' });
  });

  it('hands off a naturally stopped predecessor without deleting its owner evidence', async () => {
    fakePlatform.reset();
    const label = `natural-handoff-${randomUUID()}`;
    const first = startManagedTerminalWindows([target('duplicate')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 500,
      replaceTimeoutMs: 3_000
    });
    await first.ready;
    fakePlatform.controllers.find(controller => controller.sessionId === first.id)!.finish();

    const replacement = startManagedTerminalWindows([target('duplicate')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 500,
      replaceTimeoutMs: 3_000
    });
    await replacement.ready;
    await expect(first.closed).resolves.toMatchObject({ reason: expect.stringMatching(/target-exited|replaced/) });
    expect(fakePlatform.overlapDetected()).toBe(false);
    await replacement.close();
  });

  it('makes the newest of three queued same-label contenders the only launcher', async () => {
    fakePlatform.reset();
    const label = `contenders-${randomUUID()}`;
    const identity = resolveManagedLabelIdentity(label);
    let releaseLock!: () => void;
    let lockEntered!: () => void;
    const entered = new Promise<void>(resolve => { lockEntered = resolve; });
    const gate = new Promise<void>(resolve => { releaseLock = resolve; });
    const blocker = withManagedLabelLocks([identity], 5_000, async () => {
      lockEntered();
      await gate;
    });
    await entered;

    const older = startManagedTerminalWindows([target('same')], { label, replaceTimeoutMs: 4_000 });
    const middle = startManagedTerminalWindows([target('same')], { label, replaceTimeoutMs: 4_000 });
    const latest = startManagedTerminalWindows([target('same')], { label, replaceTimeoutMs: 4_000 });
    releaseLock();
    await blocker;

    await expect(older.ready).rejects.toThrow('superseded');
    await expect(middle.ready).rejects.toThrow('superseded');
    await latest.ready;
    expect(fakePlatform.controllers.filter(controller => controller.active)).toHaveLength(1);
    expect(fakePlatform.controllers[0]?.sessionId).toBe(latest.id);
    expect(fakePlatform.overlapDetected()).toBe(false);
    await latest.close();
  });

  it('rolls back a contender superseded while target readiness is awaited', async () => {
    fakePlatform.reset();
    const label = `readiness-contender-${randomUUID()}`;
    let latest: ReturnType<typeof startManagedTerminalWindows> | undefined;
    fakePlatform.setAfterLaunch(() => {
      fakePlatform.setAfterLaunch(undefined);
      latest = startManagedTerminalWindows([target('same')], {
        label,
        shutdownDelayMs: 0,
        closeWaitTimeoutMs: 500,
        replaceTimeoutMs: 3_000
      });
    });

    const older = startManagedTerminalWindows([target('same')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 500,
      replaceTimeoutMs: 3_000
    });

    await expect(older.ready).rejects.toThrow('superseded');
    expect(latest).toBeDefined();
    await latest!.ready;
    await expect(older.closed).resolves.toMatchObject({ reason: 'launch-failed' });
    expect(fakePlatform.controllers.filter(controller => controller.active)).toHaveLength(1);
    expect(fakePlatform.controllers.find(controller => controller.active)?.sessionId).toBe(latest!.id);
    expect(fakePlatform.overlapDetected()).toBe(false);
    await latest!.close();
  });

  it('rolls back every earlier target when a later target launch fails', async () => {
    fakePlatform.reset();
    let launchCount = 0;
    fakePlatform.setAfterLaunch((_model, controller) => {
      launchCount += 1;
      if (launchCount === 2) {
        throw new TerminalControllerLaunchError(
          'Second target launch failed after controller creation.',
          controller as unknown as TerminalProcessController,
          new Error('mock second-target failure')
        );
      }
    });

    const session = startManagedTerminalWindows([target('first'), target('second')], {
      label: `partial-rollback-${randomUUID()}`,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 500,
      replaceTimeoutMs: 3_000
    });
    await expect(session.ready).rejects.toThrow('Second target launch failed');
    await expect(session.closed).resolves.toMatchObject({ reason: 'launch-failed' });
    expect(fakePlatform.controllers).toHaveLength(2);
    expect(fakePlatform.controllers.some(controller => controller.active)).toBe(false);
    fakePlatform.setAfterLaunch(undefined);
  });

  it('rolls back live targets when lock release fails after publication', async () => {
    fakePlatform.reset();
    const label = `release-failure-${randomUUID()}`;
    const identity = resolveManagedLabelIdentity(label);
    const lockPath = join(managedTerminalRuntimeDirectory(), 'locks', `${identity.key}.lock`);
    fakePlatform.setAfterLaunch(() => {
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
        version: 2,
        lockId: randomUUID(),
        pid: process.pid,
        createdAt: new Date().toISOString()
      }), { mode: 0o600 });
    });

    const session = startManagedTerminalWindows([target('rollback')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 200,
      replaceTimeoutMs: 500
    });
    await expect(session.ready).rejects.toThrow('release managed terminal label locks');
    await expect(session.closed).resolves.toMatchObject({ reason: 'launch-failed' });
    expect(fakePlatform.controllers).toHaveLength(1);
    expect(fakePlatform.controllers[0]!.active).toBe(false);
    fakePlatform.setAfterLaunch(undefined);
    rmSync(lockPath, { recursive: true, force: true });
  });

  it('settles ready rejection even when rollback marker inspection fails', async () => {
    fakePlatform.reset();
    const label = `marker-failure-${randomUUID()}`;
    const identity = resolveManagedLabelIdentity(label);
    const lockPath = join(managedTerminalRuntimeDirectory(), 'locks', `${identity.key}.lock`);
    fakePlatform.setAfterLaunch(() => {
      const controller = fakePlatform.controllers.at(-1)!;
      controller.onRequestClose = () => controller.corruptStoppedMarker();
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
        version: 2,
        lockId: randomUUID(),
        pid: process.pid,
        createdAt: new Date().toISOString()
      }), { mode: 0o600 });
    });

    const session = startManagedTerminalWindows([target('rollback')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 75,
      replaceTimeoutMs: 500
    });
    await expect(session.ready).rejects.toThrow(/release|rollback/i);

    const controller = fakePlatform.controllers.at(-1)!;
    controller.onRequestClose = undefined;
    controller.finish();
    fakePlatform.setAfterLaunch(undefined);
    rmSync(lockPath, { recursive: true, force: true });
    await expect(session.close()).resolves.toMatchObject({ reason: 'closed' });
  });

  it('requests shutdown from every target even when one request throws', async () => {
    fakePlatform.reset();
    const session = startManagedTerminalWindows([target('one'), target('two')], {
      label: `close-errors-${randomUUID()}`,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 75,
      replaceTimeoutMs: 1_000
    });
    await session.ready;
    const owned = fakePlatform.controllers.filter(controller => controller.sessionId === session.id);
    owned[0]!.onRequestClose = () => {
      throw new Error('first close failed');
    };

    await expect(session.close()).rejects.toThrow('could not confirm every owned process tree stopped');
    expect(owned[0]!.active).toBe(true);
    expect(owned[1]!.active).toBe(false);
    owned[0]!.onRequestClose = undefined;
    owned[0]!.finish();
    await expect(session.close()).resolves.toMatchObject({ reason: 'closed' });
  });

  it('fails closed when a captured predecessor record disappears without termination evidence', async () => {
    fakePlatform.reset();
    const label = `ambiguous-${randomUUID()}`;
    const first = startManagedTerminalWindows([target('unchanged')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 75,
      replaceTimeoutMs: 300
    });
    await first.ready;
    const predecessor = fakePlatform.controllers.find(controller => controller.sessionId === first.id)!;
    predecessor.onRequestClose = () => {
      removeManagedSessionRecordIfOwned(resolveManagedLabelIdentity(label), first.id);
    };

    const replacement = startManagedTerminalWindows([target('same or different title is irrelevant')], {
      label,
      shutdownDelayMs: 0,
      closeWaitTimeoutMs: 75,
      replaceTimeoutMs: 300
    });
    await expect(replacement.ready).rejects.toThrow(/Refusing|confirm|acknowledge/i);
    await expect(replacement.closed).resolves.toMatchObject({ reason: 'launch-failed' });
    expect(predecessor.active).toBe(true);
    expect(fakePlatform.launch).toHaveBeenCalledTimes(1);

    predecessor.onRequestClose = undefined;
    await first.close();
  });
});
