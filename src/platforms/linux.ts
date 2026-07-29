import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  InternalTerminalLaunchOptions,
  LinuxLauncher,
  LinuxTerminalAdapterId,
  LinuxTerminalCapabilities,
  ResolvedTerminalTarget,
  TerminalUiCloseOutcome
} from '../types.js';
import { buildPosixCommand, posixShellQuote } from '../shell.js';
import {
  abandonTerminalControl,
  createTerminalControlPaths,
  MarkerTerminalProcessController,
  terminalMarkerJson,
  waitForTerminalMarker,
  writeTerminalStateMarker,
  type TerminalControllerOptions,
  type TerminalProcessController
} from './controller.js';
import { cleanupPosixSidecarLaunch, createPosixSidecarLaunch } from './posix-sidecar.js';

export const LINUX_TERMINAL_REQUIREMENT =
  'No supported Linux terminal emulator was found. Install gnome-terminal, konsole, xfce4-terminal, or xterm; ' +
  'TERMINAL must resolve to one of those verified adapters.';

export interface LinuxTerminalController extends TerminalProcessController {
  readonly launcherPid: number | null;
  readonly adapterId: LinuxTerminalAdapterId | null;
}

class LinuxTerminalControllerImpl extends MarkerTerminalProcessController implements LinuxTerminalController {
  readonly launcherPid: number | null;

  readonly adapterId: LinuxTerminalAdapterId | null;

  constructor(
    control: ReturnType<typeof createTerminalControlPaths>,
    launcherPid: number | null,
    private readonly launchScriptPath: string,
    private readonly sidecarLaunch: NonNullable<InternalTerminalLaunchOptions['posixSidecar']>,
    private readonly launcherWatchPayloadPath: string,
    private readonly diagnosticPath: string,
    private readonly uiCloseRequestPath: string,
    private readonly uiCloseResultPath: string,
    private readonly launcherCapabilities: LinuxTerminalCapabilities | undefined,
    adapterId: LinuxTerminalAdapterId | null
  ) {
    super(control);
    this.launcherPid = launcherPid;
    this.adapterId = adapterId;
  }

  override requestClose(): void {
    super.requestClose();
    // If the private trampoline and runner payload both still exist, no target
    // shell has started. Removing them prevents any delayed terminal client
    // from launching later, making a failed marker authoritative.
    if (
      !existsSync(this.readyPath) &&
      !existsSync(this.failedPath) &&
      existsSync(this.launchScriptPath) &&
      existsSync(this.sidecarLaunch.payloadPath)
    ) {
      rmSync(this.launchScriptPath, { force: true });
      cleanupPosixSidecarLaunch(this.sidecarLaunch);
      writeTerminalStateMarker(this.control, 'failed');
    }
  }

  launchDiagnostic(): string | null {
    try {
      const value = readFileSync(this.diagnosticPath, 'utf8');
      return value.length <= 16 * 1024 ? value.trim() : 'Linux terminal launcher diagnostic exceeded its size limit.';
    } catch {
      return null;
    }
  }

  override terminalUiOutcome(autoClose: boolean): TerminalUiCloseOutcome {
    if (!autoClose) return this.launcherCapabilities?.holdOpen ? 'preserved' : 'host-managed';
    if (!this.launcherCapabilities?.exactProcess) return 'host-managed';
    if (!existsSync(this.uiCloseResultPath)) {
      try {
        writeFileSync(this.uiCloseRequestPath, `${this.id}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch {
        // A concurrent completion may already have created a result or request.
      }
      waitForTerminalMarker(this.uiCloseResultPath, 2_000);
    }
    try {
      const value = JSON.parse(readFileSync(this.uiCloseResultPath, 'utf8')) as { outcome?: unknown };
      return value.outcome === 'closed' || value.outcome === 'host-managed' || value.outcome === 'unsupported'
        ? value.outcome
        : 'host-managed';
    } catch {
      return 'host-managed';
    }
  }

  override dispose(): void {
    rmSync(this.launchScriptPath, { force: true });
    rmSync(this.launcherWatchPayloadPath, { force: true });
    rmSync(this.diagnosticPath, { force: true });
    rmSync(this.uiCloseRequestPath, { force: true });
    rmSync(this.uiCloseResultPath, { force: true });
    cleanupPosixSidecarLaunch(this.sidecarLaunch);
    super.dispose();
  }
}

function executableFromPath(command: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command]
    : (environment.PATH ?? '').split(delimiter).map(directory => join(directory || '.', command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

export function resolveLinuxControllerShell(environment: NodeJS.ProcessEnv = process.env): string | null {
  for (const command of ['bash', 'zsh']) {
    const executable = executableFromPath(command, environment);
    if (executable !== null) return executable;
  }
  return null;
}

function createLinuxLaunchScript(
  control: ReturnType<typeof createTerminalControlPaths>,
  command: string
): string {
  const launchScriptPath = join(control.directory, `${control.id}.launch.sh`);
  writeFileSync(
    launchScriptPath,
    `rm -f ${posixShellQuote(launchScriptPath)}\n${command}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  return launchScriptPath;
}

function linuxLauncherWatcherPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const emittedPath = join(moduleDirectory, 'linux-launcher-watch.js');
  if (existsSync(emittedPath)) return emittedPath;
  const developmentBuildPath = resolve(moduleDirectory, '..', '..', 'dist', 'platforms', 'linux-launcher-watch.js');
  if (existsSync(developmentBuildPath)) return developmentBuildPath;
  throw new Error('The bundled Linux terminal launcher watcher is unavailable. Run the package build before launch.');
}

function createLinuxLauncherWatchPayload(
  control: ReturnType<typeof createTerminalControlPaths>,
  launchCommand: { command: string; args: string[] },
  launchScriptPath: string,
  sidecarLaunch: NonNullable<InternalTerminalLaunchOptions['posixSidecar']>,
  exactProcess: boolean
): {
  payloadPath: string;
  diagnosticPath: string;
  uiCloseRequestPath: string;
  uiCloseResultPath: string;
} {
  const payloadPath = join(control.directory, `${control.id}.launcher-watch.json`);
  const diagnosticPath = join(control.directory, `${control.id}.launcher-diagnostic.json`);
  const uiCloseRequestPath = join(control.directory, `${control.id}.ui-close-request`);
  const uiCloseResultPath = join(control.directory, `${control.id}.ui-close-result.json`);
  writeFileSync(payloadPath, `${JSON.stringify({
    version: 1,
    executable: launchCommand.command,
    args: launchCommand.args,
    targetTokenPath: control.targetTokenPath,
    readyPath: control.readyPath,
    failedPath: control.failedPath,
    failedMarker: terminalMarkerJson(control, 'failed'),
    diagnosticPath,
    launchScriptPath,
    runnerPayloadPath: sidecarLaunch.payloadPath,
    finalizerPayloadPath: sidecarLaunch.finalizerPayloadPath,
    exactProcess,
    uiCloseRequestPath,
    uiCloseResultPath
  })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { payloadPath, diagnosticPath, uiCloseRequestPath, uiCloseResultPath };
}

const LINUX_TERMINAL_CAPABILITIES: Record<LinuxTerminalAdapterId, LinuxTerminalCapabilities> = {
  'gnome-terminal': { title: true, holdOpen: false, exactProcess: false, waitsForCommand: true },
  konsole: { title: true, holdOpen: true, exactProcess: true, waitsForCommand: true },
  'xfce4-terminal': { title: true, holdOpen: true, exactProcess: true, waitsForCommand: true },
  xterm: { title: true, holdOpen: true, exactProcess: true, waitsForCommand: true }
};

function adapterIdForExecutable(executable: string): LinuxTerminalAdapterId | null {
  const name = basename(executable);
  if (name === 'gnome-terminal' || name === 'konsole' || name === 'xfce4-terminal' || name === 'xterm') {
    return name;
  }
  return null;
}

export function linuxLauncherForExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env
): LinuxLauncher | null {
  const located = executableFromPath(command, environment);
  if (located === null) return null;
  let executable: string;
  try {
    executable = realpathSync(located);
  } catch {
    return null;
  }
  const adapterId = adapterIdForExecutable(executable);
  if (adapterId === null) return null;
  const capabilities = LINUX_TERMINAL_CAPABILITIES[adapterId];
  const launch = ((target, shell, posixCommand, uiOptions) => {
    const holdOpen = uiOptions?.holdOpen === true && capabilities.holdOpen;
    switch (adapterId) {
      case 'gnome-terminal':
        return {
          command: executable,
          args: ['--wait', '--title', target.title, '--', shell, '-lc', posixCommand]
        };
      case 'konsole':
        return {
          command: executable,
          args: [
            '--separate',
            ...(holdOpen ? ['--hold'] : []),
            '-p', `tabtitle=${target.title}`,
            '-e', shell, '-lc', posixCommand
          ]
        };
      case 'xfce4-terminal':
        return {
          command: executable,
          args: [
            '--disable-server',
            ...(holdOpen ? ['--hold'] : []),
            '--title', target.title,
            '--command', `${posixShellQuote(shell)} -lc ${posixShellQuote(posixCommand)}`
          ]
        };
      case 'xterm':
        return {
          command: executable,
          args: [...(holdOpen ? ['-hold'] : []), '-T', target.title, '-e', shell, '-lc', posixCommand]
        };
    }
  }) as LinuxLauncher;
  Object.defineProperties(launch, {
    adapterId: { value: adapterId, enumerable: true },
    executable: { value: executable, enumerable: true },
    capabilities: { value: capabilities, enumerable: true }
  });
  return launch;
}

export function resolveLinuxLauncher(environment: NodeJS.ProcessEnv = process.env): LinuxLauncher | null {
  const terminal = environment.TERMINAL;
  if (terminal) return linuxLauncherForExecutable(terminal, environment);
  for (const command of ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm', 'x-terminal-emulator']) {
    const launcher = linuxLauncherForExecutable(command, environment);
    if (launcher !== null) return launcher;
  }
  return null;
}

export function launchLinuxTerminalController(
  target: ResolvedTerminalTarget,
  launcher: LinuxLauncher,
  options: InternalTerminalLaunchOptions = {},
  controllerOptions: TerminalControllerOptions = {}
): LinuxTerminalController {
  const control = createTerminalControlPaths({
    ...controllerOptions,
    stateDirectory: controllerOptions.stateDirectory ?? options.shutdownStateDirectory,
    gracefulShutdownMs: controllerOptions.gracefulShutdownMs
  });
  let sidecarLaunch: NonNullable<InternalTerminalLaunchOptions['posixSidecar']> | null = null;
  let launchScriptPath: string | null = null;
  let launcherWatchPayloadPath: string | null = null;
  let diagnosticPath: string | null = null;
  let uiCloseRequestPath: string | null = null;
  let uiCloseResultPath: string | null = null;
  try {
    const controllerShell = resolveLinuxControllerShell();
    if (controllerShell === null) {
      throw new Error('Managed Linux terminal mode requires bash or zsh on PATH for its private controller wrapper.');
    }
    sidecarLaunch = createPosixSidecarLaunch(target, control, options);
    const controlledOptions: InternalTerminalLaunchOptions = { ...options, posixSidecar: sidecarLaunch };
    launchScriptPath = createLinuxLaunchScript(control, buildPosixCommand(target, controlledOptions, control));
    const launchCommand = launcher(target, controllerShell, `. ${posixShellQuote(launchScriptPath)}`, {
      holdOpen: options.autoClose !== true
    });
    if (!isAbsolute(launchCommand.command)) {
      throw new Error('Linux terminal adapters must resolve the launcher executable to an absolute path.');
    }
    const watcherState = createLinuxLauncherWatchPayload(
      control,
      launchCommand,
      launchScriptPath,
      sidecarLaunch,
      launcher.capabilities?.exactProcess === true
    );
    launcherWatchPayloadPath = watcherState.payloadPath;
    diagnosticPath = watcherState.diagnosticPath;
    uiCloseRequestPath = watcherState.uiCloseRequestPath;
    uiCloseResultPath = watcherState.uiCloseResultPath;
    const watcherScriptPath = linuxLauncherWatcherPath();
    const child = spawn(process.execPath, [watcherScriptPath, launcherWatchPayloadPath], {
      detached: true,
      stdio: 'ignore'
    });
    if (child.pid === undefined) {
      // Node reports many exec failures asynchronously. Consume that event,
      // but fail synchronously before a controller can claim readiness.
      child.once('error', () => undefined);
      throw new Error('Failed to start the Linux terminal launcher watcher.');
    }
    const controller = new LinuxTerminalControllerImpl(
      control,
      child.pid,
      launchScriptPath,
      sidecarLaunch,
      launcherWatchPayloadPath,
      diagnosticPath,
      uiCloseRequestPath,
      uiCloseResultPath,
      launcher.capabilities,
      launcher.adapterId ?? null
    );
    child.once('error', () => {
      controller.requestClose();
      try {
        // A watcher spawn error proves the terminal launcher never started.
        writeTerminalStateMarker(control, 'failed');
      } catch {
        // The owning supervisor may already have removed the state directory.
      }
    });
    child.unref();
    return controller;
  } catch (error) {
    if (launchScriptPath !== null) rmSync(launchScriptPath, { force: true });
    if (launcherWatchPayloadPath !== null) rmSync(launcherWatchPayloadPath, { force: true });
    if (diagnosticPath !== null) rmSync(diagnosticPath, { force: true });
    if (uiCloseRequestPath !== null) rmSync(uiCloseRequestPath, { force: true });
    if (uiCloseResultPath !== null) rmSync(uiCloseResultPath, { force: true });
    if (sidecarLaunch !== null) cleanupPosixSidecarLaunch(sidecarLaunch);
    try {
      writeTerminalStateMarker(control, 'failed');
    } catch {
      // Preserve the original launch failure.
    }
    abandonTerminalControl(control);
    throw error;
  }
}
