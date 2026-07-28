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
import {
  resolveWindowsControllerBackend,
  resolveWindowsControllerHelperPath
} from '../src/platforms/windows.js';
import {
  buildPosixEnvPrefix,
  buildSupervisedPosixCommand,
  windowsBatchPath,
  windowsEchoEscape
} from '../src/shell.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-windows-controller-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFakeWindowsControllerHelper(path: string, machine = 0x8664): void {
  const executable = Buffer.alloc(0x100);
  executable.writeUInt16LE(0x5a4d, 0);
  executable.writeUInt32LE(0x80, 0x3c);
  executable.writeUInt32LE(0x0000_4550, 0x80);
  executable.writeUInt16LE(machine, 0x84);
  writeFileSync(path, executable);
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
    expect(command.slice(command.indexOf('runner_status=$?'))).not.toContain(control.failedPath);
    const runnerFunctionName = `terminal_windows_runner_${control.id.replace(/-/g, '_')}`;
    expect(command).toContain(`${runnerFunctionName}() {`);
    expect(command).toContain(`fg '%?${runnerFunctionName}'`);
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

  it('fails closed when a configured Windows helper is missing', () => {
    expect(resolveWindowsControllerHelperPath({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: join(temporaryDirectory(), 'missing.exe') },
      architecture: 'x64',
      moduleDirectory: temporaryDirectory()
    })).toBeNull();
  });

  it('accepts only an existing explicitly configured Windows helper', () => {
    const helperPath = join(temporaryDirectory(), 'controller.exe');
    writeFakeWindowsControllerHelper(helperPath);
    expect(resolveWindowsControllerHelperPath({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: helperPath },
      architecture: 'x64',
      moduleDirectory: temporaryDirectory()
    })).toBe(helperPath);
  });

  it('rejects malformed, architecture-mismatched, and unsupported Windows helpers', () => {
    const malformedHelper = join(temporaryDirectory(), 'malformed.exe');
    writeFileSync(malformedHelper, 'not a PE executable');
    expect(resolveWindowsControllerHelperPath({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: malformedHelper },
      architecture: 'x64',
      moduleDirectory: temporaryDirectory()
    })).toBeNull();

    const arm64Helper = join(temporaryDirectory(), 'arm64-controller.exe');
    writeFakeWindowsControllerHelper(arm64Helper, 0xaa64);
    expect(resolveWindowsControllerHelperPath({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: arm64Helper },
      architecture: 'x64',
      moduleDirectory: temporaryDirectory()
    })).toBeNull();
    expect(resolveWindowsControllerHelperPath({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: arm64Helper },
      architecture: 'ia32',
      moduleDirectory: temporaryDirectory()
    })).toBeNull();
  });

  it('resolves the packaged Windows helper layout', () => {
    const root = temporaryDirectory();
    const moduleDirectory = join(root, 'dist', 'platforms');
    const helperDirectory = join(root, 'native', 'win32-x64');
    const helperPath = join(helperDirectory, 'terminal-windows-controller.exe');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(helperDirectory, { recursive: true });
    writeFakeWindowsControllerHelper(helperPath);
    expect(resolveWindowsControllerHelperPath({
      environment: {},
      architecture: 'x64',
      moduleDirectory
    })).toBe(realpathSync(helperPath));
  });

  it('resolves the PowerShell fallback only from the packaged layout', () => {
    const root = temporaryDirectory();
    const moduleDirectory = join(root, 'dist', 'platforms');
    const scriptDirectory = join(root, 'native', 'windows');
    const scriptPath = join(scriptDirectory, 'terminal-windows-controller.ps1');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(scriptDirectory, { recursive: true });
    writePowerShellFallback(scriptPath);
    const probe = vi.fn((executable: string) => executable === 'powershell.exe');

    expect(resolveWindowsControllerBackend({
      environment: {},
      architecture: 'x64',
      moduleDirectory,
      powerShellExecutables: ['powershell.exe'],
      probe
    })).toEqual({
      kind: 'powershell',
      executable: 'powershell.exe',
      scriptPath: realpathSync(scriptPath)
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      '-File', realpathSync(scriptPath), '-SelfTest'
    ]));
  });

  it('does not search ancestor directories outside the canonical package root', () => {
    const workspace = temporaryDirectory();
    const packageRoot = join(workspace, 'package');
    const moduleDirectory = join(packageRoot, 'dist', 'platforms');
    const ancestorNativeDirectory = join(workspace, 'native');
    const helperDirectory = join(ancestorNativeDirectory, 'win32-x64');
    const helperPath = join(helperDirectory, 'terminal-windows-controller.exe');
    const scriptDirectory = join(ancestorNativeDirectory, 'windows');
    const scriptPath = join(scriptDirectory, 'terminal-windows-controller.ps1');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(helperDirectory, { recursive: true });
    mkdirSync(scriptDirectory, { recursive: true });
    writeFakeWindowsControllerHelper(helperPath);
    writePowerShellFallback(scriptPath);
    const probe = vi.fn(() => true);

    expect(resolveWindowsControllerHelperPath({
      environment: {},
      architecture: 'x64',
      moduleDirectory
    })).toBeNull();
    expect(resolveWindowsControllerBackend({
      environment: {},
      architecture: 'x64',
      moduleDirectory,
      powerShellExecutables: ['powershell.exe'],
      probe
    })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked packaged Windows controller assets', () => {
    const workspace = temporaryDirectory();
    const packageRoot = join(workspace, 'package');
    const moduleDirectory = join(packageRoot, 'dist', 'platforms');
    const helperDirectory = join(packageRoot, 'native', 'win32-x64');
    const helperPath = join(helperDirectory, 'terminal-windows-controller.exe');
    const scriptDirectory = join(packageRoot, 'native', 'windows');
    const scriptPath = join(scriptDirectory, 'terminal-windows-controller.ps1');
    const externalHelperPath = join(workspace, 'external-controller.exe');
    const externalScriptPath = join(workspace, 'external-controller.ps1');
    mkdirSync(moduleDirectory, { recursive: true });
    mkdirSync(helperDirectory, { recursive: true });
    mkdirSync(scriptDirectory, { recursive: true });
    writeFakeWindowsControllerHelper(externalHelperPath);
    writePowerShellFallback(externalScriptPath);
    symlinkSync(externalHelperPath, helperPath);
    symlinkSync(externalScriptPath, scriptPath);
    const probe = vi.fn(() => true);

    expect(resolveWindowsControllerHelperPath({
      environment: {},
      architecture: 'x64',
      moduleDirectory
    })).toBeNull();
    expect(resolveWindowsControllerBackend({
      environment: {},
      architecture: 'x64',
      moduleDirectory,
      powerShellExecutables: ['powershell.exe'],
      probe
    })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('prefers a healthy native Windows controller over PowerShell', () => {
    const root = temporaryDirectory();
    const helperPath = join(root, 'controller.exe');
    const scriptPath = join(root, 'terminal-windows-controller.ps1');
    writeFakeWindowsControllerHelper(helperPath);
    writePowerShellFallback(scriptPath);
    const probe = vi.fn(() => true);

    expect(resolveWindowsControllerBackend({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: helperPath },
      architecture: 'x64',
      moduleDirectory: root,
      powerShellExecutables: ['pwsh', 'powershell.exe'],
      powerShellScriptPath: scriptPath,
      probe
    })).toEqual({ kind: 'native', helperPath });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(helperPath, ['--self-test']);
  });

  it.each(['missing', 'corrupt'] as const)(
    'falls back to pwsh when the native controller is %s',
    nativeState => {
      const root = temporaryDirectory();
      const helperPath = join(root, 'controller.exe');
      const scriptPath = join(root, 'terminal-windows-controller.ps1');
      if (nativeState === 'corrupt') writeFileSync(helperPath, 'not a PE executable');
      writePowerShellFallback(scriptPath);
      const probe = vi.fn((executable: string) => executable === 'pwsh');

      expect(resolveWindowsControllerBackend({
        environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: helperPath },
        architecture: 'x64',
        moduleDirectory: root,
        powerShellExecutables: ['pwsh', 'powershell.exe'],
        powerShellScriptPath: scriptPath,
        probe
      })).toEqual({ kind: 'powershell', executable: 'pwsh', scriptPath });
      expect(probe.mock.calls.map(([executable]) => executable)).toEqual(['pwsh']);
      expect(probe.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
        '-File', scriptPath, '-SelfTest'
      ]));
    }
  );

  it('falls through failed native and pwsh probes to Windows PowerShell', () => {
    const root = temporaryDirectory();
    const helperPath = join(root, 'controller.exe');
    const scriptPath = join(root, 'terminal-windows-controller.ps1');
    writeFakeWindowsControllerHelper(helperPath);
    writePowerShellFallback(scriptPath);
    const probe = vi.fn((executable: string) => executable === 'powershell.exe');

    expect(resolveWindowsControllerBackend({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: helperPath },
      architecture: 'x64',
      moduleDirectory: root,
      powerShellExecutables: ['pwsh', 'powershell.exe'],
      powerShellScriptPath: scriptPath,
      probe
    })).toEqual({ kind: 'powershell', executable: 'powershell.exe', scriptPath });
    expect(probe.mock.calls.map(([executable]) => executable)).toEqual([
      helperPath,
      'pwsh',
      'powershell.exe'
    ]);
  });

  it('returns no Windows backend when every pre-launch probe fails', () => {
    const root = temporaryDirectory();
    const helperPath = join(root, 'controller.exe');
    const scriptPath = join(root, 'terminal-windows-controller.ps1');
    writeFakeWindowsControllerHelper(helperPath);
    writePowerShellFallback(scriptPath);
    const probe = vi.fn(() => false);

    expect(resolveWindowsControllerBackend({
      environment: { TERMINAL_WINDOWS_CONTROLLER_HELPER: helperPath },
      architecture: 'x64',
      moduleDirectory: root,
      powerShellExecutables: ['pwsh', 'powershell.exe'],
      powerShellScriptPath: scriptPath,
      probe
    })).toBeNull();
    expect(probe.mock.calls.map(([executable]) => executable)).toEqual([
      helperPath,
      'pwsh',
      'powershell.exe'
    ]);
  });

  it('implements Windows ownership with retained handles and a Job Object', () => {
    const helperSource = readFileSync('native/windows/terminal-windows-controller.cpp', 'utf8');
    const fallbackSource = readFileSync('native/windows/terminal-windows-controller.ps1', 'utf8');
    const windowsSource = readFileSync('src/platforms/windows.ts', 'utf8');
    const buildSource = readFileSync('native/windows/build.ps1', 'utf8');
    expect(helperSource).toContain('CreateJobObject');
    expect(helperSource).toContain('AssignProcessToJobObject');
    expect(helperSource).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(helperSource).toContain('TerminateJobObject');
    expect(helperSource).toContain('OpenProcess(SYNCHRONIZE');
    expect(helperSource).not.toContain('CREATE_NEW_PROCESS_GROUP');
    expect(helperSource).toContain('AttachManagedConsole(child.dwProcessId)');
    expect(helperSource).toContain('SetConsoleCtrlHandler(IgnoreManagedConsoleControl, TRUE)');
    expect(helperSource).toContain('GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0)');
    expect(helperSource).toContain('"stopping", 2');
    expect(helperSource.match(/WaitForJobEmpty\(job\.get\(\), force_wait_ms\)/g)).toHaveLength(2);
    expect(helperSource).toContain('if (termination_confirmed)');
    expect(helperSource).toContain("command_file.find(L'%')");
    expect(windowsSource).toContain("'--stopping-file', values.stoppingFile");
    expect(windowsSource).toContain('stoppingFile: control.stoppingPath');
    expect(windowsSource).not.toContain("helper.once('exit'");
    const childErrorListenerIndex = windowsSource.indexOf("helper.once('error'");
    const missingPidCheckIndex = windowsSource.indexOf('helper.pid === undefined');
    expect(childErrorListenerIndex).toBeGreaterThanOrEqual(0);
    expect(missingPidCheckIndex).toBeGreaterThan(childErrorListenerIndex);
    expect(windowsSource.slice(childErrorListenerIndex, missingPidCheckIndex)).not.toContain(
      'writeTerminalStateMarker'
    );
    expect(windowsSource).toContain('controller?.requestClose()');
    expect(windowsSource).toContain(`'  type "%TERMINAL_WINDOWS_EXIT_MESSAGE_FILE%"'`);
    expect(windowsSource).toContain('TERMINAL_WINDOWS_EXIT_MESSAGE_FILE: exitMessageFile');
    expect(windowsSource).toContain('createWindowsExitMessageFile(target.exitMessage, control)');
    expect(windowsSource).not.toContain('windowsEchoEscape(target.exitMessage)');
    expect(buildSource).toContain('cl.exe');
    expect(helperSource).not.toContain('taskkill');
    expect(helperSource).not.toContain('MainWindowTitle');
    expect(fallbackSource).toContain('CreateJobObject');
    expect(fallbackSource).toContain('AssignProcessToJobObject');
    expect(fallbackSource).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(fallbackSource).not.toContain('taskkill');
    expect(fallbackSource).not.toContain('MainWindowTitle');
  });

  it('escapes Windows batch display data and rejects line injection', () => {
    expect(windowsEchoEscape('a|b%PATH%(c)')).toBe('a^|b%%PATH%%^(c^)');
    expect(windowsBatchPath('C:\\100% real')).toBe('"C:\\100%% real"');
    expect(() => windowsEchoEscape('safe\r\nwhoami')).toThrow('line breaks');
    expect(() => windowsBatchPath('C:\\bad"path')).toThrow('quotes');
  });
});
