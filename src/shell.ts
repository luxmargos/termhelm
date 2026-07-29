import type { InternalTerminalLaunchOptions, TerminalTarget } from './types.js';
import {
  terminalMarkerJson,
  type TerminalControlPaths
} from './platforms/controller.js';

export function posixShellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function appleScriptString(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildPosixEnvPrefix(env?: Record<string, string>): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return '';
  return `${entries.map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    return `${key}=${posixShellQuote(value)}`;
  }).join(' ')} `;
}

function buildPosixMarkerCommands(variableName: string, path: string, value: string): string[] {
  const quotedPath = posixShellQuote(path);
  return [
    `${variableName}=${quotedPath}.$$.tmp`,
    `printf '%s\\n' ${posixShellQuote(value)} > "$${variableName}" && chmod 600 "$${variableName}" && mv -f "$${variableName}" ${quotedPath}`
  ];
}

export function buildDefaultPosixCommand(target: TerminalTarget): string {
  const envPrefix = buildPosixEnvPrefix(target.env);
  const commands = [`cd ${posixShellQuote(target.cwd ?? process.cwd())} && ${envPrefix}${target.command}`];

  if (target.exitMessage) {
    commands.push(`printf '\n%s\n' ${posixShellQuote(target.exitMessage)}`);
  }

  commands.push('exec "${SHELL:-/bin/sh}" -l');
  return commands.join('; ');
}

function buildManagedPosixSidecarCommand(
  options: InternalTerminalLaunchOptions,
  control: TerminalControlPaths
): string {
  const sidecar = options.posixSidecar;
  if (!sidecar) throw new Error('Managed POSIX terminal mode requires its bundled controller sidecar.');
  const runnerFunctionName = `termhelm_runner_${control.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const failedCommands = buildPosixMarkerCommands(
    'failed_tmp',
    control.failedPath,
    terminalMarkerJson(control, 'failed')
  );
  const executable = posixShellQuote(sidecar.executablePath);
  const script = posixShellQuote(sidecar.scriptPath);
  const payloadPath = posixShellQuote(sidecar.payloadPath);
  const finalizerPayloadPath = posixShellQuote(sidecar.finalizerPayloadPath);
  const cleanupCommand = `rm -f ${payloadPath} ${finalizerPayloadPath}`;
  const commands = [
    `trap ${posixShellQuote(cleanupCommand)} EXIT HUP INT TERM`,
    `set -m || { printf '%s\n' 'This shell does not support job control, so managed terminal mode cannot run.'; ${failedCommands.join('; ')}; exit 1; }`,
    `${runnerFunctionName}() {`,
    `  exec ${executable} ${script} run ${payloadPath}`,
    '}',
    `${runnerFunctionName} &`,
    'runner_pid=$!',
    'runner_status=0',
    `fg ${posixShellQuote(`%?${runnerFunctionName}`)} || runner_status=$?`,
    `if ! ${executable} ${script} wait-finalize ${finalizerPayloadPath} "$runner_pid"; then`,
    '  exit 1',
    'fi'
  ];
  if (options.shutdownCompletePath) {
    commands.push(`: > ${posixShellQuote(options.shutdownCompletePath)} 2>/dev/null || true`);
  }
  commands.push('exit "$runner_status"');
  return commands.join('\n');
}

export function buildSupervisedPosixCommand(
  target: TerminalTarget,
  options: InternalTerminalLaunchOptions,
  control?: TerminalControlPaths
): string {
  void target;
  if (!control || !options.posixSidecar) {
    throw new Error('Managed POSIX terminal mode requires its bundled controller sidecar.');
  }
  return buildManagedPosixSidecarCommand(options, control);
}

export function buildPosixCommand(
  target: TerminalTarget,
  options: InternalTerminalLaunchOptions = {},
  control?: TerminalControlPaths
): string {
  if (options.supervisorPid || options.shutdownTokenPath || control) {
    return buildSupervisedPosixCommand(target, options, control);
  }
  return buildDefaultPosixCommand(target);
}

export function windowsCmdQuote(value: string): string {
  const stringValue = String(value);
  if (/[\0\r\n"]/.test(stringValue)) throw new Error('Windows cmd.exe quoted values cannot contain quotes, NUL, or line breaks.');
  return `"${stringValue.replace(/%/g, '%%')}"`;
}

export function windowsEchoEscape(value: string): string {
  const stringValue = String(value);
  if (/[\0\r\n]/.test(stringValue)) throw new Error('Windows batch values cannot contain NUL or line breaks.');
  return stringValue
    .replace(/\^/g, '^^')
    .replace(/%/g, '%%')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/\(/g, '^(')
    .replace(/\)/g, '^)');
}

export function windowsBatchPath(value: string): string {
  return windowsCmdQuote(value);
}

export function powershellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
