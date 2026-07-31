import { validateTerminalTarget } from './config.js';
import {
  killManagedTerminalWindows,
  launchManagedTerminalWindows,
  startManagedTerminalWindows
} from './managed.js';
import {
  launchLinuxTerminalController,
  LINUX_TERMINAL_REQUIREMENT,
  resolveLinuxLauncher
} from './platforms/linux.js';
import { launchMacTerminalController } from './platforms/macos.js';
import {
  launchWindowsTerminalController,
  resolveWindowsControllerBackend
} from './platforms/windows.js';
import {
  TerminalControllerLaunchError,
  type TerminalProcessController
} from './platforms/controller.js';
import type {
  InternalTerminalLaunchOptions,
  TerminalLaunchOptions,
  TerminalTarget,
  TerminalUiCloseOutcome,
  TerminalUiCloseResult,
  TerminalWindowCloseResult,
  TerminalWindowSession
} from './types.js';

export type {
  DetachedManagedTerminalLaunchResult,
  LinuxLauncher,
  LinuxTerminalAdapterId,
  LinuxTerminalCapabilities,
  ManagedTerminalCloseReason,
  ManagedTerminalCloseResult,
  ManagedTerminalKillOptions,
  ManagedTerminalKillResult,
  ManagedTerminalLabelScope,
  ManagedTerminalLaunchOptions,
  ManagedTerminalSession,
  TerminalLaunchCommand,
  TerminalLaunchOptions,
  TerminalTarget,
  TerminalUiCloseOutcome,
  TerminalUiCloseResult,
  TerminalWindowCloseResult,
  TerminalWindowSession,
  TerminalWindowsConfig,
  TerminalWindowsConfigOptions
} from './types.js';
export {
  MANAGED_TERMINAL_LABEL_ERROR,
  readTerminalWindowsConfig,
  validateManagedTerminalLabel,
  validateManagedTerminalLaunchOptions,
  validateTerminalTarget,
  validateTerminalWindowsConfig
} from './config.js';
export {
  appleScriptString,
  buildDefaultPosixCommand,
  buildPosixEnvPrefix,
  posixShellQuote,
  powershellQuote,
  windowsCmdQuote,
  windowsEchoEscape
} from './shell.js';
export {
  killManagedTerminalWindows,
  launchManagedTerminalWindows,
  startManagedTerminalWindows
} from './managed.js';
export { launchDetachedManagedTerminalWindows } from './detached.js';

class ControllerTerminalWindowSession implements TerminalWindowSession {
  private readonly closedPromise: Promise<TerminalWindowCloseResult>;
  private readonly pendingControllers: Set<TerminalProcessController>;
  private readonly controllerOrder: readonly TerminalProcessController[];
  private readonly uiOutcomes = new Map<string, TerminalUiCloseOutcome>();
  private readonly completionWarningTargets = new Set<string>();
  private readonly warnings: string[] = [];
  private resolveClosed!: (result: TerminalWindowCloseResult) => void;
  private observationReferenced = false;
  private observationTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(
    controllers: readonly TerminalProcessController[],
    private readonly autoClose: boolean
  ) {
    this.controllerOrder = [...controllers];
    this.pendingControllers = new Set(controllers);
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve; });
    if (controllers.length === 0) this.settle();
    else this.scheduleObservation();
  }

  get closed(): Promise<TerminalWindowCloseResult> {
    this.observationReferenced = true;
    this.observationTimer?.ref?.();
    return this.closedPromise;
  }

  private scheduleObservation(): void {
    this.observationTimer = setTimeout(() => {
      this.observationTimer = null;
      this.observeNaturalCompletion();
    }, 50);
    if (!this.observationReferenced) this.observationTimer.unref?.();
  }

  private observeNaturalCompletion(): void {
    if (this.settled) return;
    for (const controller of [...this.pendingControllers]) {
      try {
        if (!controller.waitUntilStopped(0)) continue;
        this.finishController(controller);
      } catch (error) {
        if (!this.completionWarningTargets.has(controller.id)) {
          this.completionWarningTargets.add(controller.id);
          this.warnings.push(`Target ${controller.id} completion warning: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (this.pendingControllers.size === 0) this.settle();
    else this.scheduleObservation();
  }

  private finishController(controller: TerminalProcessController): void {
    let outcome: TerminalUiCloseOutcome;
    try {
      outcome = controller.terminalUiOutcome?.(this.autoClose)
        ?? (this.autoClose ? 'unsupported' : 'preserved');
    } catch (error) {
      outcome = 'unsupported';
      this.warnings.push(`Target ${controller.id} UI outcome warning: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.uiOutcomes.set(controller.id, outcome);
    try {
      controller.dispose();
    } catch (error) {
      this.warnings.push(`Target ${controller.id} cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.pendingControllers.delete(controller);
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.observationTimer !== null) clearTimeout(this.observationTimer);
    this.observationTimer = null;
    const uiCloseResults: TerminalUiCloseResult[] = this.controllerOrder.map(controller => ({
      targetId: controller.id,
      outcome: this.uiOutcomes.get(controller.id) ?? 'unsupported'
    }));
    this.resolveClosed({ uiCloseResults, warnings: [...this.warnings] });
  }

  close(): void {
    if (this.settled) return;
    const errors: unknown[] = [];
    for (const controller of [...this.pendingControllers].reverse()) {
      try {
        if (!controller.close()) {
          throw new Error(`Terminal target ${controller.id} did not acknowledge shutdown.`);
        }
        this.finishController(controller);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.pendingControllers.size === 0) this.settle();
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more terminal targets could not be closed safely.');
    }
  }
}

/**
 * Launches terminals without publishing a managed label. Platform controllers
 * are still used for exact rollback and cleanup, but acknowledged ownership is
 * only part of the managed-session contract.
 */
export function launchTerminalWindows(
  targets: TerminalTarget[],
  options: TerminalLaunchOptions = {}
): TerminalWindowSession {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Terminal launch options must be an object.');
  }
  if (options.autoClose !== undefined && typeof options.autoClose !== 'boolean') {
    throw new Error('Terminal options.autoClose must be a boolean.');
  }
  if (options.exitAfterCommand !== undefined && typeof options.exitAfterCommand !== 'boolean') {
    throw new Error('Terminal options.exitAfterCommand must be a boolean.');
  }
  if (!Array.isArray(targets)) throw new Error('Terminal targets must be an array.');
  const validatedTargets = targets.map((target, index) =>
    validateTerminalTarget(target, `targets[${index}]`)
  );
  if (validatedTargets.length === 0) return new ControllerTerminalWindowSession([], options.autoClose ?? false);

  const linuxLauncher = process.platform === 'linux' ? resolveLinuxLauncher() : null;
  if (process.platform === 'linux' && !linuxLauncher) {
    throw new Error(LINUX_TERMINAL_REQUIREMENT);
  }
  const windowsController = process.platform === 'win32' ? resolveWindowsControllerBackend() : null;
  if (process.platform === 'win32' && !windowsController) {
    throw new Error(
      'The bundled Windows PowerShell controller did not pass its ownership self-test with an available host. ' +
      'Refusing to launch without safe process-tree ownership.'
    );
  }
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  // Copy only the public field. In particular, never let JavaScript callers
  // smuggle supervisor PIDs, token paths, or state directories into a plain
  // launch through an untyped object.
  const launchOptions: InternalTerminalLaunchOptions = {
    autoClose: options.autoClose ?? false,
    exitAfterCommand: options.exitAfterCommand
  };
  const controllers: TerminalProcessController[] = [];
  try {
    for (const target of validatedTargets) {
      const controller = process.platform === 'darwin'
        ? launchMacTerminalController(target, launchOptions)
        : process.platform === 'win32'
          ? launchWindowsTerminalController(target, launchOptions, {}, windowsController)
          : launchLinuxTerminalController(target, linuxLauncher!, launchOptions);
      controllers.push(controller);
      if (!controller.waitUntilReady()) {
        const diagnostic = controller.launchDiagnostic?.();
        throw new Error(
          `Terminal target ${controller.id} did not acknowledge readiness.` +
          (diagnostic ? ` Launcher diagnostic: ${diagnostic}` : '')
        );
      }
    }
    return new ControllerTerminalWindowSession(controllers, launchOptions.autoClose ?? false);
  } catch (launchError) {
    if (launchError instanceof TerminalControllerLaunchError) {
      controllers.push(launchError.controller);
    }
    const rollbackErrors: unknown[] = [];
    for (const controller of [...controllers].reverse()) {
      try {
        if (!controller.close()) {
          throw new Error(`Terminal target ${controller.id} did not acknowledge rollback.`);
        }
        controller.dispose();
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [launchError, ...rollbackErrors],
        'Terminal launch failed and one or more earlier targets could not be rolled back safely.'
      );
    }
    throw launchError;
  }
}
