#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { launchTerminalWindows, posixShellQuote } from '../../dist/index.js';

const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const command = name => `${posixShellQuote(process.execPath)} ${posixShellQuote(fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)))}`;
const environment = {
  TERMHELM_DEMO_API_PORT: process.env.TERMHELM_DEMO_API_PORT ?? '43801',
  TERMHELM_DEMO_WEB_PORT: process.env.TERMHELM_DEMO_WEB_PORT ?? '43802',
  TERMHELM_DEMO_EVENT_PORT: process.env.TERMHELM_DEMO_EVENT_PORT ?? '43803'
};

launchTerminalWindows([
  {
    title: 'termhelm-demo-supervisor',
    cwd: demoRoot,
    command: command('supervisor'),
    env: environment,
    exitMessage: '[demo] Managed supervisor completed.'
  }
], { autoClose: true, exitAfterCommand: true });

launchTerminalWindows([
  {
    title: 'termhelm-demo-health-monitor',
    cwd: demoRoot,
    command: command('monitor'),
    env: environment,
    exitMessage: '[demo] Health monitor completed.'
  }
], { autoClose: true, exitAfterCommand: true });

console.log('[demo-fresh] launched nested supervisor and health monitor terminals');
console.log('[demo-fresh] run this command again to test authenticated replacement');
