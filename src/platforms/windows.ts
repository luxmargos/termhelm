import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InternalTerminalLaunchOptions, ResolvedTerminalTarget, TerminalTarget } from '../types.js';
import {
  abandonTerminalControl,
  createTerminalControlPaths,
  MarkerTerminalProcessController,
  writeTerminalStateMarker,
  type TerminalControllerOptions,
  type TerminalProcessController
} from './controller.js';

const WINDOWS_HELPER_NAME = 'terminal-windows-controller.exe';
const WINDOWS_POWERSHELL_CONTROLLER_NAME = 'terminal-windows-controller.ps1';
const WINDOWS_CONTROLLER_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_WINDOWS_POWERSHELL_EXECUTABLES = ['pwsh', 'powershell.exe'] as const;
const legacyWindowsControllers = new Map<number, WindowsTerminalController>();
let nextLegacyControllerId = 1;

export interface WindowsTerminalController extends TerminalProcessController {
  readonly helperPid: number;
}

export interface WindowsControllerResolutionOptions {
  environment?: NodeJS.ProcessEnv;
  architecture?: string;
  moduleDirectory?: string;
}

export type WindowsControllerBackend =
  | { readonly kind: 'native'; readonly helperPath: string }
  | {
    readonly kind: 'powershell';
    readonly executable: string;
    readonly scriptPath: string;
  };

export interface WindowsControllerBackendResolutionOptions extends WindowsControllerResolutionOptions {
  powerShellExecutables?: readonly string[];
  powerShellScriptPath?: string;
  probeTimeoutMs?: number;
  probe?: (executable: string, args: readonly string[]) => boolean;
}

class WindowsTerminalControllerImpl extends MarkerTerminalProcessController implements WindowsTerminalController {
  readonly helperPid: number;

  constructor(control: ReturnType<typeof createTerminalControlPaths>, helperPid: number) {
    super(control);
    this.helperPid = helperPid;
  }
}

const WINDOWS_PE_MACHINES = {
  x64: 0x8664,
  arm64: 0xaa64
} as const;

function isWindowsControllerHelperFile(path: string, architecture: keyof typeof WINDOWS_PE_MACHINES): boolean {
  let descriptor: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 70) return false;
    descriptor = openSync(path, 'r');
    const dosHeader = Buffer.allocUnsafe(64);
    if (readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) return false;
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) return false;
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset > stat.size - 6) return false;
    const peHeader = Buffer.allocUnsafe(6);
    if (readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) return false;
    return peHeader.readUInt32LE(0) === 0x0000_4550 &&
      peHeader.readUInt16LE(4) === WINDOWS_PE_MACHINES[architecture];
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isContainedPath(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}

function resolveContainedPackageFile(
  moduleDirectory: string,
  segments: readonly string[],
  validate: (path: string) => boolean
): string | null {
  try {
    // TypeScript emits src/platforms/* directly to dist/platforms/*, so both
    // development and packaged modules have the package root two levels up.
    const canonicalModuleDirectory = realpathSync(moduleDirectory);
    const packageRoot = realpathSync(resolve(canonicalModuleDirectory, '..', '..'));
    const candidate = resolve(packageRoot, ...segments);
    if (!isContainedPath(packageRoot, candidate)) return null;

    // Reject a symlink or junction in every package-relative path component.
    // Explicit absolute overrides are validated separately and intentionally
    // remain able to point outside the package.
    let current = packageRoot;
    for (const segment of relative(packageRoot, candidate).split(sep)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) return null;
    }

    const canonicalCandidate = realpathSync(candidate);
    if (!isContainedPath(packageRoot, canonicalCandidate)) return null;
    return validate(canonicalCandidate) ? canonicalCandidate : null;
  } catch {
    return null;
  }
}

export function resolveWindowsControllerHelperPath(options: WindowsControllerResolutionOptions = {}): string | null {
  const environment = options.environment ?? process.env;
  const architecture = options.architecture ?? process.arch;
  if (architecture !== 'x64' && architecture !== 'arm64') return null;
  const configuredPath = environment.TERMINAL_WINDOWS_CONTROLLER_HELPER;
  if (configuredPath) {
    return isAbsolute(configuredPath) && isWindowsControllerHelperFile(configuredPath, architecture)
      ? configuredPath
      : null;
  }

  const moduleDirectory = options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
  return resolveContainedPackageFile(
    moduleDirectory,
    ['native', `win32-${architecture}`, WINDOWS_HELPER_NAME],
    path => isWindowsControllerHelperFile(path, architecture)
  );
}

function isWindowsPowerShellControllerFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsPowerShellControllerPath(
  options: WindowsControllerBackendResolutionOptions
): string | null {
  if (options.powerShellScriptPath !== undefined) {
    return isAbsolute(options.powerShellScriptPath) &&
      isWindowsPowerShellControllerFile(options.powerShellScriptPath)
      ? options.powerShellScriptPath
      : null;
  }

  const moduleDirectory = options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
  return resolveContainedPackageFile(
    moduleDirectory,
    ['native', 'windows', WINDOWS_POWERSHELL_CONTROLLER_NAME],
    isWindowsPowerShellControllerFile
  );
}

function powerShellControllerPrefix(scriptPath: string): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath
  ];
}

function probeWindowsControllerProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number
): boolean {
  try {
    const result = spawnSync(executable, [...args], {
      env: environment,
      stdio: 'ignore',
      timeout: timeoutMs,
      windowsHide: true
    });
    return result.error === undefined && result.signal === null && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Selects one acknowledged Windows process-tree controller before any target is
 * started. The native helper is preferred; PowerShell is used only when its
 * bundled controller passes the same ownership self-test.
 */
export function resolveWindowsControllerBackend(
  options: WindowsControllerBackendResolutionOptions = {}
): WindowsControllerBackend | null {
  const environment = options.environment ?? process.env;
  const configuredProbeTimeoutMs = options.probeTimeoutMs;
  const timeoutMs = configuredProbeTimeoutMs !== undefined && Number.isFinite(configuredProbeTimeoutMs)
    ? Math.max(1, Math.trunc(configuredProbeTimeoutMs))
    : WINDOWS_CONTROLLER_PROBE_TIMEOUT_MS;
  const probe = options.probe ?? ((executable: string, args: readonly string[]) =>
    probeWindowsControllerProcess(executable, args, environment, timeoutMs));

  const helperPath = resolveWindowsControllerHelperPath(options);
  if (helperPath && probe(helperPath, ['--self-test'])) {
    return { kind: 'native', helperPath };
  }

  const scriptPath = resolveWindowsPowerShellControllerPath(options);
  if (!scriptPath) return null;
  const executables = options.powerShellExecutables ?? DEFAULT_WINDOWS_POWERSHELL_EXECUTABLES;
  for (const executable of new Set(executables)) {
    if (typeof executable !== 'string' || executable.length === 0) continue;
    if (probe(executable, [...powerShellControllerPrefix(scriptPath), '-SelfTest'])) {
      return { kind: 'powershell', executable, scriptPath };
    }
  }
  return null;
}

function validateWindowsEnvironment(env: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.length === 0 || /[=\0]/.test(key)) throw new Error(`Invalid Windows environment variable name: ${key}`);
    if (/\0/.test(value)) throw new Error(`Windows environment variable ${key} contains NUL.`);
  }
}

function createWindowsCommandFile(
  target: Pick<TerminalTarget, 'command'>,
  options: InternalTerminalLaunchOptions,
  control: ReturnType<typeof createTerminalControlPaths>
): string {
  const commandFile = join(control.directory, `${control.id}.cmd`);
  const lines = [
    '@echo off',
    target.command,
    'set "TERMINAL_WINDOWS_EXIT_CODE=%ERRORLEVEL%"',
    'if defined TERMINAL_WINDOWS_EXIT_MESSAGE_FILE (',
    '  echo.',
    '  type "%TERMINAL_WINDOWS_EXIT_MESSAGE_FILE%"',
    ')'
  ];
  if (options.exitAfterCommand === false) lines.push('"%ComSpec%" /d /q /v:off /k');
  lines.push('exit /b %TERMINAL_WINDOWS_EXIT_CODE%');
  writeFileSync(commandFile, lines.join('\r\n'), { encoding: 'utf8', mode: 0o600 });
  return commandFile;
}

function createWindowsExitMessageFile(
  exitMessage: string | undefined,
  control: ReturnType<typeof createTerminalControlPaths>
): string {
  if (exitMessage === undefined) return '';
  const messageFile = join(control.directory, `${control.id}.exit-message.txt`);
  writeFileSync(messageFile, `${exitMessage}\r\n`, { encoding: 'utf8', mode: 0o600 });
  return messageFile;
}

interface WindowsControllerArgumentValues {
  commandFile: string;
  comspec: string;
  cwd: string;
  environment: readonly { key: string; value: string }[];
  exitMessageFile: string;
  title: string;
  sessionId: string;
  targetId: string;
  targetToken: string;
  readyFile: string;
  stoppingFile: string;
  stoppedFile: string;
  failedFile: string;
  forcedFile: string;
  graceMs: string;
  forceWaitMs: string;
  supervisorPid: string;
  shutdownToken: string;
  controlEndpoint: string;
  controlToken: string;
}

function nativeWindowsControllerArguments(values: WindowsControllerArgumentValues): string[] {
  return [
    '--command-file', values.commandFile,
    '--comspec', values.comspec,
    '--cwd', values.cwd,
    '--title', values.title,
    '--session-id', values.sessionId,
    '--target-id', values.targetId,
    '--target-token', values.targetToken,
    '--ready-file', values.readyFile,
    '--stopping-file', values.stoppingFile,
    '--stopped-file', values.stoppedFile,
    '--failed-file', values.failedFile,
    '--forced-file', values.forcedFile,
    '--grace-ms', values.graceMs,
    '--force-wait-ms', values.forceWaitMs,
    '--supervisor-pid', values.supervisorPid,
    '--shutdown-token', values.shutdownToken,
    '--control-endpoint', values.controlEndpoint,
    '--control-token', values.controlToken
  ];
}

function powerShellWindowsControllerArguments(
  scriptPath: string,
  payloadPath: string
): string[] {
  return [
    ...powerShellControllerPrefix(scriptPath),
    '-PayloadPath', payloadPath
  ];
}

function createWindowsControllerPayloadFile(
  values: WindowsControllerArgumentValues,
  control: ReturnType<typeof createTerminalControlPaths>
): string {
  const payloadPath = join(
    control.directory,
    `${control.sessionId}.${control.id}.controller.json`
  );
  writeFileSync(payloadPath, `${JSON.stringify(values)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
  return payloadPath;
}

function windowsControllerInvocation(
  backend: WindowsControllerBackend,
  values: WindowsControllerArgumentValues,
  control: ReturnType<typeof createTerminalControlPaths>
): { executable: string; args: string[] } {
  return backend.kind === 'native'
    ? { executable: backend.helperPath, args: nativeWindowsControllerArguments(values) }
    : {
      executable: backend.executable,
      args: powerShellWindowsControllerArguments(
        backend.scriptPath,
        createWindowsControllerPayloadFile(values, control)
      )
    };
}

export function launchWindowsTerminalController(
  target: ResolvedTerminalTarget,
  options: InternalTerminalLaunchOptions = {},
  controllerOptions: TerminalControllerOptions = {},
  backend: WindowsControllerBackend | null = resolveWindowsControllerBackend()
): WindowsTerminalController {
  if (!backend) {
    throw new Error(
      'No safe Windows controller backend is available. The native helper and bundled PowerShell controller ' +
      'could not pass their Job Object ownership self-tests. Refusing to launch without safe process-tree ownership.'
    );
  }

  validateWindowsEnvironment(target.env);
  const control = createTerminalControlPaths({
    ...controllerOptions,
    stateDirectory: controllerOptions.stateDirectory ?? options.shutdownStateDirectory,
    gracefulShutdownMs: controllerOptions.gracefulShutdownMs
  });
  try {
    const commandFile = createWindowsCommandFile(target, options, control);
    const exitMessageFile = createWindowsExitMessageFile(target.exitMessage, control);
    const invocation = windowsControllerInvocation(backend, {
      commandFile,
      comspec: process.env.ComSpec || 'cmd.exe',
      cwd: target.cwd,
      environment: Object.entries(target.env ?? {}).map(([key, value]) => ({ key, value })),
      exitMessageFile,
      title: target.title,
      sessionId: control.sessionId,
      targetId: control.id,
      targetToken: control.targetTokenPath,
      readyFile: control.readyPath,
      stoppingFile: control.stoppingPath,
      stoppedFile: control.stoppedPath,
      failedFile: control.failedPath,
      forcedFile: control.forcedPath,
      graceMs: String(control.gracefulShutdownMs),
      forceWaitMs: String(options.closeWaitTimeoutMs ?? 6_000),
      supervisorPid: String(options.supervisorPid ?? 0),
      shutdownToken: options.shutdownTokenPath ?? '',
      controlEndpoint: options.controlEndpoint ?? '',
      controlToken: options.authenticationToken ?? ''
    }, control);
    const helper = spawn(invocation.executable, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: backend.kind === 'powershell'
        // Parse/delete the payload and compile in the package environment.
        // Target variables are applied only after Add-Type succeeds and just
        // before the owned child is created.
        ? { ...process.env }
        : {
          ...process.env,
          ...target.env,
          // Display data is file-backed and consumed by TYPE. It is never
          // interpolated into the generated command file as shell code.
          TERMINAL_WINDOWS_EXIT_MESSAGE_FILE: exitMessageFile
        }
    });
    let controller: WindowsTerminalControllerImpl | null = null;
    helper.once('error', () => {
      controller?.requestClose();
    });
    if (helper.pid === undefined) throw new Error('Windows controller helper did not return a process ID.');
    controller = new WindowsTerminalControllerImpl(control, helper.pid);
    helper.unref();
    return controller;
  } catch (error) {
    try {
      writeTerminalStateMarker(control, 'failed');
    } catch {
      // Preserve the original launch failure.
    }
    abandonTerminalControl(control);
    throw error;
  }
}

/**
 * Compatibility wrapper. The returned number identifies an in-process controller map entry,
 * not an authority that may be passed to taskkill.
 */
export function launchWindowsTerminal(target: ResolvedTerminalTarget, options: InternalTerminalLaunchOptions = {}): number | null {
  const controller = launchWindowsTerminalController(target, options);
  while (legacyWindowsControllers.has(nextLegacyControllerId)) nextLegacyControllerId += 1;
  const controllerId = nextLegacyControllerId;
  nextLegacyControllerId = Number.isSafeInteger(nextLegacyControllerId + 1) ? nextLegacyControllerId + 1 : 1;
  legacyWindowsControllers.set(controllerId, controller);
  return controllerId;
}

/** Fail closed for unknown/stale IDs; raw PIDs are never terminated. */
export function closeWindowsTerminalWindows(controllerIds: number[]): void {
  for (const controllerId of controllerIds) {
    const controller = legacyWindowsControllers.get(controllerId);
    if (!controller) continue;
    if (controller.close()) controller.dispose();
    legacyWindowsControllers.delete(controllerId);
  }
}
