import { describe, expect, it, vi } from 'vitest';
import { runWindowsHelperBuild } from '../scripts/build-windows-helper.mjs';

function missingCommand(command: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
}

describe('Windows helper PowerShell launcher', () => {
  it('prefers pwsh and forwards the build arguments', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null }));

    expect(runWindowsHelperBuild(['-Architecture', 'x64'], {
      spawn,
      buildScriptPath: 'C:\\repo\\native\\windows\\build.ps1',
      report: vi.fn()
    })).toBe(0);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', 'C:\\repo\\native\\windows\\build.ps1',
      '-Architecture', 'x64'
    ], { stdio: 'inherit' });
  });

  it('falls back to powershell.exe only when pwsh is missing', () => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: null, signal: null, error: missingCommand('pwsh') })
      .mockReturnValueOnce({ status: 0, signal: null });
    const report = vi.fn();

    expect(runWindowsHelperBuild(['-Architecture', 'arm64'], {
      spawn,
      buildScriptPath: 'build.ps1',
      report
    })).toBe(0);
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(['pwsh', 'powershell.exe']);
    expect(report).toHaveBeenCalledWith(
      'pwsh was not found; falling back to Windows PowerShell (powershell.exe).'
    );
  });

  it('does not hide a real pwsh build failure with the legacy fallback', () => {
    const spawn = vi.fn(() => ({ status: 7, signal: null }));

    expect(runWindowsHelperBuild(['-Architecture', 'x64'], {
      spawn,
      buildScriptPath: 'build.ps1',
      report: vi.fn()
    })).toBe(7);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('reports an error when neither PowerShell executable exists', () => {
    const spawn = vi.fn((command: string) => ({
      status: null,
      signal: null,
      error: missingCommand(command)
    }));
    const report = vi.fn();

    expect(runWindowsHelperBuild([], { spawn, buildScriptPath: 'build.ps1', report })).toBe(1);
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(['pwsh', 'powershell.exe']);
    expect(report).toHaveBeenLastCalledWith(
      'Neither pwsh nor powershell.exe was found. Install PowerShell or run this build on Windows.'
    );
  });
});
