import { helpText, parseTerminalWindowsCliArgs } from './cli-core.js';
import {
  readTerminalWindowsConfigOptions,
  validateManagedTerminalLaunchOptions
} from './config.js';
import {
  killManagedTerminalWindows,
  launchManagedTerminalWindows,
  launchTerminalWindows,
  readTerminalWindowsConfig
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
    const config = readTerminalWindowsConfig(request.configPath);
    if (config.options?.label !== undefined) {
      await launchManagedTerminalWindows(config.targets, validateManagedTerminalLaunchOptions(config.options));
    } else {
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

  if (request.target) {
    if (request.managedOptions) {
      await launchManagedTerminalWindows([request.target], request.managedOptions);
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
