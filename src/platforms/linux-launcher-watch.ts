import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PAYLOAD_BYTES = 128 * 1024;

interface LinuxLauncherWatchPayload {
  version: 1;
  executable: string;
  args: string[];
  targetTokenPath: string;
  readyPath: string;
  failedPath: string;
  failedMarker: string;
  diagnosticPath: string;
  launchScriptPath: string;
  runnerPayloadPath: string;
  finalizerPayloadPath: string;
  detachedFinalizerPayloadPath: string;
  exactProcess: boolean;
  uiCloseRequestPath: string;
  uiCloseResultPath: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`Linux terminal launcher ${name} must be an absolute path.`);
  }
  return resolve(value);
}

function parsePayload(value: unknown): LinuxLauncherWatchPayload {
  if (!isObject(value) || value.version !== 1) throw new Error('Linux terminal launcher payload is invalid.');
  const executable = absolutePath(value.executable, 'executable');
  if (!Array.isArray(value.args) || value.args.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new Error('Linux terminal launcher arguments are invalid.');
  }
  const targetTokenPath = absolutePath(value.targetTokenPath, 'target token path');
  const readyPath = absolutePath(value.readyPath, 'ready marker path');
  const failedPath = absolutePath(value.failedPath, 'failed marker path');
  const diagnosticPath = absolutePath(value.diagnosticPath, 'diagnostic path');
  const launchScriptPath = absolutePath(value.launchScriptPath, 'launch script path');
  const runnerPayloadPath = absolutePath(value.runnerPayloadPath, 'runner payload path');
  const finalizerPayloadPath = absolutePath(value.finalizerPayloadPath, 'finalizer payload path');
  const detachedFinalizerPayloadPath = absolutePath(value.detachedFinalizerPayloadPath, 'detached finalizer payload path');
  const uiCloseRequestPath = absolutePath(value.uiCloseRequestPath, 'UI-close request path');
  const uiCloseResultPath = absolutePath(value.uiCloseResultPath, 'UI-close result path');
  const controlDirectory = dirname(targetTokenPath);
  if ([
    readyPath,
    failedPath,
    diagnosticPath,
    launchScriptPath,
    runnerPayloadPath,
    finalizerPayloadPath,
    detachedFinalizerPayloadPath,
    uiCloseRequestPath,
    uiCloseResultPath
  ].some(path => dirname(path) !== controlDirectory)) {
    throw new Error('Linux terminal launcher state paths must share one private control directory.');
  }
  if (typeof value.failedMarker !== 'string' || value.failedMarker.length === 0 || value.failedMarker.length > 4096) {
    throw new Error('Linux terminal launcher failure marker is invalid.');
  }
  if (typeof value.exactProcess !== 'boolean') {
    throw new Error('Linux terminal launcher exact-process capability is invalid.');
  }
  return {
    version: 1,
    executable,
    args: value.args as string[],
    targetTokenPath,
    readyPath,
    failedPath,
    failedMarker: value.failedMarker,
    diagnosticPath,
    launchScriptPath,
    runnerPayloadPath,
    finalizerPayloadPath,
    detachedFinalizerPayloadPath,
    exactProcess: value.exactProcess,
    uiCloseRequestPath,
    uiCloseResultPath
  };
}

function readPrivatePayload(path: string): LinuxLauncherWatchPayload {
  const payloadPath = absolutePath(path, 'payload path');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(payloadPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PAYLOAD_BYTES) {
      throw new Error('Linux terminal launcher payload file is invalid.');
    }
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error('Linux terminal launcher payload file is not owned by the current user.');
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error('Linux terminal launcher payload file permissions are unsafe.');
    }
    return parsePayload(JSON.parse(readFileSync(descriptor, 'utf8')) as unknown);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(payloadPath, { force: true });
  }
}

function writePrivateFile(path: string, content: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function diagnostic(payload: LinuxLauncherWatchPayload, detail: Record<string, unknown>): void {
  writePrivateFile(payload.diagnosticPath, `${JSON.stringify({
    version: 1,
    authoritative: false,
    updatedAt: new Date().toISOString(),
    ...detail
  })}\n`);
}

function preventDelayedTargetLaunch(payload: LinuxLauncherWatchPayload): void {
  rmSync(payload.targetTokenPath, { force: true });
  rmSync(payload.launchScriptPath, { force: true });
  rmSync(payload.runnerPayloadPath, { force: true });
  rmSync(payload.finalizerPayloadPath, { force: true });
  rmSync(payload.detachedFinalizerPayloadPath, { force: true });
}

function authoritativeSpawnFailure(payload: LinuxLauncherWatchPayload, error: Error): void {
  preventDelayedTargetLaunch(payload);
  diagnostic(payload, { kind: 'spawn-error', message: error.message });
  if (!readFileExists(payload.readyPath)) writePrivateFile(payload.failedPath, payload.failedMarker);
}

function writeUiResult(
  payload: LinuxLauncherWatchPayload,
  outcome: 'closed' | 'host-managed' | 'unsupported'
): void {
  try {
    writePrivateFile(payload.uiCloseResultPath, `${JSON.stringify({ outcome, updatedAt: new Date().toISOString() })}\n`);
  } catch {
    // The owning session may already have removed its state after completion.
  }
}

function readFileExists(path: string): boolean {
  try {
    const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error('Linux terminal launcher payload path is required.');
  const payload = readPrivatePayload(payloadPath);
  const child = spawn(payload.executable, payload.args, { detached: true, stdio: 'ignore' });
  let spawned = false;
  await new Promise<void>((resolveWatch, reject) => {
    let settled = false;
    const requestTimer = setInterval(() => {
      if (settled || !existsSync(payload.uiCloseRequestPath)) return;
      rmSync(payload.uiCloseRequestPath, { force: true });
      if (!payload.exactProcess) {
        writeUiResult(payload, 'host-managed');
        return;
      }
      if (!child.kill('SIGTERM')) writeUiResult(payload, 'host-managed');
    }, 50);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(requestTimer);
      if (error) reject(error);
      else resolveWatch();
    };
    child.once('spawn', () => { spawned = true; });
    child.once('error', error => {
      if (settled) return;
      try {
        if (!spawned) {
          authoritativeSpawnFailure(payload, error);
          writeUiResult(payload, 'unsupported');
        } else {
          diagnostic(payload, { kind: 'launcher-error', message: error.message });
          writeUiResult(payload, 'host-managed');
        }
        finish();
      } catch (writeError) {
        finish(writeError instanceof Error ? writeError : new Error(String(writeError)));
      }
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      try {
        if (payload.exactProcess && !readFileExists(payload.readyPath)) {
          preventDelayedTargetLaunch(payload);
          writePrivateFile(payload.failedPath, payload.failedMarker);
        }
        if (code !== 0 || signal !== null) {
          diagnostic(payload, {
            kind: 'launcher-exit',
            exitCode: code,
            signal
          });
        }
        if (payload.exactProcess) writeUiResult(payload, 'closed');
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`termhelm Linux launcher watcher: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
