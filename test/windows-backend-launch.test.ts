import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessActivity = vi.hoisted(() => ({
  spawn: vi.fn()
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: childProcessActivity.spawn };
});

import { launchWindowsTerminalController } from '../src/platforms/windows.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'termhelm-backend-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  childProcessActivity.spawn.mockReset();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows controller backend launch boundary', () => {
  it('does not retry another PowerShell host after the selected controller starts', () => {
    let onError: ((error: Error) => void) | undefined;
    childProcessActivity.spawn.mockReturnValue({
      pid: 4321,
      once: vi.fn((event: string, listener: (error: Error) => void) => {
        if (event === 'error') onError = listener;
      }),
      unref: vi.fn()
    });
    const directory = temporaryDirectory();
    const scriptPath = join(directory, 'termhelm-controller.ps1');
    const controller = launchWindowsTerminalController(
      { title: 'display only', cwd: directory, command: 'ver >nul' },
      { exitAfterCommand: true },
      { stateDirectory: join(directory, 'state') },
      { executable: 'pwsh', scriptPath }
    );

    expect(childProcessActivity.spawn).toHaveBeenCalledOnce();
    expect(childProcessActivity.spawn.mock.calls[0]?.[0]).toBe('pwsh');
    expect(onError).toBeTypeOf('function');
    onError!(new Error('selected controller failed after spawn'));
    expect(childProcessActivity.spawn).toHaveBeenCalledOnce();
    expect(controller.controllerPid).toBe(4321);
    expect(controller.terminalUiOutcome(false)).toBe('host-managed');
    expect(controller.terminalUiOutcome(true)).toBe('host-managed');
  });

  it('does not retry another PowerShell host when spawning the selected host throws', () => {
    childProcessActivity.spawn.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const directory = temporaryDirectory();

    expect(() => launchWindowsTerminalController(
      { title: 'display only', cwd: directory, command: 'ver >nul' },
      { exitAfterCommand: true },
      { stateDirectory: join(directory, 'state') },
      { executable: 'pwsh', scriptPath: join(directory, 'termhelm-controller.ps1') }
    )).toThrow('spawn failed');
    expect(childProcessActivity.spawn).toHaveBeenCalledOnce();
  });

  it('rejects case-insensitive duplicate Windows environment names', () => {
    childProcessActivity.spawn.mockReturnValue({ pid: 4329, once: vi.fn(), unref: vi.fn() });
    const directory = temporaryDirectory();
    expect(() => launchWindowsTerminalController({
      title: 'duplicate environment',
      cwd: directory,
      command: 'ver >nul',
      env: { Path: 'first', PATH: 'second' }
    }, {}, { stateDirectory: join(directory, 'state') }, {
      executable: 'powershell.exe',
      scriptPath: join(directory, 'termhelm-controller.ps1')
    })).toThrow('case-insensitive');
    expect(childProcessActivity.spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('keeps default plain launch state out of a deliberately shared TEMP parent', () => {
    childProcessActivity.spawn.mockReturnValue({ pid: 4330, once: vi.fn(), unref: vi.fn() });
    const sharedParent = temporaryDirectory();
    const powershell = join(
      process.env.SystemRoot!,
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    const broaden = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('TERMHELM_TEST_SHARED_PARENT')
$acl = Get-Acl -LiteralPath $path
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;
    const broadened = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(broaden, 'utf16le').toString('base64')
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, TERMHELM_TEST_SHARED_PARENT: sharedParent }
    });
    expect(broadened.error).toBeUndefined();
    expect(broadened.status, broadened.stderr).toBe(0);

    const controller = launchWindowsTerminalController({
      title: 'plain ACL',
      cwd: sharedParent,
      command: 'ver >nul',
      env: { TERMHELM_SECRET: 'private' },
      exitMessage: 'complete'
    }, {}, {}, {
      executable: 'powershell.exe',
      scriptPath: join(sharedParent, 'termhelm-controller.ps1')
    });
    const controlDirectory = dirname(controller.readyPath);
    temporaryDirectories.push(controlDirectory);
    expect(controlDirectory.startsWith(sharedParent)).toBe(false);
    const paths = [
      controlDirectory,
      ...readdirSync(controlDirectory).map(name => join(controlDirectory, name))
    ];
    const verify = String.raw`
$ErrorActionPreference = 'Stop'
$paths = @([Environment]::GetEnvironmentVariable('TERMHELM_TEST_ACL_PATHS') | ConvertFrom-Json)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$system = 'S-1-5-18'
foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user) { throw "Owner mismatch: $path" }
  if ($path -eq $paths[0] -and -not $acl.AreAccessRulesProtected) { throw "Control ACL is not protected: $path" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($sid -ne $user -and $sid -ne $system) { throw "Unexpected ACL principal: $sid on $path" }
  }
}
`;
    const verified = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(verify, 'utf16le').toString('base64')
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, TERMHELM_TEST_ACL_PATHS: JSON.stringify(paths) }
    });
    expect(verified.error).toBeUndefined();
    expect(verified.status, verified.stderr).toBe(0);
  });

  it('launches only the PowerShell backend selected during preflight', () => {
    childProcessActivity.spawn.mockReturnValue({
      pid: 4322,
      once: vi.fn(),
      unref: vi.fn()
    });
    const directory = temporaryDirectory();
    const scriptPath = join(directory, 'termhelm-controller.ps1');
    const controller = launchWindowsTerminalController(
      {
        title: '-SelfTest display only',
        cwd: directory,
        command: 'ver >nul',
        env: { TEMP: '-target-only-temp' }
      },
      { exitAfterCommand: true },
      { stateDirectory: join(directory, 'state') },
      { executable: 'powershell.exe', scriptPath }
    );

    expect(childProcessActivity.spawn).toHaveBeenCalledOnce();
    expect(childProcessActivity.spawn.mock.calls[0]?.[0]).toBe('powershell.exe');
    const args = childProcessActivity.spawn.mock.calls[0]?.[1] as string[];
    const payloadIndex = args.indexOf('-PayloadPath');
    const payloadPath = args[payloadIndex + 1]!;
    expect(args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-PayloadPath', payloadPath
    ]);
    expect(args).not.toContain('-SelfTest display only');
    expect(args).not.toContain('-target-only-temp');
    for (const legacyFlag of [
      '-CommandFile',
      '-Comspec',
      '-Cwd',
      '-Title',
      '-SessionId',
      '-TargetId',
      '-TargetToken',
      '-ReadyFile',
      '-StoppingFile',
      '-StoppedFile',
      '-FailedFile',
      '-ForcedFile',
      '-GraceMs',
      '-ForceWaitMs',
      '-SupervisorPid',
      '-ShutdownToken',
      '-ControlEndpoint',
      '-ControlToken'
    ]) {
      expect(args).not.toContain(legacyFlag);
    }
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    expect(basename(payloadPath)).toBe(
      `${payload.sessionId}.${payload.targetId}.controller.json`
    );
    expect(payload).toMatchObject({
      cwd: directory,
      title: '-SelfTest display only',
      environment: [{ key: 'TEMP', value: '-target-only-temp' }],
      commandFile: expect.stringMatching(/\.cmd$/)
    });
    expect(childProcessActivity.spawn.mock.calls[0]?.[2]?.env).not.toMatchObject({
      TEMP: '-target-only-temp'
    });
    expect(controller.controllerPid).toBe(4322);
  });
});
