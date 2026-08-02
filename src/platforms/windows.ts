import { spawn, spawnSync } from 'node:child_process';
import {
  lstatSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  InternalTerminalLaunchOptions,
  ResolvedTerminalTarget,
  TerminalTarget,
  TerminalUiCloseOutcome
} from '../types.js';
import {
  abandonTerminalControl,
  createTerminalControlPaths,
  MarkerTerminalProcessController,
  writeTerminalStateMarker,
  type TerminalControllerOptions,
  type TerminalProcessController
} from './controller.js';
import {
  sanitizeInheritedTemporaryDirectories,
  usableTemporaryDirectory
} from './environment.js';
import {
  privateWindowsDirectoryIdentity,
  revalidatePrivateWindowsDirectory
} from './windows-security.js';

const WINDOWS_POWERSHELL_CONTROLLER_NAME = 'termhelm-controller.ps1';
const WINDOWS_CONTROLLER_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_WINDOWS_POWERSHELL_EXECUTABLES = ['pwsh', 'powershell.exe'] as const;
const legacyWindowsControllers = new Map<number, WindowsTerminalController>();
let nextLegacyControllerId = 1;

export interface WindowsTerminalController extends TerminalProcessController {
  readonly controllerPid: number;
}

export interface WindowsControllerBackend {
  readonly executable: string;
  readonly scriptPath: string;
}

export interface WindowsControllerBackendResolutionOptions {
  environment?: NodeJS.ProcessEnv;
  moduleDirectory?: string;
  powerShellExecutables?: readonly string[];
  powerShellScriptPath?: string;
  probeTimeoutMs?: number;
  probe?: (executable: string, args: readonly string[]) => boolean;
}

class WindowsTerminalControllerImpl extends MarkerTerminalProcessController implements WindowsTerminalController {
  readonly controllerPid: number;

  constructor(control: ReturnType<typeof createTerminalControlPaths>, controllerPid: number) {
    super(control);
    this.controllerPid = controllerPid;
  }

  override terminalUiOutcome(_autoClose: boolean): TerminalUiCloseOutcome {
    // The helper owns an exact dedicated console and never selects by title,
    // but Windows console-host policy owns final visual disappearance.
    return 'host-managed';
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
    // Explicit absolute test paths are validated separately and intentionally
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
 * Selects one acknowledged PowerShell Job Object controller before any target
 * is started. Hosts are probed in order and the first successful host is the
 * only backend used for the launch.
 */
export function resolveWindowsControllerBackend(
  options: WindowsControllerBackendResolutionOptions = {}
): WindowsControllerBackend | null {
  const scriptPath = resolveWindowsPowerShellControllerPath(options);
  if (!scriptPath) return null;

  const environment = windowsControllerEnvironment(options.environment);
  const configuredProbeTimeoutMs = options.probeTimeoutMs;
  const timeoutMs = configuredProbeTimeoutMs !== undefined && Number.isFinite(configuredProbeTimeoutMs)
    ? Math.max(1, Math.trunc(configuredProbeTimeoutMs))
    : WINDOWS_CONTROLLER_PROBE_TIMEOUT_MS;
  const probe = options.probe ?? ((executable: string, args: readonly string[]) =>
    probeWindowsControllerProcess(executable, args, environment, timeoutMs));
  const executables = options.powerShellExecutables ?? DEFAULT_WINDOWS_POWERSHELL_EXECUTABLES;
  const seenExecutables = new Set<string>();
  for (const executable of executables) {
    if (typeof executable !== 'string' || executable.length === 0 || seenExecutables.has(executable)) continue;
    seenExecutables.add(executable);
    if (probe(executable, [...powerShellControllerPrefix(scriptPath), '-SelfTest'])) {
      return { executable, scriptPath };
    }
  }
  return null;
}

function validateWindowsEnvironment(env: Record<string, string> | undefined): void {
  const names = new Map<string, string>();
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.length === 0 || /[=\0]/.test(key)) throw new Error(`Invalid Windows environment variable name: ${key}`);
    if (/\0/.test(value)) throw new Error(`Windows environment variable ${key} contains NUL.`);
    const folded = key.toUpperCase();
    const previous = names.get(folded);
    if (previous !== undefined) {
      throw new Error(`Windows environment variable names are case-insensitive: ${previous} conflicts with ${key}.`);
    }
    names.set(folded, key);
  }
}

function windowsControllerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = sanitizeInheritedTemporaryDirectories(
    source,
    undefined,
    process.cwd(),
    true
  );
  const hasUsableTemporaryDirectory = Object.keys(environment)
    .some(name => ['TMP', 'TEMP'].includes(name.toUpperCase()));
  if (!hasUsableTemporaryDirectory && source.LOCALAPPDATA) {
    const fallback = usableTemporaryDirectory(join(source.LOCALAPPDATA, 'Temp'), process.cwd());
    if (fallback !== null) {
      environment.TEMP = fallback;
      environment.TMP = fallback;
    }
  }
  return environment;
}

function revalidateWindowsControlDirectory(
  control: ReturnType<typeof createTerminalControlPaths>,
  description: string
): void {
  if (control.windowsDirectoryIdentity === undefined) return;
  revalidatePrivateWindowsDirectory(control.directory, control.windowsDirectoryIdentity, {
    protectedRoot: control.ownsDirectory,
    description
  });
}

/**
 * Cheap node-only filesystem-identity recheck (no PowerShell spawn). Guards the
 * files written after the single per-target ACL revalidation so a path
 * replacement between writes is still detected without paying for another
 * cold powershell.exe launch per file.
 */
function revalidateWindowsControlDirectoryIdentity(
  control: ReturnType<typeof createTerminalControlPaths>,
  description: string
): void {
  if (control.windowsDirectoryIdentity === undefined) return;
  if (privateWindowsDirectoryIdentity(control.directory) !== control.windowsDirectoryIdentity) {
    throw new Error(`Private Windows directory identity changed: ${control.directory} (${description})`);
  }
}

function createWindowsCommandFile(
  target: Pick<TerminalTarget, 'command'>,
  options: InternalTerminalLaunchOptions,
  control: ReturnType<typeof createTerminalControlPaths>
): string {
  // createTerminalControlPaths just validated this directory's ACL
  // synchronously moments ago, with no async gap between that validation and
  // these writes. Re-running a cold powershell.exe spawn here per target used
  // to consume the managed launch replacement deadline for multi-target
  // sessions. A cheap node-only identity check guards the writes against path
  // replacement; ACL broadening in this synchronous microsecond window is
  // not a realistic attack surface beyond what createTerminalControlPaths
  // already rejected.
  revalidateWindowsControlDirectoryIdentity(control, 'the terminal control directory before target file creation');
  const commandFile = join(control.directory, `${control.id}.cmd`);
  const lines = [
    '@echo off',
    target.command,
    'set "TERMHELM_EXIT_CODE=%ERRORLEVEL%"',
    'if defined TERMHELM_EXIT_MESSAGE_FILE (',
    '  echo.',
    '  type "%TERMHELM_EXIT_MESSAGE_FILE%"',
    ')'
  ];
  if (options.exitAfterCommand === false) lines.push('"%ComSpec%" /d /q /v:off /k');
  lines.push('exit /b %TERMHELM_EXIT_CODE%');
  writeFileSync(commandFile, lines.join('\r\n'), { encoding: 'utf8', mode: 0o600 });
  return commandFile;
}

function createWindowsExitMessageFile(
  exitMessage: string | undefined,
  control: ReturnType<typeof createTerminalControlPaths>
): string {
  if (exitMessage === undefined) return '';
  revalidateWindowsControlDirectoryIdentity(control, 'the terminal control directory before exit-message creation');
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
  revalidateWindowsControlDirectoryIdentity(control, 'the terminal control directory before payload creation');
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

export function launchWindowsTerminalController(
  target: ResolvedTerminalTarget,
  options: InternalTerminalLaunchOptions = {},
  controllerOptions: TerminalControllerOptions = {},
  backend: WindowsControllerBackend | null = resolveWindowsControllerBackend()
): WindowsTerminalController {
  if (!backend) {
    throw new Error(
      'No safe Windows PowerShell controller is available. The bundled controller could not pass a Job Object ' +
      'ownership self-test with pwsh or Windows PowerShell. Refusing to launch without safe process-tree ownership.'
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
    const payloadPath = createWindowsControllerPayloadFile({
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
    const controllerProcess = spawn(
      backend.executable,
      powerShellWindowsControllerArguments(backend.scriptPath, payloadPath),
      {
        // NOTE: do not use `detached: true` here. On Windows, a detached node
        // spawn of a console-host PowerShell script can exit without running
        // the script (~180ms no-op on this host), which silently drops the
        // controller before it ever writes its ready marker. A plain (non-
        // detached) child survives the launcher exiting on Windows, and the
        // Job Object below owns the child process tree for the controller's
        // lifetime; `unref()` decouples it from the Node event loop.
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
        // Parse/delete the payload and compile in the package environment.
        // Target variables are applied only after Add-Type succeeds and just
        // before the owned child is created.
        env: windowsControllerEnvironment()
      }
    );
    let controller: WindowsTerminalControllerImpl | null = null;
    controllerProcess.once('error', () => {
      controller?.requestClose();
    });
    if (controllerProcess.pid === undefined) {
      throw new Error('Windows PowerShell controller did not return a process ID.');
    }
    controller = new WindowsTerminalControllerImpl(control, controllerProcess.pid);
    controllerProcess.unref();
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
