import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import type { ManagedTerminalCloseReason, ManagedTerminalCloseResult } from './types.js';

const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
const MAX_CONTROL_ERROR_LENGTH = 4 * 1024;
const MAX_CLOSE_RESULT_ITEMS = 1_000;
const CONTROL_AUTHENTICATION_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHENTICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const UI_CLOSE_OUTCOMES = new Set([
  'closed',
  'preserved',
  'host-managed',
  'refused-shared',
  'cancelled',
  'unsupported'
]);
const CLOSE_REASONS = new Set<ManagedTerminalCloseReason>([
  'closed',
  'replaced',
  'signal',
  'supervisor-disconnected',
  'target-exited',
  'launch-failed'
]);

interface StopRequest {
  type: 'stop';
  authenticationToken: string;
  requestId: string;
  reason: ManagedTerminalCloseReason;
}

export type ManagedControllerState = 'ready' | 'stopping' | 'stopped';

interface WatchRequest {
  type: 'watch';
  authenticationToken: string;
  requestId: string;
  sessionId: string;
  targetId: string;
}

interface ControllerStateMessage {
  type: 'state';
  state: ManagedControllerState;
}

interface StoppedResponse {
  type: 'stopped';
  requestId: string;
  result: ManagedTerminalCloseResult;
}

interface ErrorResponse {
  type: 'error';
  requestId: string;
  message: string;
}

type StopResponse = StoppedResponse | ErrorResponse;

export interface ManagedSupervisorWatch {
  readonly disconnected: Promise<void>;
  sendState(state: ManagedControllerState): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
  /** Stop accepting connections, allow an in-flight reply to flush, then force-close stragglers. */
  closeGracefully(timeoutMs?: number): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEndpoint(endpoint: unknown): asserts endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.includes('\0')) {
    throw new Error('Managed terminal control endpoint must be a non-empty path.');
  }
  if (process.platform === 'win32') {
    if (!endpoint.startsWith('\\\\.\\pipe\\') || endpoint.length <= '\\\\.\\pipe\\'.length) {
      throw new Error('Managed terminal control endpoint must be a Windows named pipe.');
    }
  } else if (!isAbsolute(endpoint)) {
    throw new Error('Managed terminal control endpoint must be an absolute Unix socket path.');
  }
}

function validateAuthenticationToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !AUTHENTICATION_TOKEN_PATTERN.test(token)) {
    throw new Error('Managed terminal control authentication token must contain 32 to 256 URL-safe characters.');
  }
}

function validateRequestId(requestId: unknown): asserts requestId is string {
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) {
    throw new Error('Managed terminal control request ID must be a UUID.');
  }
}

function isCloseReason(value: unknown): value is ManagedTerminalCloseReason {
  return typeof value === 'string' && CLOSE_REASONS.has(value as ManagedTerminalCloseReason);
}

function parseCloseResult(
  value: unknown,
  expectedTargetIds?: readonly string[]
): ManagedTerminalCloseResult {
  const uiCloseResults = isObject(value) && value.uiCloseResults === undefined ? [] : isObject(value) ? value.uiCloseResults : undefined;
  if (
    !isObject(value) ||
    !isCloseReason(value.reason) ||
    !Array.isArray(value.forcedTargetIds) ||
    !Array.isArray(uiCloseResults) ||
    !Array.isArray(value.warnings) ||
    value.forcedTargetIds.length > MAX_CLOSE_RESULT_ITEMS ||
    uiCloseResults.length > MAX_CLOSE_RESULT_ITEMS ||
    value.warnings.length > MAX_CLOSE_RESULT_ITEMS ||
    !value.forcedTargetIds.every(item => typeof item === 'string' && UUID_PATTERN.test(item)) ||
    !uiCloseResults.every(item =>
      isObject(item) &&
      typeof item.targetId === 'string' &&
      UUID_PATTERN.test(item.targetId) &&
      typeof item.outcome === 'string' &&
      UI_CLOSE_OUTCOMES.has(item.outcome)
    ) ||
    !value.warnings.every(item => typeof item === 'string' && item.length <= MAX_CONTROL_ERROR_LENGTH)
  ) {
    throw new Error('Managed terminal close result was invalid.');
  }
  const forcedIds = value.forcedTargetIds as string[];
  const uiResults = uiCloseResults as Array<{ targetId: string; outcome: ManagedTerminalCloseResult['uiCloseResults'][number]['outcome'] }>;
  const forcedSet = new Set(forcedIds);
  const uiTargetSet = new Set(uiResults.map(item => item.targetId));
  if (forcedSet.size !== forcedIds.length || uiTargetSet.size !== uiResults.length) {
    throw new Error('Managed terminal close result contained duplicate target entries.');
  }
  if (expectedTargetIds !== undefined) {
    const expected = new Set(expectedTargetIds);
    if (
      forcedIds.some(id => !expected.has(id)) ||
      uiResults.some(item => !expected.has(item.targetId)) ||
      uiTargetSet.size !== expected.size ||
      [...expected].some(id => !uiTargetSet.has(id))
    ) {
      throw new Error('Managed terminal close result did not match the registered target set.');
    }
  }
  const result: ManagedTerminalCloseResult = {
    reason: value.reason,
    forcedTargetIds: forcedIds,
    uiCloseResults: uiResults,
    warnings: value.warnings
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_CONTROL_MESSAGE_BYTES - 1_024) {
    throw new Error('Managed terminal close result exceeded the control message size limit.');
  }
  return result;
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function safeRequestId(value: unknown): string {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : '';
}

function writeResponse(socket: Socket, response: StopResponse): void {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

function removeUnixSocket(endpoint: string): void {
  if (process.platform === 'win32') return;
  try {
    const stats = lstatSync(endpoint);
    if (!stats.isSocket()) throw new Error(`Refusing to remove a non-socket managed control endpoint: ${endpoint}`);
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error(`Refusing to remove a managed control socket owned by another user: ${endpoint}`);
    }
    rmSync(endpoint, { force: true });
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function parseStopRequest(line: Buffer, expectedToken: string): StopRequest {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid control request.');
  }
  if (!isObject(value)) throw new Error('Invalid control request.');
  const requestId = safeRequestId(value.requestId);
  if (typeof value.authenticationToken !== 'string' || !tokenMatches(value.authenticationToken, expectedToken)) {
    throw Object.assign(new Error('Control authentication failed.'), { requestId });
  }
  if (value.type !== 'stop' || requestId === '' || !isCloseReason(value.reason)) {
    throw Object.assign(new Error('Invalid control request.'), { requestId });
  }
  return {
    type: 'stop',
    authenticationToken: value.authenticationToken,
    requestId,
    reason: value.reason
  };
}

function parseWatchRequest(line: Buffer, expectedToken: string): WatchRequest {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid controller watch request.');
  }
  if (!isObject(value)) throw new Error('Invalid controller watch request.');
  const requestId = safeRequestId(value.requestId);
  if (typeof value.authenticationToken !== 'string' || !tokenMatches(value.authenticationToken, expectedToken)) {
    throw Object.assign(new Error('Control authentication failed.'), { requestId });
  }
  if (
    value.type !== 'watch' ||
    requestId === '' ||
    typeof value.sessionId !== 'string' ||
    !UUID_PATTERN.test(value.sessionId) ||
    typeof value.targetId !== 'string' ||
    !UUID_PATTERN.test(value.targetId)
  ) {
    throw Object.assign(new Error('Invalid controller watch request.'), { requestId });
  }
  return {
    type: 'watch',
    authenticationToken: value.authenticationToken,
    requestId,
    sessionId: value.sessionId.toLowerCase(),
    targetId: value.targetId.toLowerCase()
  };
}

function parseControllerStateMessage(line: Buffer): ControllerStateMessage {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid controller state message.');
  }
  if (
    !isObject(value) ||
    value.type !== 'state' ||
    (value.state !== 'ready' && value.state !== 'stopping' && value.state !== 'stopped')
  ) {
    throw new Error('Invalid controller state message.');
  }
  return { type: 'state', state: value.state };
}

function parseStopResponse(line: Buffer, expectedRequestId: string): ManagedTerminalCloseResult {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8')) as unknown;
  } catch {
    throw new Error('Managed terminal control response was invalid.');
  }
  if (!isObject(value) || value.requestId !== expectedRequestId) {
    throw new Error('Managed terminal control response did not match the request.');
  }
  if (value.type === 'error' && typeof value.message === 'string' && value.message.length <= MAX_CONTROL_ERROR_LENGTH) {
    throw new Error(value.message);
  }
  if (value.type !== 'stopped') throw new Error('Managed terminal control response was invalid.');
  return parseCloseResult(value.result);
}

function addBoundedChunk(buffer: Buffer, chunk: Buffer): { line?: Buffer; trailing?: Buffer; buffer: Buffer } {
  const combined = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk], buffer.length + chunk.length);
  const newline = combined.indexOf(0x0a);
  if (newline === -1) {
    if (combined.length > MAX_CONTROL_MESSAGE_BYTES) throw new Error('Control message exceeded the size limit.');
    return { buffer: combined };
  }
  if (newline > MAX_CONTROL_MESSAGE_BYTES) throw new Error('Control message exceeded the size limit.');
  return {
    line: combined.subarray(0, newline),
    trailing: combined.subarray(newline + 1),
    buffer: Buffer.alloc(0)
  };
}

export async function openManagedControlServer(input: {
  endpoint: string;
  authenticationToken: string;
  onStop(reason: ManagedTerminalCloseReason): Promise<ManagedTerminalCloseResult>;
  sessionId?: string;
  controllerTargetIds?: readonly string[];
  onControllerState?(targetId: string, state: ManagedControllerState): void | Promise<void>;
}): Promise<ManagedControlServer> {
  validateEndpoint(input.endpoint);
  validateAuthenticationToken(input.authenticationToken);
  if (typeof input.onStop !== 'function') throw new Error('Managed terminal control onStop handler is required.');
  if (input.sessionId !== undefined) validateRequestId(input.sessionId);
  const controllerTargetIds = new Set((input.controllerTargetIds ?? []).map(targetId => {
    validateRequestId(targetId);
    return targetId.toLowerCase();
  }));
  if (controllerTargetIds.size > 0 && input.sessionId === undefined) {
    throw new Error('Managed terminal controller watches require a session ID.');
  }
  if (input.onControllerState !== undefined && typeof input.onControllerState !== 'function') {
    throw new Error('Managed terminal controller state handler must be a function.');
  }
  removeUnixSocket(input.endpoint);

  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', () => socket.destroy());
    // Bound unauthenticated clients. Authenticated watch and stop requests
    // disable this timer before entering their long-running phase.
    socket.setTimeout(CONTROL_AUTHENTICATION_TIMEOUT_MS, () => socket.destroy());

    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let responded = false;
    let mode: 'request' | 'watch' | 'complete' = 'request';
    let watchedTargetId = '';
    const respond = (response: StopResponse): void => {
      if (responded) return;
      responded = true;
      socket.setTimeout(0);
      socket.pause();
      writeResponse(socket, response);
    };

    const handleLine = (line: Buffer, hasTrailingData: boolean): void => {
      if (mode === 'complete' || responded) return;
      if (mode === 'watch') {
        let message: ControllerStateMessage;
        try {
          message = parseControllerStateMessage(line);
        } catch {
          socket.destroy();
          return;
        }
        void Promise.resolve()
          .then(() => input.onControllerState?.(watchedTargetId, message.state))
          .catch(() => socket.destroy());
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString('utf8')) as unknown;
      } catch {
        respond({ type: 'error', requestId: '', message: 'Invalid control request.' });
        return;
      }
      if (!isObject(parsed)) {
        respond({ type: 'error', requestId: '', message: 'Invalid control request.' });
        return;
      }

      if (parsed.type === 'watch') {
        let request: WatchRequest;
        try {
          request = parseWatchRequest(line, input.authenticationToken);
          if (
            request.sessionId !== input.sessionId?.toLowerCase() ||
            !controllerTargetIds.has(request.targetId)
          ) {
            throw Object.assign(new Error('Controller watch identity was not registered.'), { requestId: request.requestId });
          }
        } catch (error) {
          const requestId = isObject(error) && typeof error.requestId === 'string' ? error.requestId : '';
          respond({ type: 'error', requestId, message: error instanceof Error ? error.message : 'Invalid controller watch request.' });
          return;
        }
        watchedTargetId = request.targetId;
        mode = 'watch';
        socket.setTimeout(0);
        socket.write(`${JSON.stringify({ type: 'watching', requestId: request.requestId })}\n`);
        return;
      }

      let request: StopRequest;
      try {
        request = parseStopRequest(line, input.authenticationToken);
      } catch (error) {
        const requestId = isObject(error) && typeof error.requestId === 'string' ? error.requestId : '';
        respond({ type: 'error', requestId, message: error instanceof Error ? error.message : 'Invalid control request.' });
        return;
      }
      if (hasTrailingData) {
        respond({ type: 'error', requestId: request.requestId, message: 'Control connection must contain exactly one request.' });
        return;
      }
      mode = 'complete';
      socket.setTimeout(0);
      socket.pause();
      void Promise.resolve()
        .then(() => input.onStop(request.reason))
        .then(
          result => {
            try {
              respond({
                type: 'stopped',
                requestId: request.requestId,
                result: parseCloseResult(result, input.controllerTargetIds)
              });
            } catch {
              respond({ type: 'error', requestId: request.requestId, message: 'Managed terminal shutdown returned an invalid result.' });
            }
          },
          () => respond({ type: 'error', requestId: request.requestId, message: 'Managed terminal shutdown failed.' })
        );
    };

    socket.on('data', (chunk: Buffer) => {
      if (responded || mode === 'complete') return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk], buffer.length + chunk.length);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          if (buffer.length > MAX_CONTROL_MESSAGE_BYTES) {
            if (mode === 'request') respond({ type: 'error', requestId: '', message: 'Control request exceeded the size limit.' });
            else socket.destroy();
          }
          return;
        }
        if (newline > MAX_CONTROL_MESSAGE_BYTES) {
          if (mode === 'request') respond({ type: 'error', requestId: '', message: 'Control request exceeded the size limit.' });
          else socket.destroy();
          return;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        handleLine(line, buffer.length > 0);
        if (responded || socket.isPaused()) return;
      }
    });
  });

  try {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen({
        path: input.endpoint,
        // Do not ask Node/libuv to widen the Windows pipe ACL. Authentication,
        // rather than pipe-name secrecy or a saved PID, remains the authority
        // for every request on every platform.
        readableAll: false,
        writableAll: false,
        exclusive: true
      }, () => {
        server.off('error', onError);
        try {
          if (process.platform !== 'win32') chmodSync(input.endpoint, 0o600);
          resolvePromise();
        } catch (error) {
          reject(error);
        }
      });
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    try {
      server.close();
    } catch {
      // The server may never have reached the listening state.
    }
    removeUnixSocket(input.endpoint);
    throw error;
  }

  // A named pipe or Unix server can still emit an operational error after it
  // starts listening. Keep that error from becoming an uncaught exception;
  // individual clients will observe their own connection failure.
  server.on('error', () => undefined);

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolvePromise, reject) => {
      server.close(error => error ? reject(error) : resolvePromise());
      for (const socket of sockets) socket.destroy();
    }).finally(() => removeUnixSocket(input.endpoint));
    return closePromise;
  };

  let gracefulClosePromise: Promise<void> | undefined;
  const closeGracefully = (timeoutMs = 1_000): Promise<void> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new Error('Managed terminal graceful control close timeout must be non-negative.'));
    }
    gracefulClosePromise ??= new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, timeoutMs);
      server.close(error => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePromise();
      });
    }).finally(() => removeUnixSocket(input.endpoint));
    return gracefulClosePromise;
  };

  return { endpoint: input.endpoint, close, closeGracefully };
}

export async function watchManagedSupervisor(input: {
  endpoint: string;
  authenticationToken: string;
  requestId: string;
  sessionId: string;
  targetId: string;
  timeoutMs: number;
}): Promise<ManagedSupervisorWatch> {
  validateEndpoint(input.endpoint);
  validateAuthenticationToken(input.authenticationToken);
  validateRequestId(input.requestId);
  validateRequestId(input.sessionId);
  validateRequestId(input.targetId);
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('Managed terminal controller watch timeout must be a positive finite number.');
  }

  return await new Promise<ManagedSupervisorWatch>((resolvePromise, reject) => {
    const socket = createConnection(input.endpoint);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let watching = false;
    let initialSettled = false;
    let disconnectResolved = false;
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>(resolve => {
      resolveDisconnected = resolve;
    });
    const noteDisconnected = (): void => {
      if (disconnectResolved) return;
      disconnectResolved = true;
      resolveDisconnected();
    };
    const timer = setTimeout(() => {
      if (initialSettled) return;
      initialSettled = true;
      socket.destroy();
      reject(new Error(`Timed out after ${input.timeoutMs}ms while authenticating the managed controller watch.`));
    }, input.timeoutMs);

    const failInitial = (error: Error): void => {
      if (initialSettled) return;
      initialSettled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once('connect', () => {
      const request: WatchRequest = {
        type: 'watch',
        authenticationToken: input.authenticationToken,
        requestId: input.requestId,
        sessionId: input.sessionId,
        targetId: input.targetId
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (watching) {
        // The server sends only the initial acknowledgement. Any later bytes
        // indicate protocol confusion, so disconnect and fail closed.
        socket.destroy();
        return;
      }
      let frame: ReturnType<typeof addBoundedChunk>;
      try {
        frame = addBoundedChunk(buffer, chunk);
      } catch {
        failInitial(new Error('Managed controller watch response exceeded the size limit.'));
        return;
      }
      buffer = frame.buffer;
      if (frame.line === undefined) return;
      if (frame.trailing !== undefined && frame.trailing.length > 0) {
        failInitial(new Error('Managed controller watch returned more than one response.'));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(frame.line.toString('utf8')) as unknown;
      } catch {
        failInitial(new Error('Managed controller watch response was invalid.'));
        return;
      }
      if (
        !isObject(value) ||
        value.type !== 'watching' ||
        value.requestId !== input.requestId
      ) {
        const message = isObject(value) && value.type === 'error' && typeof value.message === 'string'
          ? value.message
          : 'Managed controller watch response was invalid.';
        failInitial(new Error(message));
        return;
      }

      watching = true;
      initialSettled = true;
      clearTimeout(timer);
      socket.setTimeout(0);
      const sendState = async (state: ManagedControllerState): Promise<void> => {
        if (state !== 'ready' && state !== 'stopping' && state !== 'stopped') {
          throw new Error('Managed controller state is invalid.');
        }
        if (socket.destroyed || !socket.writable) {
          throw new Error('Managed controller watch is disconnected.');
        }
        await new Promise<void>((resolve, rejectWrite) => {
          socket.write(`${JSON.stringify({ type: 'state', state } satisfies ControllerStateMessage)}\n`, error => {
            if (error) rejectWrite(error);
            else resolve();
          });
        });
      };
      const close = async (): Promise<void> => {
        if (!socket.destroyed) socket.end();
        await disconnected;
      };
      resolvePromise({ disconnected, sendState, close });
    });
    socket.on('error', error => {
      if (!watching) failInitial(error);
      else noteDisconnected();
    });
    socket.on('close', noteDisconnected);
    socket.on('end', noteDisconnected);
  });
}

export async function requestManagedSessionStop(input: {
  endpoint: string;
  authenticationToken: string;
  requestId: string;
  reason?: ManagedTerminalCloseReason;
  timeoutMs: number;
}): Promise<ManagedTerminalCloseResult> {
  validateEndpoint(input.endpoint);
  validateAuthenticationToken(input.authenticationToken);
  validateRequestId(input.requestId);
  if (input.reason !== undefined && !isCloseReason(input.reason)) throw new Error('Managed terminal close reason is invalid.');
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('Managed terminal control timeout must be a positive finite number.');
  }

  return await new Promise<ManagedTerminalCloseResult>((resolvePromise, reject) => {
    const socket = createConnection(input.endpoint);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`Timed out after ${input.timeoutMs}ms while requesting managed terminal shutdown.`)),
      input.timeoutMs
    );
    const finish = (error?: Error, result?: ManagedTerminalCloseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolvePromise(result);
      else reject(new Error('Managed terminal stop request ended without a result.'));
    };

    socket.once('connect', () => {
      const request: StopRequest = {
        type: 'stop',
        authenticationToken: input.authenticationToken,
        requestId: input.requestId,
        reason: input.reason ?? 'replaced'
      };
      // Keep the writable half open while shutdown is in progress. A client
      // FIN would make Node's default non-half-open server socket close before
      // a long-running acknowledgement can be returned.
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      let frame: ReturnType<typeof addBoundedChunk>;
      try {
        frame = addBoundedChunk(buffer, chunk);
      } catch {
        finish(new Error('Managed terminal control response exceeded the size limit.'));
        return;
      }
      buffer = frame.buffer;
      if (frame.line === undefined) return;
      if (frame.trailing !== undefined && frame.trailing.length > 0) {
        finish(new Error('Managed terminal control connection returned more than one response.'));
        return;
      }
      try {
        finish(undefined, parseStopResponse(frame.line, input.requestId));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Managed terminal control response was invalid.'));
      }
    });
    socket.once('error', error => finish(error));
    socket.once('end', () => finish());
  });
}
