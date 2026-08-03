import { helpText, parseTerminalWindowsCliArgs, versionText } from './cli-core.js';
import {
  readTerminalWindowsConfigOptions,
  validateManagedTerminalLaunchOptions
} from './config.js';
import {
  killManagedTerminalWindows,
  launchDetachedManagedTerminalWindows,
  launchManagedTerminalWindows,
  launchTerminalWindows,
  readTerminalWindowsConfig,
  resetManagedTerminalWindows
} from './index.js';
import {
  DEFAULT_MANAGED_CLOSE_WAIT_TIMEOUT_MS,
  DEFAULT_MANAGED_REPLACE_EXTRA_TIMEOUT_MS,
  DEFAULT_MANAGED_SHUTDOWN_DELAY_MS
} from './managed.js';

interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

async function executeTerminalWindowsCli(args: string[], output: CliOutput): Promise<void> {
  const request = parseTerminalWindowsCliArgs(args);
  if (request.help) {
    output.log(helpText());
    return;
  }
  if (request.version) {
    output.log(versionText());
    return;
  }

  if (!request.mode) throw new Error('Missing command mode.');

  if (request.configPath) {
    if (request.mode === 'kill') {
      const options = validateManagedTerminalLaunchOptions(
        readTerminalWindowsConfigOptions(request.configPath)
      );
      const timeoutMs = options.replaceTimeoutMs
        ?? (options.shutdownDelayMs ?? DEFAULT_MANAGED_SHUTDOWN_DELAY_MS)
          + (options.closeWaitTimeoutMs ?? DEFAULT_MANAGED_CLOSE_WAIT_TIMEOUT_MS)
          + DEFAULT_MANAGED_REPLACE_EXTRA_TIMEOUT_MS;
      const result = await killManagedTerminalWindows(options.label, {
        labelScope: options.labelScope,
        timeoutMs
      });
      if (result.status === 'not-found') {
        throw new Error(`No managed terminal session was found for label ${JSON.stringify(result.label)}.`);
      }
      output.log(`Killed managed terminal session ${JSON.stringify(result.label)}.`);
      return;
    }
    if (request.mode === 'reset') {
      const options = validateManagedTerminalLaunchOptions(
        readTerminalWindowsConfigOptions(request.configPath)
      );
      const timeoutMs = options.replaceTimeoutMs
        ?? (options.shutdownDelayMs ?? DEFAULT_MANAGED_SHUTDOWN_DELAY_MS)
          + (options.closeWaitTimeoutMs ?? DEFAULT_MANAGED_CLOSE_WAIT_TIMEOUT_MS)
          + DEFAULT_MANAGED_REPLACE_EXTRA_TIMEOUT_MS;
      const result = await resetManagedTerminalWindows(options.label, {
        labelScope: options.labelScope,
        timeoutMs,
        force: request.force === true
      });
      if (result.status === 'not-found') {
        throw new Error(`No managed terminal session was found for label ${JSON.stringify(result.label)}.`);
      }
      if (result.status === 'busy') {
        throw new Error(
          `Managed terminal session ${JSON.stringify(result.label)} (${result.sessionId}) is still running. Use 'termhelm kill' to stop it instead of reset.`
        );
      }
      output.log(`Reset stale managed terminal session ${JSON.stringify(result.label)} (${result.sessionId}).`);
      return;
    }
    const config = readTerminalWindowsConfig(request.configPath);
    const detached = request.detached === true || config.detached === true;
    if (config.options?.label !== undefined) {
      const options = validateManagedTerminalLaunchOptions(config.options);
      if (detached) {
        const result = await launchDetachedManagedTerminalWindows(config.targets, options);
        output.log(
          `Started detached managed terminal session ${JSON.stringify(result.label)} (${result.sessionId}).`
        );
      } else {
        await launchManagedTerminalWindows(config.targets, options);
      }
    } else {
      if (detached) throw new Error('--detach requires a managed config with options.label.');
      launchTerminalWindows(config.targets, config.options ?? {});
    }
    return;
  }

  if (request.mode === 'kill') {
    const options = validateManagedTerminalLaunchOptions(request.managedOptions);
    const result = await killManagedTerminalWindows(options.label, {
      labelScope: options.labelScope,
      timeoutMs: options.replaceTimeoutMs
    });
    if (result.status === 'not-found') {
      throw new Error(`No managed terminal session was found for label ${JSON.stringify(result.label)}.`);
    }
    output.log(`Killed managed terminal session ${JSON.stringify(result.label)}.`);
    return;
  }

  if (request.mode === 'reset') {
    const options = validateManagedTerminalLaunchOptions(request.managedOptions);
    const result = await resetManagedTerminalWindows(options.label, {
      labelScope: options.labelScope,
      timeoutMs: options.replaceTimeoutMs,
      force: request.force === true
    });
    if (result.status === 'not-found') {
      throw new Error(`No managed terminal session was found for label ${JSON.stringify(result.label)}.`);
    }
    if (result.status === 'busy') {
      throw new Error(
        `Managed terminal session ${JSON.stringify(result.label)} (${result.sessionId}) is still running. Use 'termhelm kill' to stop it instead of reset.`
      );
    }
    output.log(`Reset stale managed terminal session ${JSON.stringify(result.label)} (${result.sessionId}).`);
    return;
  }

  if (request.target) {
    if (request.managedOptions) {
      if (request.detached) {
        const result = await launchDetachedManagedTerminalWindows([request.target], request.managedOptions);
        output.log(
          `Started detached managed terminal session ${JSON.stringify(result.label)} (${result.sessionId}).`
        );
      } else {
        await launchManagedTerminalWindows([request.target], request.managedOptions);
      }
    } else {
      launchTerminalWindows([request.target]);
    }
    return;
  }

  throw new Error('Missing --config or inline target flags.');
}

export async function runTerminalWindowsCli(
  args: string[],
  output: CliOutput = console
): Promise<number> {
  try {
    await executeTerminalWindowsCli(args, output);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(`termhelm: ${message}`);
    process.exitCode = 1;
    return 1;
  }
}
