#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  launchDetachedManagedTerminalWindows,
  launchTerminalWindows,
  posixShellQuote,
  windowsCmdQuote
} from '../../dist/index.js';
import {
  demoEnvironment,
  demoManagedOptions,
  demoRoot,
  demoTargets
} from './session.mjs';

const quote = process.platform === 'win32' ? windowsCmdQuote : posixShellQuote;
const command = name => `${quote(process.execPath)} ${quote(fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)))}`;

console.log('[demo-fresh] replacing the managed session in a hidden detached supervisor');
const result = await launchDetachedManagedTerminalWindows(
  demoTargets(),
  demoManagedOptions()
);
console.log(`[demo-fresh] detached session ready: label=${result.label} session=${result.sessionId}`);

// On Windows the controller (a child of this process) is killed when this
// process exits, taking the terminal window with it. Keep this process alive
// until the health monitor terminal closes so the window stays visible.
const healthMonitor = launchTerminalWindows([
  {
    title: 'termhelm-demo-health-monitor',
    cwd: demoRoot,
    command: command('monitor'),
    env: demoEnvironment(),
    exitMessage: '[demo] Health monitor completed.'
  }
], { autoClose: true, exitAfterCommand: false });

console.log('[demo-fresh] launched the health monitor');
console.log('[demo-fresh] run this command again in another terminal to test authenticated replacement');
await healthMonitor.closed;
console.log('[demo-fresh] health monitor closed');
