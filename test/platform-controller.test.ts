import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminalControlPaths,
  forcedTerminalMarkerJson,
  MarkerTerminalProcessController,
  writeTerminalMarker,
  writeTerminalStateMarker
} from '../src/platforms/controller.js';
import { buildCloseMacTerminalTabScript, parseMacTerminalIdentityOutput } from '../src/platforms/macos.js';
import { resolveWindowsControllerBackend } from '../src/platforms/windows.js';
import {
  buildPosixEnvPrefix,
  buildSupervisedPosixCommand,
  windowsBatchPath,
  windowsEchoEscape
} from '../src/shell.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'termhelm-controller-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writePowerShellFallback(path: string): void {
  writeFileSync(path, 'param([switch] $SelfTest)\nif ($SelfTest) { exit 0 }\n', 'utf8');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('terminal process controller', () => {
  it('uses manager-provided identities and writes v2 markers', () => {
    const directory = temporaryDirectory();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const targetId = '22222222-2222-4222-8222-222222222222';
    const control = createTerminalControlPaths({
      sessionId,
      id: targetId,
      controlDirectory: directory
    });

    expect(control.readyPath).toBe(join(directory, `${targetId}.ready.json`));
    expect(control.stoppedPath).toBe(join(directory, `${targetId}.stopped.json`));
    expect(existsSync(control.targetTokenPath)).toBe(true);

    writeTerminalStateMarker(control, 'ready');
    expect(JSON.parse(readFileSync(control.readyPath, 'utf8'))).toMatchObject({
      version: 2,
      sessionId,
      targetId,
      state: 'ready'
    });

    const controller = new MarkerTerminalProcessController(control);
    expect(controller.waitUntilReady(0)).toBe(true);
    controller.requestClose();
    expect(existsSync(control.targetTokenPath)).toBe(false);
    writeTerminalStateMarker(control, 'stopped');
    expect(controller.waitUntilStopped(0)).toBe(true);
    controller.dispose();
    expect(existsSync(directory)).toBe(true);
    expect(existsSync(control.stoppedPath)).toBe(true);
  });

  it('reports failed and forced terminal states without treating a PID as authority', () => {
    const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory() });
    const controller = new MarkerTerminalProcessController(control);
    writeTerminalMarker(control.forcedPath, forcedTerminalMarkerJson(control));
    writeTerminalStateMarker(control, 'failed');
    expect(controller.wasForced()).toBe(true);
    expect(controller.waitUntilReady(0)).toBe(false);
    expect(controller.waitUntilStopped(0)).toBe(true);
    controller.dispose();
    expect(existsSync(control.directory)).toBe(false);
  });
});

describe('POSIX managed wrapper', () => {
  it('only signals the live runner-owned group from inside its pinned group leader', () => {
    const sidecarSource = readFileSync('src/platforms/posix-sidecar.ts', 'utf8');
    expect(sidecarSource).toContain("process.kill(0, 'SIGTERM')");
    expect(sidecarSource).toContain("process.kill(0, 'SIGKILL')");
    expect(sidecarSource).toContain('process.kill(-processGroupId, 0)');
    expect(sidecarSource).not.toMatch(/process\.kill\(-[^,]+,\s*['"]SIG(?:TERM|KILL)['"]\)/);
  });

  it('owns a process group and acknowledges ready, forced, and stopped states', () => {
    const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory(), gracefulShutdownMs: 1200 });
    const command = buildSupervisedPosixCommand(
      { title: 'display only', cwd: '/tmp', command: 'node server.js' },
      {
        exitAfterCommand: true,
        posixSidecar: {
          executablePath: '/usr/bin/node',
          scriptPath: '/tmp/posix-sidecar.js',
          encodedPayload: 'payload'
        }
      },
      control
    );

    expect(command).toContain("run 'payload'");
    expect(command).toContain("wait-finalize 'payload' \"$runner_pid\"");
    expect(command).not.toContain('kill -TERM');
    expect(command).not.toContain('kill -KILL');
    expect(command).not.toContain('node server.js');
    expect(command).not.toContain('display only');
    expect(command.slice(command.indexOf('runner_status=0'))).not.toContain(control.failedPath);
    const runnerFunctionName = `termhelm_runner_${control.id.replace(/-/g, '_')}`;
    const guardedForeground = `fg '%?${runnerFunctionName}' || runner_status=$?`;
    expect(command).toContain(`${runnerFunctionName}() {`);
    expect(command).toContain('runner_status=0');
    expect(command).toContain(guardedForeground);
    expect(command.indexOf('runner_status=0')).toBeLessThan(command.indexOf(guardedForeground));
    expect(command.indexOf(guardedForeground)).toBeLessThan(command.indexOf('wait-finalize'));
    expect(command).not.toContain('fg %1');
  });

  it('fails closed through the bounded finalizer when ESRCH is not observed', () => {
    const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory() });
    const command = buildSupervisedPosixCommand(
      { title: 'sidecar', cwd: '/tmp', command: 'exit 0' },
      {
        exitAfterCommand: true,
        posixSidecar: {
          executablePath: '/usr/bin/node',
          scriptPath: '/tmp/posix-sidecar.js',
          encodedPayload: 'payload'
        }
      },
      control
    );

    expect(command).toContain("wait-finalize 'payload' \"$runner_pid\"");
    expect(command).toContain(control.failedPath);
    expect(command).not.toContain(control.stoppedPath);
  });

  it('fails before launch when the bundled POSIX sidecar is unavailable', () => {
    const control = createTerminalControlPaths({ stateDirectory: temporaryDirectory() });
    expect(() => buildSupervisedPosixCommand(
      { title: 'sidecar', cwd: '/tmp', command: 'exit 0' },
      { exitAfterCommand: true },
      control
    )).toThrow('Managed POSIX terminal mode requires its bundled controller sidecar.');
  });

  it('rejects environment names that would become shell syntax', () => {
    expect(() => buildPosixEnvPrefix({ 'A;touch /tmp/nope': 'value' })).toThrow('Invalid environment variable name');
  });
});

describe('platform identity safety', () => {
  it('builds macOS close logic from a window ID and tty, never a title', () => {
    const script = buildCloseMacTerminalTabScript(123, '/dev/ttys009').join('\n');
    expect(script).toContain('targetWindowId to 123');
    expect(script).toContain('targetTty to "/dev/ttys009"');
    expect(script).toContain('tty of targetTab is targetTty');
    expect(script).not.toContain('custom title');
  });

  it('identifies a launched macOS tab by TTY rather than the front window', () => {
    const macSource = readFileSync('src/platforms/macos.ts', 'utf8');
    expect(macSource).toContain('tty of candidateTab) as text) is targetTty');
    expect(macSource).toContain('id of candidateWindow');
    expect(macSource).not.toContain('id of front window');
  });

  it('treats malformed successful macOS identity output as an uncertain launch', () => {
    expect(parseMacTerminalIdentityOutput('123\n/dev/ttys009\n')).toEqual({
      windowId: 123,
      tty: '/dev/ttys009'
    });
    expect(() => parseMacTerminalIdentityOutput('123garbage\n/dev/ttys009\n')).toThrow(
      'Terminal launched but returned an invalid window identity.'
    );
    expect(() => parseMacTerminalIdentityOutput('123\n')).toThrow(
      'Terminal launched but returned an invalid window identity.'
    );
  });

  it('resolves the PowerShell controller only from the packaged layout', () => {
    const root = temporaryDirectory();
    const moduleDirectory = join(root, 'dist', 'platforms');
    const scriptDirectory = join(root, 'native', 'windows');
    const scriptPath = join(scriptDirectory, 'termhelm-controller.ps1');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(scriptDirectory, { recursive: true });
    writePowerShellFallback(scriptPath);
    const probe = vi.fn((executable: string) => executable === 'powershell.exe');

    expect(resolveWindowsControllerBackend({
      environment: {},
      moduleDirectory,
      powerShellExecutables: ['powershell.exe'],
      probe
    })).toEqual({
      executable: 'powershell.exe',
      scriptPath: realpathSync(scriptPath)
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      '-File', realpathSync(scriptPath), '-SelfTest'
    ]));
  });

  it('performs no host probes when the bundled PowerShell controller is missing', () => {
    const root = temporaryDirectory();
    const moduleDirectory = join(root, 'dist', 'platforms');
    mkdirSync(moduleDirectory, { recursive: true });
    const probe = vi.fn(() => true);

    expect(resolveWindowsControllerBackend({
      moduleDirectory,
      powerShellExecutables: ['pwsh', 'powershell.exe'],
      probe
    })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not search ancestor directories outside the canonical package root', () => {
    const workspace = temporaryDirectory();
    const packageRoot = join(workspace, 'package');
    const moduleDirectory = join(packageRoot, 'dist', 'platforms');
    const scriptDirectory = join(workspace, 'native', 'windows');
    const scriptPath = join(scriptDirectory, 'termhelm-controller.ps1');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(scriptDirectory, { recursive: true });
    writePowerShellFallback(scriptPath);
    const probe = vi.fn(() => true);

    expect(resolveWindowsControllerBackend({
      moduleDirectory,
      powerShellExecutables: ['powershell.exe'],
      probe
    })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked packaged PowerShell controller', () => {
    const workspace = temporaryDirectory();
    const packageRoot = join(workspace, 'package');
    const moduleDirectory = join(packageRoot, 'dist', 'platforms');
    const scriptDirectory = join(packageRoot, 'native', 'windows');
    const scriptPath = join(scriptDirectory, 'termhelm-controller.ps1');
    const externalScriptPath = join(workspace, 'external-controller.ps1');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(scriptDirectory, { recursive: true });
    writePowerShellFallback(externalScriptPath);
    symlinkSync(externalScriptPath, scriptPath);
    const probe = vi.fn(() => true);

    expect(resolveWindowsControllerBackend({
      moduleDirectory,
      powerShellExecutables: ['powershell.exe'],
      probe
    })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('defaults to probing pwsh before Windows PowerShell', () => {
    const scriptPath = join(temporaryDirectory(), 'termhelm-controller.ps1');
    writePowerShellFallback(scriptPath);
    const probe = vi.fn(() => false);

    expect(resolveWindowsControllerBackend({
      powerShellScriptPath: scriptPath,
      probe
    })).toBeNull();
    expect(probe.mock.calls.map(([executable]) => executable)).toEqual([
      'pwsh',
      'powershell.exe'
    ]);
  });

  it('selects pwsh and stops fallback probing after its self-test succeeds', () => {
    const scriptPath = join(temporaryDirectory(), 'termhelm-controller.ps1');
    writePowerShellFallback(scriptPath);
    const probe = vi.fn((executable: string) => executable === 'pwsh');

    expect(resolveWindowsControllerBackend({
      powerShellExecutables: ['pwsh', 'powershell.exe'],
      powerShellScriptPath: scriptPath,
      probe
    })).toEqual({ executable: 'pwsh', scriptPath });
    expect(probe.mock.calls.map(([executable]) => executable)).toEqual(['pwsh']);
  });

  it('tries Windows PowerShell after the pwsh self-test fails', () => {
    const scriptPath = join(temporaryDirectory(), 'termhelm-controller.ps1');
    writePowerShellFallback(scriptPath);
    const probe = vi.fn((executable: string) => executable === 'powershell.exe');

    expect(resolveWindowsControllerBackend({
      powerShellExecutables: ['pwsh', 'powershell.exe'],
      powerShellScriptPath: scriptPath,
      probe
    })).toEqual({ executable: 'powershell.exe', scriptPath });
    expect(probe.mock.calls.map(([executable]) => executable)).toEqual([
      'pwsh',
      'powershell.exe'
    ]);
  });

  it('skips empty and duplicate PowerShell hosts while preserving order', () => {
    const scriptPath = join(temporaryDirectory(), 'termhelm-controller.ps1');
    writePowerShellFallback(scriptPath);
    const probe = vi.fn(() => false);

    expect(resolveWindowsControllerBackend({
      powerShellExecutables: ['', 'pwsh', 'pwsh', '', 'powershell.exe', 'powershell.exe'],
      powerShellScriptPath: scriptPath,
      probe
    })).toBeNull();
    expect(probe.mock.calls.map(([executable]) => executable)).toEqual([
      'pwsh',
      'powershell.exe'
    ]);
  });

  it('returns no Windows backend when every PowerShell host probe fails', () => {
    const scriptPath = join(temporaryDirectory(), 'termhelm-controller.ps1');
    writePowerShellFallback(scriptPath);
    const probe = vi.fn(() => false);

    expect(resolveWindowsControllerBackend({
      powerShellExecutables: ['pwsh', 'powershell.exe'],
      powerShellScriptPath: scriptPath,
      probe
    })).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('implements Windows ownership with the PowerShell Job Object controller', () => {
    const controllerSource = readFileSync('native/windows/termhelm-controller.ps1', 'utf8');
    const windowsSource = readFileSync('src/platforms/windows.ts', 'utf8');
    expect(controllerSource).toContain('CreateJobObject');
    expect(controllerSource).toContain('AssignProcessToJobObject');
    expect(controllerSource).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(controllerSource).toContain('TerminateJobObject');
    expect(controllerSource).not.toContain('taskkill');
    expect(controllerSource).not.toContain('MainWindowTitle');
    expect(windowsSource).toContain('stoppingFile: control.stoppingPath');
    expect(windowsSource).not.toContain("controllerProcess.once('exit'");
    const childErrorListenerIndex = windowsSource.indexOf("controllerProcess.once('error'");
    const missingPidCheckIndex = windowsSource.indexOf('controllerProcess.pid === undefined');
    expect(childErrorListenerIndex).toBeGreaterThanOrEqual(0);
    expect(missingPidCheckIndex).toBeGreaterThan(childErrorListenerIndex);
    expect(windowsSource.slice(childErrorListenerIndex, missingPidCheckIndex)).not.toContain(
      'writeTerminalStateMarker'
    );
    expect(windowsSource).toContain('controller?.requestClose()');
    expect(windowsSource).toContain(`'  type "%TERMHELM_EXIT_MESSAGE_FILE%"'`);
    expect(windowsSource).toContain('createWindowsExitMessageFile(target.exitMessage, control)');
    expect(windowsSource).not.toContain('windowsEchoEscape(target.exitMessage)');
  });

  it('escapes Windows batch display data and rejects line injection', () => {
    expect(windowsEchoEscape('a|b%PATH%(c)')).toBe('a^|b%%PATH%%^(c^)');
    expect(windowsBatchPath('C:\\100% real')).toBe('"C:\\100%% real"');
    expect(() => windowsEchoEscape('safe\r\nwhoami')).toThrow('line breaks');
    expect(() => windowsBatchPath('C:\\bad"path')).toThrow('quotes');
  });
});
