import type { TerminalLaunchOptions, TerminalTarget } from './types.js';

export function posixShellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function appleScriptString(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildPosixEnvPrefix(env?: Record<string, string>): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return '';
  return `${entries.map(([key, value]) => `${key}=${posixShellQuote(value)}`).join(' ')} `;
}

export function buildDefaultPosixCommand(target: TerminalTarget): string {
  const envPrefix = buildPosixEnvPrefix(target.env);
  const commands = [`cd ${posixShellQuote(target.cwd)} && ${envPrefix}${target.command}`];

  if (target.exitMessage) {
    commands.push(`printf '\n%s\n' ${posixShellQuote(target.exitMessage)}`);
  }

  commands.push('exec "${SHELL:-/bin/sh}" -l');
  return commands.join('; ');
}

export function buildSupervisedPosixCommand(
  target: TerminalTarget,
  options: TerminalLaunchOptions
): string {
  const envPrefix = buildPosixEnvPrefix(target.env);
  const shutdownCompletePath = options.shutdownCompletePath
    ? posixShellQuote(options.shutdownCompletePath)
    : null;
  const aliveChecks: string[] = [];

  if (options.supervisorPid) {
    aliveChecks.push(`kill -0 ${Number(options.supervisorPid)} 2>/dev/null`);
  }

  if (options.shutdownTokenPath) {
    aliveChecks.push(`test -e ${posixShellQuote(options.shutdownTokenPath)}`);
  }

  const isSupervisorAlive = aliveChecks.length > 0 ? aliveChecks.join(' && ') : ':';
  const commands = [
    `cd ${posixShellQuote(target.cwd)} || exit 1`,
    "set -m || { printf '%s\\n' 'This shell does not support job control, so managed terminal mode cannot run.'; exit 1; }",
    `(${envPrefix}${target.command}) &`,
    'child_pid=$!',
    '(',
    `  while ${isSupervisorAlive}; do`,
    '    sleep 1',
    '  done',
    '  kill -TERM "-$child_pid" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null || true',
    '  sleep 2',
    '  kill -KILL "-$child_pid" 2>/dev/null || kill -KILL "$child_pid" 2>/dev/null || true',
    ') &',
    'watchdog_pid=$!',
    'fg %1',
    'status=$?',
    'kill "$watchdog_pid" 2>/dev/null || true',
    'wait "$watchdog_pid" 2>/dev/null || true'
  ];

  if (target.exitMessage) {
    commands.push(`printf '\n%s\n' ${posixShellQuote(target.exitMessage)}`);
  }

  if (shutdownCompletePath) {
    commands.push(`: > ${shutdownCompletePath} 2>/dev/null || true`);
  }

  commands.push(options.exitAfterCommand ? 'exit "$status"' : 'exec "${SHELL:-/bin/sh}" -l');
  return commands.join('\n');
}

export function buildPosixCommand(
  target: TerminalTarget,
  options: TerminalLaunchOptions = {}
): string {
  if (options.supervisorPid || options.shutdownTokenPath) {
    return buildSupervisedPosixCommand(target, options);
  }
  return buildDefaultPosixCommand(target);
}

export function windowsCmdQuote(value: string): string {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function windowsEchoEscape(value: string): string {
  return String(value).replace(/\^/g, '^^').replace(/&/g, '^&').replace(/</g, '^<').replace(/>/g, '^>');
}

export function powershellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
