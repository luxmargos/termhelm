import { helpText, parseTerminalWindowsCliArgs } from './cli-core.js';
import { validateManagedTerminalLaunchOptions } from './config.js';
import { launchManagedTerminalWindows, launchTerminalWindows, readTerminalWindowsConfig } from './index.js';

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
    const config = readTerminalWindowsConfig(request.configPath);
    if (request.mode === 'managed') {
      await launchManagedTerminalWindows(config.targets, validateManagedTerminalLaunchOptions(config.options));
    } else {
      launchTerminalWindows(config.targets, config.options ?? {});
    }
    return;
  }

  if (request.target) {
    if (request.mode === 'managed') {
      await launchManagedTerminalWindows([request.target], validateManagedTerminalLaunchOptions(request.managedOptions));
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
