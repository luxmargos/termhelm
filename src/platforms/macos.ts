import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TerminalLaunchOptions, TerminalTarget } from '../types.js';
import { appleScriptString, buildPosixCommand } from '../shell.js';

export function launchMacTerminal(target: TerminalTarget, options: TerminalLaunchOptions = {}): number | null {
  const command = buildPosixCommand(target, options);
  const result = spawnSync('osascript', [
    '-e', 'tell application "Terminal"',
    '-e', `set targetTab to do script ${appleScriptString(command)}`,
    '-e', `set custom title of targetTab to ${appleScriptString(target.title)}`,
    '-e', 'activate',
    '-e', 'return id of front window',
    '-e', 'end tell'
  ], { encoding: 'utf8' });

  if (result.error) throw new Error(`Failed to launch Terminal: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Terminal launch command failed with exit code ${result.status}.\n${result.stderr}`);
  }
  const windowId = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(windowId) ? windowId : null;
}

function areMacTerminalWindowsIdle(windowIds: number[]): boolean {
  if (windowIds.length === 0) return true;
  const result = spawnSync('osascript', [
    '-e', 'tell application "Terminal"',
    '-e', `set targetWindowIds to {${windowIds.join(',')}}`,
    '-e', 'repeat with targetWindowId in targetWindowIds',
    '-e', '  try',
    '-e', '    set targetWindow to first window whose id is targetWindowId',
    '-e', '    repeat with targetTab in tabs of targetWindow',
    '-e', '      if busy of targetTab then return "busy"',
    '-e', '    end repeat',
    '-e', '  end try',
    '-e', 'end repeat',
    '-e', 'return "idle"',
    '-e', 'end tell'
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return false;
  return result.stdout.trim() === 'idle';
}

export function waitForMacTerminalWindowsToSettle(windowIds: number[], shutdownCompletePaths: string[], timeoutMs: number): void {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const completed = shutdownCompletePaths.length > 0 && shutdownCompletePaths.every(path => existsSync(path));
    if (completed || areMacTerminalWindowsIdle(windowIds)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

export function closeMacTerminalWindows(windowIds: number[], options: { titles?: string[]; useCustomTitleClose?: boolean } = {}): void {
  if (windowIds.length === 0 && !options.useCustomTitleClose) return;
  const script: string[] = ['tell application "Terminal"'];
  if (options.useCustomTitleClose && options.titles?.length) {
    const titles = options.titles.map(appleScriptString).join(',');
    script.push(
      `set targetTitles to {${titles}}`,
      'repeat with targetTitle in targetTitles',
      '  repeat with targetWindow in windows',
      '    repeat with targetTab in tabs of targetWindow',
      '      if custom title of targetTab is targetTitle then',
      '        try',
      '          close targetWindow',
      '        end try',
      '        exit repeat',
      '      end if',
      '    end repeat',
      '  end repeat',
      'end repeat'
    );
  } else {
    script.push(
      `set targetWindowIds to {${windowIds.join(',')}}`,
      'repeat with targetWindowId in targetWindowIds',
      '  try',
      '    close first window whose id is targetWindowId',
      '  end try',
      'end repeat'
    );
  }
  script.push('end tell');
  spawnSync('osascript', script.flatMap(line => ['-e', line]), { stdio: 'ignore' });
}
