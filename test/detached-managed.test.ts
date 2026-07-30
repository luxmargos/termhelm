import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const spawnActivity = vi.hoisted(() => ({ spawn: vi.fn() }));
const managedActivity = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnActivity.spawn };
});

vi.mock('../src/managed.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/managed.js')>();
  return { ...actual, runManagedTerminalSupervisor: managedActivity.run };
});

import {
  DETACHED_MANAGED_BOOTSTRAP_TIMEOUT_MS,
  DETACHED_MANAGED_PROTOCOL_VERSION,
  launchDetachedManagedTerminalWindows,
  runDetachedManagedTerminalSupervisorChild
} from '../src/detached.js';
import { MANAGED_TERMINAL_LABEL_ERROR } from '../src/config.js';

const nonce = 'a'.repeat(43);
const target = (command = 'node server.js') => ({
  title: 'detached test',
  cwd: process.cwd(),
  command,
  env: { DETACHED_TEST_SECRET: 'not-for-argv' }
});

class FakeChild extends EventEmitter {
  connected = true;
  pid = 12345;
  readonly sent: unknown[] = [];
  readonly disconnect = vi.fn(() => { this.connected = false; });
  readonly unref = vi.fn();
  readonly kill = vi.fn(() => true);
  readonly send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
    this.sent.push(message);
    callback?.(null);
    return true;
  });
}

class FakeProcessChannel extends EventEmitter {
  connected = true;
  exitCode: number | undefined;
  readonly sent: unknown[] = [];
  failMessageType: string | undefined;
  readonly disconnect = vi.fn(() => { this.connected = false; });
  readonly send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
    this.sent.push(message);
    const type = typeof message === 'object' && message !== null && 'type' in message
      ? String((message as { type: unknown }).type)
      : '';
    callback?.(type === this.failMessageType ? new Error(`failed ${type} acknowledgement`) : null);
    return true;
  });
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: DETACHED_MANAGED_PROTOCOL_VERSION,
    type: 'launch',
    nonce,
    targets: [target()],
    options: { label: `detached-child-${randomUUID()}` },
    ...overrides
  };
}

async function turn(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnActivity.spawn.mockReset();
  managedActivity.run.mockReset();
});

describe('detached managed parent launcher', () => {
  it('validates the required label before spawning', async () => {
    await expect(launchDetachedManagedTerminalWindows([target()], undefined as never))
      .rejects.toThrow(MANAGED_TERMINAL_LABEL_ERROR);
    expect(spawnActivity.spawn).not.toHaveBeenCalled();
  });

  it('keeps target payloads out of argv/environment and resolves only after accepted readiness', async () => {
    const child = new FakeChild();
    spawnActivity.spawn.mockReturnValue(child);
    const operation = launchDetachedManagedTerminalWindows(
      [target('node server.js --token super-secret')],
      { label: 'detached-parent' }
    );

    expect(spawnActivity.spawn).toHaveBeenCalledTimes(1);
    const [executable, args, options] = spawnActivity.spawn.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(JSON.stringify(args)).not.toContain('super-secret');
    expect((options as { detached: boolean }).detached).toBe(true);
    expect((options as { windowsHide: boolean }).windowsHide).toBe(true);
    expect((options as { stdio: unknown[] }).stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    expect((options as { env: NodeJS.ProcessEnv }).env.DETACHED_TEST_SECRET).toBeUndefined();

    const launch = child.sent[0] as { nonce: string; targets: Array<{ command: string }> };
    expect(launch.targets[0]?.command).toContain('super-secret');
    let settled = false;
    void operation.finally(() => { settled = true; });
    child.emit('message', {
      version: DETACHED_MANAGED_PROTOCOL_VERSION,
      type: 'accepted',
      nonce: launch.nonce
    });
    await turn();
    expect(settled).toBe(false);

    child.emit('message', {
      version: DETACHED_MANAGED_PROTOCOL_VERSION,
      type: 'ready',
      nonce: launch.nonce,
      sessionId: '00000000-0000-4000-8000-000000000010',
      label: 'detached-parent'
    });
    await expect(operation).resolves.toEqual({
      sessionId: '00000000-0000-4000-8000-000000000010',
      label: 'detached-parent'
    });
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('rejects protocol corruption and terminates an unaccepted child', async () => {
    const child = new FakeChild();
    spawnActivity.spawn.mockReturnValue(child);
    const operation = launchDetachedManagedTerminalWindows([target()], { label: 'corrupt' });
    child.emit('message', {
      version: DETACHED_MANAGED_PROTOCOL_VERSION,
      type: 'accepted',
      nonce: 'b'.repeat(43)
    });
    await expect(operation).rejects.toThrow('nonce did not match');
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('rejects parent-side IPC loss after acceptance without cancelling the child', async () => {
    const child = new FakeChild();
    spawnActivity.spawn.mockReturnValue(child);
    const operation = launchDetachedManagedTerminalWindows([target()], { label: 'accepted-disconnect' });
    const launch = child.sent[0] as { nonce: string };
    child.emit('message', {
      version: DETACHED_MANAGED_PROTOCOL_VERSION,
      type: 'accepted',
      nonce: launch.nonce
    });
    child.connected = false;
    child.emit('disconnect');
    await expect(operation).rejects.toThrow('after accepting the launch but before readiness');
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('rejects malformed readiness identity and label responses', async () => {
    const child = new FakeChild();
    spawnActivity.spawn.mockReturnValue(child);
    const operation = launchDetachedManagedTerminalWindows([target()], { label: 'strict-ready' });
    const launch = child.sent[0] as { nonce: string };
    child.emit('message', {
      version: DETACHED_MANAGED_PROTOCOL_VERSION,
      type: 'accepted',
      nonce: launch.nonce
    });
    child.emit('message', {
      version: DETACHED_MANAGED_PROTOCOL_VERSION,
      type: 'ready',
      nonce: launch.nonce,
      sessionId: '',
      label: 'wrong-label'
    });
    await expect(operation).rejects.toThrow('readiness response is malformed');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('bounds the pre-acceptance bootstrap wait', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      spawnActivity.spawn.mockReturnValue(child);
      const operation = launchDetachedManagedTerminalWindows([target()], { label: 'bootstrap-timeout' });
      const rejection = expect(operation).rejects.toThrow('did not accept its launch payload in time');
      await vi.advanceTimersByTimeAsync(DETACHED_MANAGED_BOOTSTRAP_TIMEOUT_MS + 1);
      await rejection;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports spawn and early-exit failures', async () => {
    spawnActivity.spawn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    await expect(launchDetachedManagedTerminalWindows([target()], { label: 'spawn-failure' }))
      .rejects.toThrow('spawn failed');

    const child = new FakeChild();
    spawnActivity.spawn.mockReturnValueOnce(child);
    const operation = launchDetachedManagedTerminalWindows([target()], { label: 'early-exit' });
    child.emit('exit', 9, null);
    await expect(operation).rejects.toThrow('exited before readiness');
  });

  it('propagates bounded managed and aggregate rollback errors after acceptance', async () => {
    for (const [name, expected] of [['Error', Error], ['AggregateError', AggregateError]] as const) {
      const child = new FakeChild();
      spawnActivity.spawn.mockReturnValueOnce(child);
      const operation = launchDetachedManagedTerminalWindows([target()], { label: `failure-${name}` });
      const launch = child.sent[0] as { nonce: string };
      child.emit('message', {
        version: DETACHED_MANAGED_PROTOCOL_VERSION,
        type: 'accepted',
        nonce: launch.nonce
      });
      child.emit('message', {
        version: DETACHED_MANAGED_PROTOCOL_VERSION,
        type: 'error',
        nonce: launch.nonce,
        name,
        message: name === 'AggregateError'
          ? 'Managed terminal launch and confirmed rollback both failed.'
          : 'initialization failed after confirmed rollback'
      });
      await expect(operation).rejects.toBeInstanceOf(expected);
      expect(child.kill).not.toHaveBeenCalled();
    }
  });
});

describe('detached managed supervisor child', () => {
  it('does not launch if the parent disconnects before payload acceptance', async () => {
    const channel = new FakeProcessChannel();
    runDetachedManagedTerminalSupervisorChild(channel as never);
    channel.emit('disconnect');
    await turn();
    expect(channel.exitCode).toBe(1);
    expect(managedActivity.run).not.toHaveBeenCalled();
  });

  it('validates again in the child and reports malformed payloads', async () => {
    const channel = new FakeProcessChannel();
    runDetachedManagedTerminalSupervisorChild(channel as never);
    channel.emit('message', request({ targets: [] }));
    await turn();
    expect(managedActivity.run).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([
      expect.objectContaining({ type: 'error', nonce, message: expect.stringContaining('non-empty array') })
    ]);
    expect(channel.exitCode).toBe(1);
  });

  it('does not launch when the acceptance acknowledgement cannot be delivered', async () => {
    const channel = new FakeProcessChannel();
    channel.failMessageType = 'accepted';
    runDetachedManagedTerminalSupervisorChild(channel as never);
    channel.emit('message', request());
    await turn();
    expect(channel.sent).toEqual([expect.objectContaining({ type: 'accepted', nonce })]);
    expect(managedActivity.run).not.toHaveBeenCalled();
    expect(channel.exitCode).toBe(1);
  });

  it('continues an accepted launch when the parent disconnects', async () => {
    let release!: () => void;
    managedActivity.run.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
    });
    const channel = new FakeProcessChannel();
    runDetachedManagedTerminalSupervisorChild(channel as never);
    channel.emit('message', request());
    await turn();
    expect(channel.sent[0]).toEqual(expect.objectContaining({ type: 'accepted', nonce }));
    channel.connected = false;
    channel.emit('disconnect');
    await turn();
    expect(managedActivity.run).toHaveBeenCalledOnce();
    expect(channel.exitCode).toBeUndefined();
    release();
  });

  it('treats IPC loss during ready acknowledgement as non-fatal to supervision', async () => {
    managedActivity.run.mockImplementation(async (_targets, _options, runnerOptions) => {
      try {
        await runnerOptions.onReady({ sessionId: 'ready-id', label: 'ready-label' });
      } catch {
        // Mirrors the shared runner's required best-effort hook isolation.
      }
    });
    const channel = new FakeProcessChannel();
    channel.failMessageType = 'ready';
    runDetachedManagedTerminalSupervisorChild(channel as never);
    channel.emit('message', request());
    await turn();
    expect(managedActivity.run).toHaveBeenCalledOnce();
    expect(channel.sent).toEqual([
      expect.objectContaining({ type: 'accepted' }),
      expect.objectContaining({ type: 'ready', sessionId: 'ready-id' })
    ]);
    expect(channel.exitCode).toBeUndefined();
    expect(channel.disconnect).toHaveBeenCalled();
  });

  it('sends initialization and aggregate rollback failures only after the runner rejects', async () => {
    for (const error of [
      new Error('initialization failed after confirmed rollback'),
      new AggregateError([], 'rollback confirmation failed')
    ]) {
      managedActivity.run.mockRejectedValueOnce(error);
      const channel = new FakeProcessChannel();
      runDetachedManagedTerminalSupervisorChild(channel as never);
      channel.emit('message', request());
      await turn();
      expect(channel.sent.at(-1)).toEqual(expect.objectContaining({
        type: 'error',
        name: error.name,
        message: error.message
      }));
      expect(channel.exitCode).toBe(1);
    }
  });
});
