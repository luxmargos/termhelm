import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openManagedControlServer } from '../src/control.js';
import {
  createPosixSidecarLaunch,
  finalizePosixRunner,
  parsePosixSidecarPayload,
  waitAndFinalizePosixRunner
} from '../src/platforms/posix-sidecar.js';
import { createTerminalControlPaths, type TerminalControlPaths } from '../src/platforms/controller.js';
import { buildSupervisedPosixCommand, posixShellQuote } from '../src/shell.js';
import type { InternalTerminalLaunchOptions, TerminalTarget } from '../src/types.js';

const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-windows-sidecar-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(path: string): number {
  const pid = Number(readFileSync(path, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid test process ID in ${path}.`);
  return pid;
}

function processIdentity(pid: number): { parentPid: number; processGroupId: number } {
  const output = execFileSync('/bin/ps', ['-o', 'ppid=,pgid=', '-p', String(pid)], {
    encoding: 'utf8'
  }).trim();
  const match = /^([0-9]+)\s+([0-9]+)$/.exec(output);
  if (!match) throw new Error(`Invalid test process identity for ${pid}.`);
  return { parentPid: Number(match[1]), processGroupId: Number(match[2]) };
}

function writeProcessTree(directory: string, termBehavior: 'ignore' | 'exit'): {
  rootScriptPath: string;
  rootPidPath: string;
  childPidPath: string;
  grandchildPidPath: string;
  termObservedPaths: [string, string, string];
  environment: Record<string, string>;
} {
  const rootScriptPath = join(directory, 'root.mjs');
  const childScriptPath = join(directory, 'child.mjs');
  const grandchildScriptPath = join(directory, 'grandchild.mjs');
  const rootPidPath = join(directory, 'root.pid');
  const childPidPath = join(directory, 'child.pid');
  const grandchildPidPath = join(directory, 'grandchild.pid');
  const rootTermPath = join(directory, 'root.term');
  const childTermPath = join(directory, 'child.term');
  const grandchildTermPath = join(directory, 'grandchild.term');
  const termHandler = (pathEnvironmentName: string): string => termBehavior === 'ignore'
    ? "process.on('SIGTERM', () => {});"
    : `process.on('SIGTERM', () => { writeFileSync(process.env.${pathEnvironmentName}, 'SIGTERM\\n'); process.exit(0); });`;

  writeFileSync(grandchildScriptPath, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.GRANDCHILD_PID_PATH, `${process.pid}\\n`);",
    termHandler('GRANDCHILD_TERM_PATH'),
    'setInterval(() => {}, 1_000);'
  ].join('\n'));
  writeFileSync(childScriptPath, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.CHILD_PID_PATH, `${process.pid}\\n`);",
    termHandler('CHILD_TERM_PATH'),
    "spawn(process.execPath, [process.env.GRANDCHILD_SCRIPT_PATH], { env: process.env, stdio: 'ignore' });",
    'setInterval(() => {}, 1_000);'
  ].join('\n'));
  writeFileSync(rootScriptPath, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.ROOT_PID_PATH, `${process.pid}\\n`);",
    termHandler('ROOT_TERM_PATH'),
    "spawn(process.execPath, [process.env.CHILD_SCRIPT_PATH], { env: process.env, stdio: 'ignore' });",
    'setInterval(() => {}, 1_000);'
  ].join('\n'));

  return {
    rootScriptPath,
    rootPidPath,
    childPidPath,
    grandchildPidPath,
    termObservedPaths: [rootTermPath, childTermPath, grandchildTermPath],
    environment: {
      ROOT_PID_PATH: rootPidPath,
      CHILD_PID_PATH: childPidPath,
      GRANDCHILD_PID_PATH: grandchildPidPath,
      ROOT_TERM_PATH: rootTermPath,
      CHILD_TERM_PATH: childTermPath,
      GRANDCHILD_TERM_PATH: grandchildTermPath,
      CHILD_SCRIPT_PATH: childScriptPath,
      GRANDCHILD_SCRIPT_PATH: grandchildScriptPath
    }
  };
}

function launchWrapper(
  target: TerminalTarget,
  gracefulShutdownMs = 250,
  extraOptions: InternalTerminalLaunchOptions = {},
  shellPath = process.env.SHELL,
  providedControl?: TerminalControlPaths
): { child: ChildProcess; control: TerminalControlPaths; stderr: () => string } {
  const control = providedControl ?? createTerminalControlPaths({
    stateDirectory: temporaryDirectory(),
    gracefulShutdownMs
  });
  const baseOptions: InternalTerminalLaunchOptions = {
    exitAfterCommand: true,
    closeWaitTimeoutMs: 3_000,
    ...extraOptions
  };
  const options: InternalTerminalLaunchOptions = {
    ...baseOptions,
    posixSidecar: {
      ...createPosixSidecarLaunch(target, control, baseOptions),
      scriptPath: join(process.cwd(), 'dist/platforms/posix-sidecar.js')
    }
  };
  const command = buildSupervisedPosixCommand(target, options, control);
  const child = spawn('/bin/bash', ['-c', command], {
    detached: true,
    env: { ...process.env, ...(shellPath === undefined ? {} : { SHELL: shellPath }) },
    stdio: ['pipe', 'ignore', 'pipe']
  });
  childProcesses.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  return { child, control, stderr: () => stderr };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for POSIX runner test state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for POSIX wrapper exit.')), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of childProcesses.splice(0)) {
    if (child.pid && processExists(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('POSIX Node group-leader runner', () => {
  it('acknowledges natural completion only after the wrapper observes an empty group', async () => {
    const target: TerminalTarget = { title: 'duplicate title', cwd: temporaryDirectory(), command: 'exit 0' };
    const { child, control, stderr } = launchWrapper(target);

    await waitFor(() => existsSync(control.stoppedPath));
    expect(await waitForExit(child)).toBe(0);
    expect(stderr()).not.toContain('terminal-windows POSIX controller:');
    expect(existsSync(control.readyPath)).toBe(true);
    expect(existsSync(control.stoppingPath)).toBe(false);
    expect(existsSync(control.forcedPath)).toBe(false);
    expect(statSync(control.stoppedPath).mode & 0o077).toBe(0);
  });

  it('gracefully stops a parent/child/grandchild group and leaves an unrelated process alive', async () => {
    const directory = temporaryDirectory();
    const tree = writeProcessTree(directory, 'exit');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      detached: true,
      stdio: 'ignore'
    });
    childProcesses.push(unrelated);
    const target: TerminalTarget = {
      title: 'same title',
      cwd: directory,
      command: `${posixShellQuote(process.execPath)} ${posixShellQuote(tree.rootScriptPath)}`,
      env: tree.environment
    };
    const { child, control, stderr } = launchWrapper(target, 1_000);
    await waitFor(() => existsSync(control.readyPath)
      && existsSync(tree.rootPidPath)
      && existsSync(tree.childPidPath)
      && existsSync(tree.grandchildPidPath));
    const ownedPids = [readPid(tree.rootPidPath), readPid(tree.childPidPath), readPid(tree.grandchildPidPath)];

    rmSync(control.targetTokenPath);
    await waitFor(() => existsSync(control.stoppedPath));
    await waitForExit(child);
    expect(stderr()).not.toContain('terminal-windows POSIX controller:');
    expect(tree.termObservedPaths.every(path => existsSync(path))).toBe(true);
    expect(ownedPids.every(pid => !processExists(pid))).toBe(true);
    expect(existsSync(control.forcedPath)).toBe(false);
    expect(processExists(unrelated.pid!)).toBe(true);
  });

  it('forces an uncooperative tree from inside the live group leader and never harms an unrelated process', async () => {
    const directory = temporaryDirectory();
    const tree = writeProcessTree(directory, 'ignore');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      detached: true,
      stdio: 'ignore'
    });
    childProcesses.push(unrelated);
    const target: TerminalTarget = {
      title: 'same title',
      cwd: directory,
      command: `${posixShellQuote(process.execPath)} ${posixShellQuote(tree.rootScriptPath)}`,
      env: tree.environment
    };
    const { child, control } = launchWrapper(target, 100);
    await waitFor(() => existsSync(control.readyPath)
      && existsSync(tree.rootPidPath)
      && existsSync(tree.childPidPath)
      && existsSync(tree.grandchildPidPath));
    const ownedPids = [readPid(tree.rootPidPath), readPid(tree.childPidPath), readPid(tree.grandchildPidPath)];

    rmSync(control.targetTokenPath);
    await waitFor(() => existsSync(control.stoppedPath));
    await waitForExit(child);
    expect(existsSync(control.forcedPath)).toBe(true);
    expect(existsSync(control.failedPath)).toBe(false);
    expect(ownedPids.every(pid => !processExists(pid))).toBe(true);
    expect(processExists(unrelated.pid!)).toBe(true);
  });

  it('cleans up the owned tree when the authenticated supervisor watch disconnects', async () => {
    const directory = temporaryDirectory();
    const tree = writeProcessTree(directory, 'exit');
    const control = createTerminalControlPaths({
      stateDirectory: temporaryDirectory(),
      gracefulShutdownMs: 1_000
    });
    // macOS limits Unix-domain socket paths to roughly one hundred bytes.
    const endpoint = join('/tmp', `.tw-${randomUUID()}.sock`);
    const authenticationToken = 'a'.repeat(43);
    const server = await openManagedControlServer({
      endpoint,
      authenticationToken,
      onStop: async reason => ({ reason, forcedTargetIds: [], warnings: [] }),
      sessionId: control.sessionId,
      controllerTargetIds: [control.id]
    });
    const target: TerminalTarget = {
      title: 'supervisor disconnect',
      cwd: directory,
      command: `${posixShellQuote(process.execPath)} ${posixShellQuote(tree.rootScriptPath)}`,
      env: tree.environment
    };
    const { child } = launchWrapper(target, 1_000, {
      controlEndpoint: endpoint,
      authenticationToken
    }, process.env.SHELL, control);
    let serverClosed = false;
    try {
      await waitFor(() => existsSync(control.readyPath)
        && existsSync(tree.rootPidPath)
        && existsSync(tree.childPidPath)
        && existsSync(tree.grandchildPidPath));
      const ownedPids = [readPid(tree.rootPidPath), readPid(tree.childPidPath), readPid(tree.grandchildPidPath)];

      await server.close();
      serverClosed = true;
      await waitFor(() => existsSync(control.stoppedPath));
      await waitForExit(child);
      expect(tree.termObservedPaths.every(path => existsSync(path))).toBe(true);
      expect(ownedPids.every(pid => !processExists(pid))).toBe(true);
      expect(existsSync(control.forcedPath)).toBe(false);
      expect(existsSync(control.failedPath)).toBe(false);
    } finally {
      if (!serverClosed) await server.close().catch(() => undefined);
    }
  });

  it('absorbs terminal SIGINT in the runner while delivering it to the foreground command', async () => {
    const directory = temporaryDirectory();
    const scriptPath = join(directory, 'interruptible.mjs');
    const pidPath = join(directory, 'interruptible.pid');
    const interruptPath = join(directory, 'interruptible.sigint');
    writeFileSync(scriptPath, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(pidPath)}, \`${'${process.pid}'}\\n\`);`,
      `process.on('SIGINT', () => writeFileSync(${JSON.stringify(interruptPath)}, 'SIGINT\\n'));`,
      'setInterval(() => {}, 1_000);'
    ].join('\n'));
    const target: TerminalTarget = {
      title: 'interruptible',
      cwd: directory,
      command: `${posixShellQuote(process.execPath)} ${posixShellQuote(scriptPath)}`
    };
    const { child, control } = launchWrapper(target, 500);
    await waitFor(() => existsSync(control.readyPath) && existsSync(pidPath));
    const targetPid = readPid(pidPath);
    const { processGroupId } = processIdentity(targetPid);

    process.kill(-processGroupId, 'SIGINT');
    await waitFor(() => existsSync(interruptPath));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(processExists(targetPid)).toBe(true);
    expect(existsSync(control.stoppingPath)).toBe(false);
    expect(existsSync(control.stoppedPath)).toBe(false);
    expect(existsSync(control.failedPath)).toBe(false);

    rmSync(control.targetTokenPath);
    await waitFor(() => existsSync(control.stoppedPath));
    await waitForExit(child);
  });

  it('publishes no terminal marker when finalization cannot reconfirm the wrapper ESRCH observation', async () => {
    const directory = temporaryDirectory();
    const target: TerminalTarget = { title: 'identity', cwd: directory, command: 'exit 0' };
    const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory() });
    const launch = createPosixSidecarLaunch(target, control, { exitAfterCommand: true });
    const payload = parsePosixSidecarPayload(launch.encodedPayload);
    writeFileSync(control.readyPath, 'ready\n', { mode: 0o600 });
    const killSpy = vi.spyOn(process, 'kill');

    const currentProcessGroupId = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8'
    }).trim());
    expect(await finalizePosixRunner(payload, currentProcessGroupId, true)).toBe(false);
    expect(existsSync(control.failedPath)).toBe(false);
    expect(existsSync(control.stoppedPath)).toBe(false);
    expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it('publishes failed only after an absent group proves controller failure is terminal', async () => {
    const directory = temporaryDirectory();
    const target: TerminalTarget = { title: 'failed', cwd: directory, command: 'exit 0' };
    const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory() });
    const launch = createPosixSidecarLaunch(target, control, { exitAfterCommand: true });
    const payload = parsePosixSidecarPayload(launch.encodedPayload);
    writeFileSync(control.readyPath, 'ready\n', { mode: 0o600 });

    const witness = spawn('/bin/sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
    childProcesses.push(witness);
    const processGroupId = witness.pid;
    if (processGroupId === undefined) throw new Error('POSIX absence witness did not return a PID.');
    await waitForExit(witness);

    expect(await finalizePosixRunner(payload, processGroupId, true)).toBe(false);
    expect(existsSync(control.failedPath)).toBe(true);
    expect(existsSync(control.stoppedPath)).toBe(false);
  });

  it('bounds forced confirmation by elapsed time and leaves a present group unacknowledged', async () => {
    const directory = temporaryDirectory();
    const target: TerminalTarget = { title: 'timeout', cwd: directory, command: 'exit 0' };
    const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory() });
    const launch = createPosixSidecarLaunch(target, control, {
      exitAfterCommand: true,
      closeWaitTimeoutMs: 40
    });
    const payload = parsePosixSidecarPayload(launch.encodedPayload);
    const currentProcessGroupId = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8'
    }).trim());
    const startedAt = Date.now();

    expect(await waitAndFinalizePosixRunner(payload, currentProcessGroupId)).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(existsSync(control.failedPath)).toBe(false);
    expect(existsSync(control.stoppedPath)).toBe(false);
  });

  it.skipIf(!existsSync('/bin/bash'))('keeps a command-accepting fallback shell in the runner-owned group', async () => {
    const directory = temporaryDirectory();
    const fallbackPidPath = join(directory, 'fallback.pid');
    const fallbackCommandPath = join(directory, 'fallback-command-ran');
    const bashEnvironmentPath = join(directory, 'fallback-env.sh');
    writeFileSync(bashEnvironmentPath, [
      'case "$-" in',
      `  *c*) ;;`,
      `  *) printf '%s\\n' "$$" > ${posixShellQuote(fallbackPidPath)} ;;`,
      'esac'
    ].join('\n'));
    const target: TerminalTarget = {
      title: 'fallback',
      cwd: directory,
      command: 'exit 0',
      env: { BASH_ENV: bashEnvironmentPath }
    };
    const { child, control } = launchWrapper(target, 500, { exitAfterCommand: false }, '/bin/bash');
    await waitFor(() => existsSync(control.readyPath) && existsSync(fallbackPidPath));
    const fallbackPid = readPid(fallbackPidPath);
    const identity = processIdentity(fallbackPid);
    expect(identity.processGroupId).toBe(identity.parentPid);
    expect(processExists(fallbackPid)).toBe(true);
    child.stdin?.write(`: > ${posixShellQuote(fallbackCommandPath)}\n`);
    await waitFor(() => existsSync(fallbackCommandPath));
    expect(processExists(fallbackPid)).toBe(true);
    rmSync(control.targetTokenPath);
    await waitFor(() => existsSync(control.stoppedPath));
    await waitForExit(child);
    expect(existsSync(control.forcedPath)).toBe(false);
    expect(processExists(fallbackPid)).toBe(false);
  });
});
