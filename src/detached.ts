import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateManagedTerminalLaunchOptions,
  validateTerminalTarget
} from './config.js';
import {
  runManagedTerminalSupervisor,
  type ManagedTerminalSupervisorReadyResult
} from './managed.js';
import type {
  DetachedManagedTerminalLaunchResult,
  ManagedTerminalLaunchOptions,
  TerminalTarget
} from './types.js';

export const DETACHED_MANAGED_PROTOCOL_VERSION = 1;
export const DETACHED_MANAGED_BOOTSTRAP_TIMEOUT_MS = 5_000;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ERROR_NAME_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 4_096;

type DetachedManagedLaunchRequest = {
  readonly version: typeof DETACHED_MANAGED_PROTOCOL_VERSION;
  readonly type: 'launch';
  readonly nonce: string;
  readonly targets: TerminalTarget[];
  readonly options: ManagedTerminalLaunchOptions;
};

type DetachedManagedAcceptedResponse = {
  readonly version: typeof DETACHED_MANAGED_PROTOCOL_VERSION;
  readonly type: 'accepted';
  readonly nonce: string;
};

type DetachedManagedReadyResponse = {
  readonly version: typeof DETACHED_MANAGED_PROTOCOL_VERSION;
  readonly type: 'ready';
  readonly nonce: string;
  readonly sessionId: string;
  readonly label: string;
};

type DetachedManagedErrorResponse = {
  readonly version: typeof DETACHED_MANAGED_PROTOCOL_VERSION;
  readonly type: 'error';
  readonly nonce: string;
  readonly name: string;
  readonly message: string;
};

type DetachedManagedResponse =
  | DetachedManagedAcceptedResponse
  | DetachedManagedReadyResponse
  | DetachedManagedErrorResponse;

interface DetachedSupervisorProcess {
  connected: boolean;
  send?: NodeJS.Process['send'];
  disconnect?: NodeJS.Process['disconnect'];
  on(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'disconnect', listener: () => void): this;
  removeListener(event: 'message', listener: (message: unknown) => void): this;
  removeListener(event: 'disconnect', listener: () => void): this;
  exitCode?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateNonce(value: unknown): string {
  if (typeof value !== 'string' || !NONCE_PATTERN.test(value)) {
    throw new Error('Detached managed terminal protocol nonce is invalid.');
  }
  return value;
}

function validateRequest(value: unknown): DetachedManagedLaunchRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'type', 'nonce', 'targets', 'options'])) {
    throw new Error('Detached managed terminal launch payload is malformed.');
  }
  if (value.version !== DETACHED_MANAGED_PROTOCOL_VERSION || value.type !== 'launch') {
    throw new Error('Detached managed terminal launch protocol version or message type is invalid.');
  }
  const nonce = validateNonce(value.nonce);
  const options = validateManagedTerminalLaunchOptions(value.options);
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new Error('Managed terminal targets must be a non-empty array.');
  }
  const targets = value.targets.map((target, index) =>
    validateTerminalTarget(target, `targets[${index}]`)
  );
  return {
    version: DETACHED_MANAGED_PROTOCOL_VERSION,
    type: 'launch',
    nonce,
    targets,
    options
  };
}

function validateResponse(
  value: unknown,
  nonce: string,
  expectedLabel: string
): DetachedManagedResponse {
  if (!isRecord(value) || value.version !== DETACHED_MANAGED_PROTOCOL_VERSION) {
    throw new Error('Detached managed terminal supervisor sent a malformed protocol response.');
  }
  if (validateNonce(value.nonce) !== nonce) {
    throw new Error('Detached managed terminal supervisor response nonce did not match.');
  }
  if (value.type === 'accepted') {
    if (!hasExactKeys(value, ['version', 'type', 'nonce'])) {
      throw new Error('Detached managed terminal supervisor acceptance response is malformed.');
    }
    return value as DetachedManagedAcceptedResponse;
  }
  if (value.type === 'ready') {
    if (
      !hasExactKeys(value, ['version', 'type', 'nonce', 'sessionId', 'label'])
      || typeof value.sessionId !== 'string'
      || !UUID_PATTERN.test(value.sessionId)
      || typeof value.label !== 'string'
      || value.label !== expectedLabel
    ) {
      throw new Error('Detached managed terminal supervisor readiness response is malformed.');
    }
    return value as DetachedManagedReadyResponse;
  }
  if (value.type === 'error') {
    if (
      !hasExactKeys(value, ['version', 'type', 'nonce', 'name', 'message'])
      || typeof value.name !== 'string'
      || value.name.length === 0
      || value.name.length > MAX_ERROR_NAME_LENGTH
      || typeof value.message !== 'string'
      || value.message.length === 0
      || value.message.length > MAX_ERROR_MESSAGE_LENGTH
    ) {
      throw new Error('Detached managed terminal supervisor error response is malformed.');
    }
    return value as DetachedManagedErrorResponse;
  }
  throw new Error('Detached managed terminal supervisor response type is invalid.');
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function errorResponse(nonce: string, error: unknown): DetachedManagedErrorResponse {
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    version: DETACHED_MANAGED_PROTOCOL_VERSION,
    type: 'error',
    nonce,
    name: boundedText(source.name || 'Error', MAX_ERROR_NAME_LENGTH),
    message: boundedText(source.message || String(source), MAX_ERROR_MESSAGE_LENGTH)
  };
}

function responseError(response: DetachedManagedErrorResponse): Error {
  if (response.name === 'AggregateError') return new AggregateError([], response.message);
  const error = new Error(response.message);
  error.name = response.name;
  return error;
}

function disconnectChild(child: ChildProcess): void {
  try {
    if (child.connected) child.disconnect();
  } catch {
    // The child may have closed IPC immediately after its final response.
  }
  child.unref();
}

function terminateUnacceptedChild(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Spawn/exit failure is already the caller-visible error.
  }
  disconnectChild(child);
}

function sendProcessMessage(
  processChannel: DetachedSupervisorProcess,
  message: DetachedManagedResponse
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!processChannel.connected || !processChannel.send) {
      reject(new Error('Detached managed terminal parent IPC channel is unavailable.'));
      return;
    }
    try {
      processChannel.send(message, error => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export interface DetachedManagedTerminalLauncherHooks {
  /** @internal Test-only observation of the exact spawned child handle identity. */
  readonly onSupervisorSpawn?: (pid: number) => void;
}

/**
 * Launches a hidden supervisor and resolves after the managed session is ready.
 * Input validation completes before the child process is spawned.
 */
export async function launchDetachedManagedTerminalWindows(
  targets: TerminalTarget[],
  options: ManagedTerminalLaunchOptions
): Promise<DetachedManagedTerminalLaunchResult> {
  return await launchDetachedManagedTerminalWindowsWithHooks(targets, options);
}

/** @internal Same launcher with a test-only observation seam. Not a root export. */
export async function launchDetachedManagedTerminalWindowsWithHooks(
  targets: TerminalTarget[],
  options: ManagedTerminalLaunchOptions,
  hooks: DetachedManagedTerminalLauncherHooks = {}
): Promise<DetachedManagedTerminalLaunchResult> {
  const validatedOptions = validateManagedTerminalLaunchOptions(options);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('Managed terminal targets must be a non-empty array.');
  }
  const validatedTargets = targets.map((target, index) =>
    validateTerminalTarget(target, `targets[${index}]`)
  );
  const nonce = randomBytes(32).toString('base64url');
  const request: DetachedManagedLaunchRequest = {
    version: DETACHED_MANAGED_PROTOCOL_VERSION,
    type: 'launch',
    nonce,
    targets: validatedTargets,
    options: validatedOptions
  };
  const adjacentSupervisorPath = fileURLToPath(new URL('./detached-supervisor.js', import.meta.url));
  const builtSupervisorPath = fileURLToPath(new URL('../dist/detached-supervisor.js', import.meta.url));
  const supervisorPath = existsSync(adjacentSupervisorPath)
    ? adjacentSupervisorPath
    : builtSupervisorPath;

  return await new Promise<DetachedManagedTerminalLaunchResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [supervisorPath], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        cwd: process.cwd(),
        env: process.env
      });
    } catch (error) {
      reject(error);
      return;
    }

    try {
      if (child.pid !== undefined) hooks.onSupervisorSpawn?.(child.pid);
    } catch (error) {
      terminateUnacceptedChild(child);
      reject(error);
      return;
    }

    let accepted = false;
    let settled = false;
    const bootstrapTimer = setTimeout(() => {
      if (settled || accepted) return;
      settled = true;
      cleanup();
      terminateUnacceptedChild(child);
      reject(new Error('Detached managed terminal supervisor did not accept its launch payload in time.'));
    }, DETACHED_MANAGED_BOOTSTRAP_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(bootstrapTimer);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('disconnect', onDisconnect);
    };
    const fail = (error: unknown, terminate = !accepted): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) terminateUnacceptedChild(child);
      else disconnectChild(child);
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onDisconnect = (): void => {
      fail(new Error(
        accepted
          ? 'Detached managed terminal supervisor IPC disconnected after accepting the launch but before readiness.'
          : 'Detached managed terminal supervisor IPC disconnected before accepting the launch.'
      ), false);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      fail(new Error(
        `Detached managed terminal supervisor exited before readiness` +
        ` (code ${String(code)}, signal ${String(signal)}).`
      ), false);
    };
    const onMessage = (message: unknown): void => {
      let response: DetachedManagedResponse;
      try {
        response = validateResponse(message, nonce, validatedOptions.label);
      } catch (error) {
        fail(error);
        return;
      }
      if (response.type === 'accepted') {
        if (accepted) {
          fail(new Error('Detached managed terminal supervisor sent duplicate acceptance.'));
          return;
        }
        accepted = true;
        clearTimeout(bootstrapTimer);
        return;
      }
      if (!accepted) {
        fail(new Error('Detached managed terminal supervisor responded before accepting the payload.'));
        return;
      }
      if (response.type === 'error') {
        fail(responseError(response), false);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      disconnectChild(child);
      resolve({ sessionId: response.sessionId, label: response.label });
    };

    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
    try {
      child.send(request, error => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error);
    }
  });
}

/** @internal Runs the protocol endpoint inside the packaged detached child. */
export function runDetachedManagedTerminalSupervisorChild(
  processChannel: DetachedSupervisorProcess = process as DetachedSupervisorProcess
): void {
  let accepted = false;
  let accepting = false;
  let finished = false;
  let bootstrapTimer: ReturnType<typeof setTimeout>;

  const disconnect = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(bootstrapTimer);
    processChannel.removeListener('message', onMessage);
    processChannel.removeListener('disconnect', onDisconnect);
    try {
      if (processChannel.connected) processChannel.disconnect?.();
    } catch {
      // The parent may have disconnected while the final reply was flushing.
    }
  };

  const failBeforeAcceptance = (): void => {
    processChannel.exitCode = 1;
    disconnect();
  };

  const onDisconnect = (): void => {
    if (!accepted) failBeforeAcceptance();
  };

  const supervise = async (request: DetachedManagedLaunchRequest): Promise<void> => {
    try {
      await runManagedTerminalSupervisor(request.targets, request.options, {
        onReady: async (result: ManagedTerminalSupervisorReadyResult) => {
          try {
            await sendProcessMessage(processChannel, {
              version: DETACHED_MANAGED_PROTOCOL_VERSION,
              type: 'ready',
              nonce: request.nonce,
              sessionId: result.sessionId,
              label: result.label
            });
          } finally {
            disconnect();
          }
        }
      });
    } catch (error) {
      try {
        await sendProcessMessage(processChannel, errorResponse(request.nonce, error));
      } catch {
        // An accepted detached operation no longer depends on the parent.
      } finally {
        processChannel.exitCode = 1;
        disconnect();
      }
    }
  };

  const onMessage = (message: unknown): void => {
    if (accepted || accepting || finished) return;
    let request: DetachedManagedLaunchRequest;
    try {
      request = validateRequest(message);
    } catch (error) {
      const nonce = isRecord(message) && typeof message.nonce === 'string' && NONCE_PATTERN.test(message.nonce)
        ? message.nonce
        : randomBytes(32).toString('base64url');
      void sendProcessMessage(processChannel, errorResponse(nonce, error))
        .catch(() => {})
        .finally(failBeforeAcceptance);
      return;
    }
    accepting = true;
    void sendProcessMessage(processChannel, {
      version: DETACHED_MANAGED_PROTOCOL_VERSION,
      type: 'accepted',
      nonce: request.nonce
    }).then(() => {
      if (finished) return;
      accepted = true;
      clearTimeout(bootstrapTimer);
      void supervise(request);
    }).catch(failBeforeAcceptance);
  };

  processChannel.on('message', onMessage);
  processChannel.once('disconnect', onDisconnect);
  bootstrapTimer = setTimeout(failBeforeAcceptance, DETACHED_MANAGED_BOOTSTRAP_TIMEOUT_MS);
}
