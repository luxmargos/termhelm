import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openManagedControlServer, requestManagedSessionStop, watchManagedSupervisor } from '../src/control.js';

const TOKEN = 'a'.repeat(43);
const rawServerSockets = new WeakMap<Server, Set<Socket>>();

function endpoint(): string {
  const id = randomUUID();
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\termhelm-test-${id}`
    : join('/tmp', `.tw-${id}.sock`);
}

async function rawExchange(path: string, payload: string | Buffer): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Raw control exchange timed out.'));
    }, 1_000);
    const finish = (error?: Error, value?: Record<string, unknown>): void => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    socket.once('connect', () => socket.end(payload));
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const newline = response.indexOf(0x0a);
      if (newline === -1) return;
      try {
        finish(undefined, JSON.parse(response.subarray(0, newline).toString('utf8')) as Record<string, unknown>);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Invalid raw response.'));
      }
    });
    socket.once('error', finish);
    socket.once('end', () => {
      if (response.indexOf(0x0a) === -1) finish(new Error('Raw control exchange ended without a response.'));
    });
  });
}

async function openRawServer(path: string, handler: (socket: Socket) => void): Promise<Server> {
  if (process.platform !== 'win32') rmSync(path, { force: true });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  rawServerSockets.set(server, sockets);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return server;
}

async function closeRawServer(server: Server, path: string): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const socket of rawServerSockets.get(server) ?? []) socket.destroy();
  await closed;
  if (process.platform !== 'win32') rmSync(path, { force: true });
}

describe('managed control channel', () => {
  it('authenticates a controller watch, accepts lifecycle states, and reports supervisor disconnect', async () => {
    const path = endpoint();
    const sessionId = randomUUID();
    const targetId = randomUUID();
    const onControllerState = vi.fn();
    const server = await openManagedControlServer({
      endpoint: path,
      authenticationToken: TOKEN,
      onStop: async reason => ({ reason, forcedTargetIds: [], warnings: [] }),
      sessionId,
      controllerTargetIds: [targetId],
      onControllerState
    });
    const watch = await watchManagedSupervisor({
      endpoint: path,
      authenticationToken: TOKEN,
      requestId: randomUUID(),
      sessionId,
      targetId,
      timeoutMs: 1_000
    });
    await watch.sendState('ready');
    await watch.sendState('stopping');
    await watch.sendState('stopped');
    await vi.waitFor(() => expect(onControllerState).toHaveBeenCalledTimes(3));
    expect(onControllerState.mock.calls).toEqual([
      [targetId, 'ready'],
      [targetId, 'stopping'],
      [targetId, 'stopped']
    ]);

    const disconnected = watch.disconnected;
    await server.close();
    await disconnected;
  });

  it('closes a controller watch when its state handler throws synchronously', async () => {
    const path = endpoint();
    const sessionId = randomUUID();
    const targetId = randomUUID();
    const server = await openManagedControlServer({
      endpoint: path,
      authenticationToken: TOKEN,
      onStop: async reason => ({ reason, forcedTargetIds: [], warnings: [] }),
      sessionId,
      controllerTargetIds: [targetId],
      onControllerState: () => {
        throw new Error('marker write failed');
      }
    });
    const watch = await watchManagedSupervisor({
      endpoint: path,
      authenticationToken: TOKEN,
      requestId: randomUUID(),
      sessionId,
      targetId,
      timeoutMs: 1_000
    });
    await watch.sendState('ready');
    await expect(watch.disconnected).resolves.toBeUndefined();
    await server.close();
  });

  it('rejects controller watches with the wrong token or target identity', async () => {
    const path = endpoint();
    const sessionId = randomUUID();
    const targetId = randomUUID();
    const server = await openManagedControlServer({
      endpoint: path,
      authenticationToken: TOKEN,
      onStop: async reason => ({ reason, forcedTargetIds: [], warnings: [] }),
      sessionId,
      controllerTargetIds: [targetId]
    });
    try {
      await expect(watchManagedSupervisor({
        endpoint: path,
        authenticationToken: 'b'.repeat(43),
        requestId: randomUUID(),
        sessionId,
        targetId,
        timeoutMs: 1_000
      })).rejects.toThrow('Control authentication failed');
      await expect(watchManagedSupervisor({
        endpoint: path,
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        sessionId,
        targetId: randomUUID(),
        timeoutMs: 1_000
      })).rejects.toThrow('identity was not registered');
    } finally {
      await server.close();
    }
  });

  it('authenticates and acknowledges exactly one shutdown request', async () => {
    const path = endpoint();
    const onStop = vi.fn(async reason => ({ reason, forcedTargetIds: [], warnings: [] }));
    const server = await openManagedControlServer({ endpoint: path, authenticationToken: TOKEN, onStop });
    try {
      await expect(requestManagedSessionStop({
        endpoint: path,
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        reason: 'replaced',
        timeoutMs: 1_000
      })).resolves.toEqual({ reason: 'replaced', forcedTargetIds: [], warnings: [] });
      expect(onStop).toHaveBeenCalledOnce();
      expect(onStop).toHaveBeenCalledWith('replaced');
    } finally {
      await server.close();
    }
    if (process.platform !== 'win32') expect(existsSync(path)).toBe(false);
  });

  it('keeps the stop connection open until a delayed acknowledgement is returned', async () => {
    const path = endpoint();
    const server = await openManagedControlServer({
      endpoint: path,
      authenticationToken: TOKEN,
      onStop: async reason => {
        await new Promise(resolve => setTimeout(resolve, 75));
        return { reason, forcedTargetIds: [], warnings: [] };
      }
    });
    try {
      await expect(requestManagedSessionStop({
        endpoint: path,
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        timeoutMs: 1_000
      })).resolves.toMatchObject({ reason: 'replaced' });
    } finally {
      await server.close();
    }
  });

  it('rejects an invalid authentication token without calling the handler', async () => {
    const path = endpoint();
    const onStop = vi.fn(async reason => ({ reason, forcedTargetIds: [], warnings: [] }));
    const server = await openManagedControlServer({ endpoint: path, authenticationToken: TOKEN, onStop });
    try {
      await expect(requestManagedSessionStop({
        endpoint: path,
        authenticationToken: 'b'.repeat(43),
        requestId: randomUUID(),
        timeoutMs: 1_000
      })).rejects.toThrow('Control authentication failed');
      expect(onStop).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('rejects malformed, oversized, and pipelined request frames', async () => {
    const path = endpoint();
    const onStop = vi.fn(async reason => ({ reason, forcedTargetIds: [], warnings: [] }));
    const server = await openManagedControlServer({ endpoint: path, authenticationToken: TOKEN, onStop });
    try {
      await expect(rawExchange(path, 'not-json\n')).resolves.toMatchObject({ type: 'error', message: 'Invalid control request.' });
      await expect(rawExchange(path, `${'x'.repeat(64 * 1024 + 1)}\n`)).resolves.toMatchObject({
        type: 'error',
        message: 'Control request exceeded the size limit.'
      });

      const request = JSON.stringify({
        type: 'stop',
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        reason: 'replaced'
      });
      await expect(rawExchange(path, `${request}\n${request}\n`)).resolves.toMatchObject({
        type: 'error',
        message: 'Control connection must contain exactly one request.'
      });
      expect(onStop).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('rejects an authenticated request with an invalid reason', async () => {
    const path = endpoint();
    const onStop = vi.fn(async reason => ({ reason, forcedTargetIds: [], warnings: [] }));
    const server = await openManagedControlServer({ endpoint: path, authenticationToken: TOKEN, onStop });
    const requestId = randomUUID();
    try {
      await expect(rawExchange(path, `${JSON.stringify({
        type: 'stop',
        authenticationToken: TOKEN,
        requestId,
        reason: 'anything'
      })}\n`)).resolves.toMatchObject({ type: 'error', requestId, message: 'Invalid control request.' });
      expect(onStop).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('handles only the first request when a peer writes another frame later', async () => {
    const path = endpoint();
    let releaseStop!: () => void;
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const onStop = vi.fn(async reason => {
      await stopGate;
      return { reason, forcedTargetIds: [], warnings: [] };
    });
    const server = await openManagedControlServer({ endpoint: path, authenticationToken: TOKEN, onStop });
    const socket = createConnection(path);
    socket.on('error', () => undefined);
    try {
      await once(socket, 'connect');
      const firstRequestId = randomUUID();
      const request = (requestId: string) => JSON.stringify({
        type: 'stop',
        authenticationToken: TOKEN,
        requestId,
        reason: 'replaced'
      });
      socket.write(`${request(firstRequestId)}\n`);
      await vi.waitFor(() => expect(onStop).toHaveBeenCalledOnce());
      socket.write(`${request(randomUUID())}\n`);
      releaseStop();

      let response = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { response += chunk; });
      await once(socket, 'end');
      expect(JSON.parse(response.trim())).toMatchObject({ type: 'stopped', requestId: firstRequestId });
      expect(onStop).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('rejects invalid shutdown results and does not expose handler errors', async () => {
    const invalidPath = endpoint();
    const invalidServer = await openManagedControlServer({
      endpoint: invalidPath,
      authenticationToken: TOKEN,
      onStop: async () => ({ reason: 'replaced', forcedTargetIds: ['not-a-uuid'], warnings: [] })
    });
    try {
      await expect(requestManagedSessionStop({
        endpoint: invalidPath,
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        timeoutMs: 1_000
      })).rejects.toThrow('shutdown returned an invalid result');
    } finally {
      await invalidServer.close();
    }

    const failurePath = endpoint();
    const failureServer = await openManagedControlServer({
      endpoint: failurePath,
      authenticationToken: TOKEN,
      onStop: async () => { throw new Error('secret implementation detail'); }
    });
    try {
      await expect(requestManagedSessionStop({
        endpoint: failurePath,
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        timeoutMs: 1_000
      })).rejects.toThrow('Managed terminal shutdown failed');
    } finally {
      await failureServer.close();
    }
  });

  it('bounds and validates responses from the control peer', async () => {
    const oversizedPath = endpoint();
    const oversizedServer = await openRawServer(oversizedPath, socket => socket.end(`${'x'.repeat(64 * 1024 + 1)}\n`));
    try {
      await expect(requestManagedSessionStop({
        endpoint: oversizedPath,
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        timeoutMs: 1_000
      })).rejects.toThrow('response exceeded the size limit');
    } finally {
      await closeRawServer(oversizedServer, oversizedPath);
    }

    const duplicatePath = endpoint();
    const requestId = randomUUID();
    const response = JSON.stringify({ type: 'error', requestId, message: 'first' });
    const duplicateServer = await openRawServer(duplicatePath, socket => socket.end(`${response}\n${response}\n`));
    try {
      await expect(requestManagedSessionStop({
        endpoint: duplicatePath,
        authenticationToken: TOKEN,
        requestId,
        timeoutMs: 1_000
      })).rejects.toThrow('more than one response');
    } finally {
      await closeRawServer(duplicateServer, duplicatePath);
    }
  });

  it('times out and destroys an unresponsive connection', async () => {
    const path = endpoint();
    const rawServer = await openRawServer(path, () => undefined);
    try {
      await expect(requestManagedSessionStop({
        endpoint: path,
        authenticationToken: TOKEN,
        requestId: randomUUID(),
        timeoutMs: 25
      })).rejects.toThrow('Timed out after 25ms');
    } finally {
      await closeRawServer(rawServer, path);
    }
  });

  it('returns one idempotent close promise and closes idle clients', async () => {
    const path = endpoint();
    const server = await openManagedControlServer({
      endpoint: path,
      authenticationToken: TOKEN,
      onStop: async reason => ({ reason, forcedTargetIds: [], warnings: [] })
    });
    const idleClient = createConnection(path);
    idleClient.on('error', () => undefined);
    await once(idleClient, 'connect');
    const firstClose = server.close();
    const secondClose = server.close();
    expect(firstClose).toBe(secondClose);
    await Promise.all([firstClose, secondClose]);
    if (!idleClient.destroyed) await once(idleClient, 'close');
    expect(idleClient.destroyed).toBe(true);
    if (process.platform !== 'win32') expect(existsSync(path)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('uses private Unix socket permissions and refuses to delete a regular file', async () => {
    const path = endpoint();
    const server = await openManagedControlServer({
      endpoint: path,
      authenticationToken: TOKEN,
      onStop: async reason => ({ reason, forcedTargetIds: [], warnings: [] })
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await server.close();

    writeFileSync(path, 'preserve me');
    await expect(openManagedControlServer({
      endpoint: path,
      authenticationToken: TOKEN,
      onStop: async reason => ({ reason, forcedTargetIds: [], warnings: [] })
    })).rejects.toThrow('Refusing to remove a non-socket');
    expect(readFileSync(path, 'utf8')).toBe('preserve me');
    rmSync(path, { force: true });
  });

  it('validates client inputs before attempting a connection', async () => {
    await expect(requestManagedSessionStop({
      endpoint: endpoint(),
      authenticationToken: 'short',
      requestId: randomUUID(),
      timeoutMs: 1_000
    })).rejects.toThrow('32 to 256 URL-safe characters');
    await expect(requestManagedSessionStop({
      endpoint: endpoint(),
      authenticationToken: TOKEN,
      requestId: 'not-a-uuid',
      timeoutMs: 1_000
    })).rejects.toThrow('request ID must be a UUID');
    await expect(requestManagedSessionStop({
      endpoint: endpoint(),
      authenticationToken: TOKEN,
      requestId: randomUUID(),
      timeoutMs: 0
    })).rejects.toThrow('timeout must be a positive finite number');
  });
});
