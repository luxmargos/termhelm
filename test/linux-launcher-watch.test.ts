import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTerminalControlPaths,
  terminalMarkerJson
} from '../src/platforms/controller.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'termhelm-linux-watch-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runWatcher(
  executable: string,
  args: string[],
  exactProcess = false,
  requestUiClose = false,
  markReady = requestUiClose
): {
  control: ReturnType<typeof createTerminalControlPaths>;
  diagnosticPath: string;
  payloadPath: string;
  uiCloseResultPath: string;
} {
  const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory() });
  const payloadPath = join(control.directory, `${control.id}.launcher-watch.json`);
  const diagnosticPath = join(control.directory, `${control.id}.launcher-diagnostic.json`);
  const launchScriptPath = join(control.directory, `${control.id}.launch.sh`);
  const runnerPayloadPath = join(control.directory, `${control.id}.runner.payload`);
  const finalizerPayloadPath = join(control.directory, `${control.id}.finalizer.payload`);
  const detachedFinalizerPayloadPath = join(control.directory, `${control.id}.detached-finalizer.payload`);
  writeFileSync(launchScriptPath, 'private launch\n', { mode: 0o600 });
  writeFileSync(runnerPayloadPath, 'private runner\n', { mode: 0o600 });
  writeFileSync(finalizerPayloadPath, 'private finalizer\n', { mode: 0o600 });
  writeFileSync(detachedFinalizerPayloadPath, 'private detached finalizer\n', { mode: 0o600 });
  const uiCloseRequestPath = join(control.directory, `${control.id}.ui-close-request`);
  const uiCloseResultPath = join(control.directory, `${control.id}.ui-close-result.json`);
  if (markReady) writeFileSync(control.readyPath, terminalMarkerJson(control, 'ready'), { mode: 0o600 });
  if (requestUiClose) writeFileSync(uiCloseRequestPath, 'close\n', { mode: 0o600 });
  writeFileSync(payloadPath, `${JSON.stringify({
    version: 1,
    executable,
    args,
    targetTokenPath: control.targetTokenPath,
    readyPath: control.readyPath,
    failedPath: control.failedPath,
    failedMarker: terminalMarkerJson(control, 'failed'),
    diagnosticPath,
    launchScriptPath,
    runnerPayloadPath,
    finalizerPayloadPath,
    detachedFinalizerPayloadPath,
    exactProcess,
    uiCloseRequestPath,
    uiCloseResultPath
  })}\n`, { mode: 0o600 });
  const watcherPath = join(process.cwd(), 'dist/platforms/linux-launcher-watch.js');
  const result = spawnSync(process.execPath, [watcherPath, payloadPath], {
    encoding: 'utf8',
    timeout: 5_000
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Linux launcher watcher exited ${String(result.status)}: ${result.stderr}`);
  }
  return { control, diagnosticPath, payloadPath, uiCloseResultPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('Linux launcher watcher', () => {
  it('publishes authoritative failed only when the launcher executable never starts', () => {
    const missing = join(temporaryDirectory(), `missing-${randomUUID()}`);
    const { control, diagnosticPath, payloadPath } = runWatcher(missing, []);

    expect(existsSync(payloadPath)).toBe(false);
    expect(existsSync(control.targetTokenPath)).toBe(false);
    expect(JSON.parse(readFileSync(control.failedPath, 'utf8'))).toMatchObject({
      version: 2,
      sessionId: control.sessionId,
      targetId: control.id,
      state: 'failed'
    });
    expect(JSON.parse(readFileSync(diagnosticPath, 'utf8'))).toMatchObject({
      authoritative: false,
      kind: 'spawn-error'
    });
  });

  it('records exact-process UI closure separately from target termination evidence', () => {
    const { control, uiCloseResultPath } = runWatcher('/bin/sh', ['-c', 'sleep 5'], true, true);

    expect(existsSync(control.failedPath)).toBe(false);
    expect(JSON.parse(readFileSync(uiCloseResultPath, 'utf8'))).toMatchObject({ outcome: 'closed' });
  });

  it('records a nonzero launcher exit without claiming the target tree terminated', () => {
    const { control, diagnosticPath, payloadPath } = runWatcher('/bin/sh', ['-c', 'exit 7'], false, false, true);

    expect(existsSync(payloadPath)).toBe(false);
    expect(existsSync(control.targetTokenPath)).toBe(true);
    expect(existsSync(control.failedPath)).toBe(false);
    expect(JSON.parse(readFileSync(diagnosticPath, 'utf8'))).toMatchObject({
      authoritative: false,
      kind: 'launcher-exit',
      exitCode: 7,
      signal: null
    });
  });
});
