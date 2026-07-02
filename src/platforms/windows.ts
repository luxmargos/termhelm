import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalLaunchOptions, TerminalTarget } from '../types.js';
import { powershellQuote, windowsCmdQuote, windowsEchoEscape } from '../shell.js';

function createWindowsCommandFile(target: TerminalTarget): string {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-windows-command-'));
  const commandFile = join(directory, 'command.cmd');
  const envLines = Object.entries(target.env ?? {}).map(([key, value]) => `set "${key}=${value}"`);
  const lines = ['@echo off', `title ${target.title}`, `cd /d ${windowsCmdQuote(target.cwd)}`, ...envLines, target.command, 'set TERMINAL_WINDOWS_EXIT_CODE=%ERRORLEVEL%'];
  if (target.exitMessage) lines.push('echo.', `echo ${windowsEchoEscape(target.exitMessage)}`);
  lines.push('exit /b %TERMINAL_WINDOWS_EXIT_CODE%');
  writeFileSync(commandFile, lines.join('\r\n'), 'utf8');
  return commandFile;
}

function buildWindowsWatchdogFile(options: TerminalLaunchOptions, devServerPid: number): string {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-windows-watchdog-'));
  const watchdogFile = join(directory, 'watchdog.ps1');
  const checks: string[] = [];
  if (options.supervisorPid) checks.push(`Get-Process -Id ${Number(options.supervisorPid)} -ErrorAction SilentlyContinue`);
  if (options.shutdownTokenPath) checks.push(`Test-Path -LiteralPath ${powershellQuote(options.shutdownTokenPath)}`);
  const condition = checks.length ? checks.map(check => `(${check})`).join(' -and ') : '$true';
  const completion = options.shutdownCompletePath ? `New-Item -ItemType File -Path ${powershellQuote(options.shutdownCompletePath)} -Force | Out-Null` : '';
  writeFileSync(watchdogFile, [`$devServerPid = ${devServerPid}`, `while (${condition}) { Start-Sleep -Seconds 1 }`, 'Stop-Process -Id $devServerPid -Force -ErrorAction SilentlyContinue', completion].join('\r\n'), 'utf8');
  return watchdogFile;
}

function startWindowsProcessAndGetPid(comspec: string, commandFile: string): number | null {
  const psCommand = ['$process = Start-Process', `-FilePath ${powershellQuote(comspec)}`, `-ArgumentList '/d','/s','/c',${powershellQuote(commandFile)}`, '-WindowStyle Normal', '-PassThru;', '$process.Id'].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8' });
  if (result.error) throw new Error(`Failed to launch Windows terminal command: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Windows terminal launch command failed with exit code ${result.status}.\n${result.stderr}`);
  const pid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

export function launchWindowsTerminal(target: TerminalTarget, options: TerminalLaunchOptions = {}): number | null {
  const comspec = process.env.ComSpec || 'cmd.exe';
  const commandFile = createWindowsCommandFile(target);
  const pid = startWindowsProcessAndGetPid(comspec, commandFile);
  if (pid !== null && (options.supervisorPid || options.shutdownTokenPath)) {
    const watchdogFile = buildWindowsWatchdogFile(options, pid);
    const watchdog = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', watchdogFile], { detached: true, stdio: 'ignore' });
    watchdog.unref();
  }
  return pid;
}

export function closeWindowsTerminalWindows(pids: number[]): void {
  for (const pid of pids) {
    try {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore' });
    } catch {
      // Ignore processes that already exited.
    }
  }
}
