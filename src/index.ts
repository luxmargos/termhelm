import { validateTerminalTarget } from './config.js';
import {
  killManagedTerminalWindows,
  launchManagedTerminalWindows,
  startManagedTerminalWindows
} from './managed.js';
import {
  launchLinuxTerminalController,
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
  TerminalWindowSession
} from './types.js';

export type {
  LinuxLauncher,
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

class ControllerTerminalWindowSession implements TerminalWindowSession {
  private closed = false;
  private readonly pendingControllers: Set<TerminalProcessController>;

  constructor(controllers: readonly TerminalProcessController[]) {
    this.pendingControllers = new Set(controllers);
  }

  close(): void {
    if (this.closed) return;
    const errors: unknown[] = [];
    for (const controller of [...this.pendingControllers].reverse()) {
      try {
        if (!controller.close()) {
          throw new Error(`Terminal target ${controller.id} did not acknowledge shutdown.`);
        }
        controller.dispose();
        this.pendingControllers.delete(controller);
      } catch (error) {
        errors.push(error);
      }
    }
    this.closed = this.pendingControllers.size === 0;
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
  if (options.exitAfterCommand !== undefined && typeof options.exitAfterCommand !== 'boolean') {
    throw new Error('Terminal options.exitAfterCommand must be a boolean.');
  }
  if (!Array.isArray(targets)) throw new Error('Terminal targets must be an array.');
  const validatedTargets = targets.map((target, index) =>
    validateTerminalTarget(target, `targets[${index}]`)
  );
  if (validatedTargets.length === 0) return new ControllerTerminalWindowSession([]);

  const linuxLauncher = process.platform === 'linux' ? resolveLinuxLauncher() : null;
  if (process.platform === 'linux' && !linuxLauncher) {
    throw new Error('No supported Linux terminal emulator was found.');
  }
  const windowsController = process.platform === 'win32' ? resolveWindowsControllerBackend() : null;
  if (process.platform === 'win32' && !windowsController) {
    throw new Error(
      'Neither the native Windows controller nor the bundled PowerShell controller passed its ownership self-test. ' +
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
        throw new Error(`Terminal target ${controller.id} did not acknowledge readiness.`);
      }
    }
    return new ControllerTerminalWindowSession(controllers);
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
