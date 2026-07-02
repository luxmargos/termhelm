#!/usr/bin/env node
import { launchManagedTerminalWindows, launchTerminalWindows, readTerminalWindowsConfig } from './index.js';
import { helpText, parseTerminalWindowsCliArgs } from './cli-core.js';

async function main(): Promise<void> {
  const request = parseTerminalWindowsCliArgs(process.argv.slice(2));
  if (request.help) {
    console.log(helpText());
    return;
  }

  if (!request.mode) throw new Error('Missing command mode.');

  if (request.configPath) {
    const config = readTerminalWindowsConfig(request.configPath);
    if (request.mode === 'managed') await launchManagedTerminalWindows(config.targets, config.options ?? {});
    else launchTerminalWindows(config.targets, config.options ?? {});
    return;
  }

  if (request.target) {
    if (request.mode === 'managed') await launchManagedTerminalWindows([request.target]);
    else launchTerminalWindows([request.target]);
    return;
  }

  throw new Error('Missing --config or inline target flags.');
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`terminal-windows: ${message}`);
  process.exitCode = 1;
});
