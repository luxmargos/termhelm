import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startManagedTerminalWindows } from '../src/managed.js';
import { launchWindowsTerminalController } from '../src/platforms/windows.js';

const temporaryDirectories: string[] = [];
const unrelatedProcesses: ChildProcess[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'termhelm-native-test-'));
  temporaryDirectories.push(path);
  return path;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function windowsQuote(value: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error('Unsafe Windows integration-test path.');
  return `"${value}"`;
}

function treeScript(directory: string, ignoreBreak: boolean): string {
  const scriptPath = join(directory, ignoreBreak ? 'forced-tree.cjs' : 'graceful-tree.cjs');
  const startedPath = join(directory, ignoreBreak ? 'forced-started.txt' : 'graceful-started.txt');
  const stoppedPath = join(directory, 'graceful-signals.txt');
  writeFileSync(scriptPath, [
    "const { appendFileSync } = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    'const level = Number(process.argv[2] || 0);',
    `appendFileSync(${JSON.stringify(startedPath)}, level + '\\n');`,
    ignoreBreak
      ? "process.on('SIGBREAK', () => {});"
      : `process.on('SIGBREAK', () => { appendFileSync(${JSON.stringify(stoppedPath)}, level + '\\n'); process.exit(0); });`,
    `if (level < 2) spawn(process.execPath, [${JSON.stringify(scriptPath)}, String(level + 1)], { stdio: 'ignore', windowsHide: true });`,
    'setInterval(() => {}, 1000);'
  ].join('\r\n'));
  return scriptPath;
}

function payloadTreeScript(directory: string): string {
  const scriptPath = join(directory, 'payload-tree.cjs');
  const startedPath = join(directory, 'payload-started.txt');
  const valuesPath = join(directory, 'payload-values.txt');
  const stoppedPath = join(directory, 'payload-stopped.txt');
  writeFileSync(scriptPath, [
    "const { appendFileSync } = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    'const level = Number(process.argv[2] || 0);',
    `appendFileSync(${JSON.stringify(startedPath)}, level + '\\n');`,
    `appendFileSync(${JSON.stringify(valuesPath)}, JSON.stringify({ level, value: process.env.TERMHELM_PAYLOAD_TEST, emptyPresent: Object.prototype.hasOwnProperty.call(process.env, 'TERMHELM_EMPTY_TEST'), emptyValue: process.env.TERMHELM_EMPTY_TEST }) + '\\n');`,
    `process.on('SIGBREAK', () => { appendFileSync(${JSON.stringify(stoppedPath)}, level + '\\n'); process.exit(0); });`,
    `if (level < 2) spawn(process.execPath, [${JSON.stringify(scriptPath)}, String(level + 1)], { stdio: 'ignore', windowsHide: true });`,
    'setInterval(() => {}, 1000);'
  ].join('\r\n'));
  return scriptPath;
}

function powerShellHostAvailable(executable: string): boolean {
  if (process.platform !== 'win32') return false;
  const result = spawnSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command', 'exit 0'
  ], { stdio: 'ignore', windowsHide: true });
  return result.error === undefined && result.status === 0;
}

function powerShellPayloadExists(controller: { id: string; readyPath: string }): boolean {
  return readdirSync(dirname(controller.readyPath)).some(name =>
    name.endsWith(`.${controller.id}.controller.json`)
  );
}

function replacementTreeScript(directory: string): string {
  const scriptPath = join(directory, 'replacement-tree.cjs');
  writeFileSync(scriptPath, [
    "const { appendFileSync, writeFileSync } = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const net = require('node:net');",
    "const path = require('node:path');",
    'const directory = process.argv[2];',
    'const generation = process.argv[3];',
    'const level = Number(process.argv[4] || 0);',
    'const requestedPort = Number(process.argv[5] || 0);',
    "const marker = name => path.join(directory, generation + '-' + name + '.txt');",
    "appendFileSync(marker('started'), level + '\\n');",
    "process.on('SIGBREAK', () => { appendFileSync(marker('stopped'), level + '\\n'); process.exit(0); });",
    'let childrenStarted = false;',
    'function startChildren() {',
    '  if (childrenStarted) return;',
    '  childrenStarted = true;',
    `  if (level < 2) spawn(process.execPath, [${JSON.stringify(scriptPath)}, directory, generation, String(level + 1), String(requestedPort)], { stdio: 'ignore', windowsHide: true });`,
    '  setInterval(() => {}, 1000);',
    '}',
    'if (level !== 0) {',
    '  startChildren();',
    '} else {',
    '  const server = net.createServer();',
    "  server.once('error', error => {",
    "    writeFileSync(marker(error && error.code === 'EADDRINUSE' ? 'overlap' : 'bind-error'), String(error && (error.code || error.message) || error));",
    '    startChildren();',
    '  });',
    "  server.listen({ host: '127.0.0.1', port: requestedPort, exclusive: true }, () => {",
    '    const address = server.address();',
    "    writeFileSync(marker('port'), String(address.port));",
    '    startChildren();',
    '  });',
    '}'
  ].join('\r\n'));
  return scriptPath;
}

function replacementTreeCommand(
  scriptPath: string,
  directory: string,
  generation: 'old' | 'new',
  port: number
): string {
  return [process.execPath, scriptPath, directory, generation, '0', String(port)]
    .map(windowsQuote)
    .join(' ');
}

function waitForFileLines(path: string, expected: number, timeoutMs = 8_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      if (new Set(lines).size >= expected) return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for ${expected} process-tree markers in ${path}.`);
}

afterEach(() => {
  for (const child of unrelatedProcesses.splice(0)) {
    if (child.pid && processExists(child.pid)) child.kill('SIGKILL');
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'win32')('MSVC Windows Job Object controller integration', () => {
  it('gracefully stops a parent/child/grandchild tree with Ctrl+Break', () => {
    const directory = temporaryDirectory();
    const scriptPath = treeScript(directory, false);
    const startedPath = join(directory, 'graceful-started.txt');
    const signaledPath = join(directory, 'graceful-signals.txt');
    const controller = launchWindowsTerminalController(
      { title: 'same title', cwd: directory, command: `${windowsQuote(process.execPath)} ${windowsQuote(scriptPath)} 0` },
      { exitAfterCommand: true },
      { gracefulShutdownMs: 2_500 }
    );
    expect(controller.waitUntilReady(8_000)).toBe(true);
    waitForFileLines(startedPath, 3);
    expect(controller.close(10_000)).toBe(true);
    waitForFileLines(signaledPath, 3);
    expect(controller.wasForced()).toBe(false);
    controller.dispose();
  });

  it('force-terminates an ignoring tree while an unrelated process survives', () => {
    const directory = temporaryDirectory();
    const scriptPath = treeScript(directory, true);
    const startedPath = join(directory, 'forced-started.txt');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    unrelatedProcesses.push(unrelated);
    const controller = launchWindowsTerminalController(
      { title: 'same title', cwd: directory, command: `${windowsQuote(process.execPath)} ${windowsQuote(scriptPath)} 0` },
      { exitAfterCommand: true },
      { gracefulShutdownMs: 50 }
    );
    expect(controller.waitUntilReady(8_000)).toBe(true);
    waitForFileLines(startedPath, 3);
    expect(controller.close(10_000)).toBe(true);
    expect(controller.wasForced()).toBe(true);
    expect(unrelated.pid && processExists(unrelated.pid)).toBe(true);
    controller.dispose();
  });

  it('acknowledges natural exit and keeps an explicit fallback shell owned', () => {
    const directory = temporaryDirectory();
    const natural = launchWindowsTerminalController(
      { title: 'duplicate display', cwd: directory, command: 'exit /b 0' },
      { exitAfterCommand: true }
    );
    expect(natural.waitUntilReady(8_000)).toBe(true);
    expect(natural.waitUntilStopped(8_000)).toBe(true);
    expect(natural.wasForced()).toBe(false);
    natural.dispose();

    const fallback = launchWindowsTerminalController(
      { title: 'duplicate display', cwd: directory, command: 'ver >nul' },
      { exitAfterCommand: false },
      { gracefulShutdownMs: 100 }
    );
    expect(fallback.waitUntilReady(8_000)).toBe(true);
    expect(fallback.waitUntilStopped(100)).toBe(false);
    expect(fallback.close(10_000)).toBe(true);
    fallback.dispose();
  });

  it('replaces a real same-label tree without old/new process overlap', async () => {
    const directory = temporaryDirectory();
    const scriptPath = replacementTreeScript(directory);
    const options = {
      label: `windows-latest-wins-${randomUUID()}`,
      shutdownDelayMs: 1_000,
      closeWaitTimeoutMs: 5_000,
      replaceTimeoutMs: 9_000
    } as const;
    const first = startManagedTerminalWindows([{
      title: 'original display title',
      cwd: directory,
      command: replacementTreeCommand(scriptPath, directory, 'old', 0)
    }], options);
    let replacement: ReturnType<typeof startManagedTerminalWindows> | undefined;

    try {
      await first.ready;
      waitForFileLines(join(directory, 'old-started.txt'), 3);
      const oldPortPath = join(directory, 'old-port.txt');
      waitForFileLines(oldPortPath, 1);
      const oldPort = Number(readFileSync(oldPortPath, 'utf8').trim());
      expect(Number.isInteger(oldPort) && oldPort > 0 && oldPort <= 65_535).toBe(true);

      replacement = startManagedTerminalWindows([{
        title: 'renamed display title',
        cwd: directory,
        command: replacementTreeCommand(scriptPath, directory, 'new', oldPort)
      }], options);

      await replacement.ready;
      await expect(first.closed).resolves.toMatchObject({
        reason: 'replaced',
        forcedTargetIds: []
      });
      waitForFileLines(join(directory, 'old-stopped.txt'), 3);
      waitForFileLines(join(directory, 'new-started.txt'), 3);
      expect(existsSync(join(directory, 'new-overlap.txt'))).toBe(false);
      expect(existsSync(join(directory, 'new-bind-error.txt'))).toBe(false);
      waitForFileLines(join(directory, 'new-port.txt'), 1);

      await expect(replacement.close()).resolves.toMatchObject({
        reason: 'closed',
        forcedTargetIds: []
      });
      waitForFileLines(join(directory, 'new-stopped.txt'), 3);
    } finally {
      await replacement?.close().catch(() => undefined);
      await first.close().catch(() => undefined);
    }
  }, 30_000);
});

describe.skipIf(process.platform !== 'win32')('PowerShell Windows Job Object controller integration', () => {
  const scriptPath = join(process.cwd(), 'native', 'windows', 'termhelm-controller.ps1');
  const backends = [
    { name: 'PowerShell Core', executable: 'pwsh' },
    { name: 'Windows PowerShell 5.1', executable: 'powershell.exe' }
  ] as const;

  for (const backend of backends) {
    const available = powerShellHostAvailable(backend.executable);

    it.skipIf(!available)(
      `runs the PayloadPath lifecycle with ${backend.name}`,
      () => {
        const directory = temporaryDirectory();
        const commandScriptPath = payloadTreeScript(directory);
        const startedPath = join(directory, 'payload-started.txt');
        const valuesPath = join(directory, 'payload-values.txt');
        const stoppedPath = join(directory, 'payload-stopped.txt');
        const expectedValue = 'payload value "-SelfTest" & | %TEMP% !^';
        const controller = launchWindowsTerminalController(
          {
            title: '-PayloadPath is display data only',
            cwd: directory,
            command: `${windowsQuote(process.execPath)} ${windowsQuote(commandScriptPath)} 0`,
            env: {
              TERMHELM_PAYLOAD_TEST: expectedValue,
              TERMHELM_EMPTY_TEST: ''
            }
          },
          { exitAfterCommand: true },
          { gracefulShutdownMs: 2_500 },
          {
            kind: 'powershell',
            executable: backend.executable,
            scriptPath
          }
        );

        expect(controller.waitUntilReady(12_000)).toBe(true);
        expect(powerShellPayloadExists(controller)).toBe(false);
        waitForFileLines(startedPath, 3, 12_000);
        waitForFileLines(valuesPath, 3, 12_000);
        const values = readFileSync(valuesPath, 'utf8')
          .trim()
          .split(/\r?\n/)
          .map(line => JSON.parse(line) as {
            level: number;
            value: string;
            emptyPresent: boolean;
            emptyValue: string;
          })
          .sort((left, right) => left.level - right.level);
        expect(values).toEqual([
          { level: 0, value: expectedValue, emptyPresent: true, emptyValue: '' },
          { level: 1, value: expectedValue, emptyPresent: true, emptyValue: '' },
          { level: 2, value: expectedValue, emptyPresent: true, emptyValue: '' }
        ]);
        expect(controller.close(12_000)).toBe(true);
        waitForFileLines(stoppedPath, 3, 12_000);
        expect(controller.wasForced()).toBe(false);
        controller.dispose();
      },
      30_000
    );

    it.skipIf(!available)(
      `force-terminates an ignoring tree with ${backend.name} while preserving an unrelated process`,
      () => {
        const directory = temporaryDirectory();
        const commandScriptPath = treeScript(directory, true);
        const startedPath = join(directory, 'forced-started.txt');
        const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
          windowsHide: true
        });
        unrelatedProcesses.push(unrelated);
        const controller = launchWindowsTerminalController(
          {
            title: 'forced PowerShell display',
            cwd: directory,
            command: `${windowsQuote(process.execPath)} ${windowsQuote(commandScriptPath)} 0`
          },
          { exitAfterCommand: true, closeWaitTimeoutMs: 6_000 },
          { gracefulShutdownMs: 50 },
          {
            kind: 'powershell',
            executable: backend.executable,
            scriptPath
          }
        );

        expect(controller.waitUntilReady(12_000)).toBe(true);
        expect(powerShellPayloadExists(controller)).toBe(false);
        waitForFileLines(startedPath, 3, 12_000);
        expect(controller.close(12_000)).toBe(true);
        expect(controller.wasForced()).toBe(true);
        expect(unrelated.pid && processExists(unrelated.pid)).toBe(true);
        controller.dispose();
      },
      30_000
    );

    it.skipIf(!available)(
      `acknowledges natural target exit with ${backend.name}`,
      () => {
        const directory = temporaryDirectory();
        const controller = launchWindowsTerminalController(
          { title: 'natural PowerShell display', cwd: directory, command: 'exit /b 0' },
          { exitAfterCommand: true },
          {},
          {
            kind: 'powershell',
            executable: backend.executable,
            scriptPath
          }
        );

        expect(controller.waitUntilReady(12_000)).toBe(true);
        expect(powerShellPayloadExists(controller)).toBe(false);
        expect(controller.waitUntilStopped(12_000)).toBe(true);
        expect(controller.wasForced()).toBe(false);
        controller.dispose();
      },
      30_000
    );

    it.skipIf(!available)(
      `keeps the fallback shell owned and stops it when the supervisor token disappears with ${backend.name}`,
      () => {
        const directory = temporaryDirectory();
        const supervisorToken = join(directory, 'supervisor.alive');
        writeFileSync(supervisorToken, 'alive\n', 'utf8');
        const controller = launchWindowsTerminalController(
          { title: 'fallback PowerShell display', cwd: directory, command: 'ver >nul' },
          {
            exitAfterCommand: false,
            closeWaitTimeoutMs: 6_000,
            supervisorPid: process.pid,
            shutdownTokenPath: supervisorToken
          },
          { gracefulShutdownMs: 500 },
          {
            kind: 'powershell',
            executable: backend.executable,
            scriptPath
          }
        );

        expect(controller.waitUntilReady(12_000)).toBe(true);
        expect(powerShellPayloadExists(controller)).toBe(false);
        expect(controller.waitUntilStopped(150)).toBe(false);
        rmSync(supervisorToken, { force: true });
        expect(controller.waitUntilStopped(12_000)).toBe(true);
        controller.dispose();
      },
      30_000
    );
  }
});
