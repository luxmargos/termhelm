#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { launchManagedTerminalWindows, posixShellQuote } from '../../dist/index.js';

const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const daemon = name => fileURLToPath(new URL(`./daemons/${name}.mjs`, import.meta.url));
const nodeCommand = name => `${posixShellQuote(process.execPath)} ${posixShellQuote(daemon(name))}`;
const commonEnvironment = {
  TERMHELM_DEMO_API_PORT: process.env.TERMHELM_DEMO_API_PORT ?? '43801',
  TERMHELM_DEMO_WEB_PORT: process.env.TERMHELM_DEMO_WEB_PORT ?? '43802',
  TERMHELM_DEMO_EVENT_PORT: process.env.TERMHELM_DEMO_EVENT_PORT ?? '43803'
};

const targets = [
  {
    title: 'termhelm-demo-api',
    cwd: demoRoot,
    command: nodeCommand('api-server'),
    env: commonEnvironment,
    exitMessage: '[demo] API daemon completed.'
  },
  {
    title: 'termhelm-demo-web',
    cwd: demoRoot,
    command: nodeCommand('web-server'),
    env: commonEnvironment,
    exitMessage: '[demo] Web daemon completed.'
  },
  {
    title: 'termhelm-demo-events',
    cwd: demoRoot,
    command: nodeCommand('event-server'),
    env: commonEnvironment,
    exitMessage: '[demo] Event daemon completed.'
  },
  {
    title: 'termhelm-demo-worker-tree',
    cwd: demoRoot,
    command: nodeCommand('worker'),
    exitMessage: '[demo] Worker process tree completed.'
  }
];

console.log('[demo-supervisor] launching four managed daemon trees');
await launchManagedTerminalWindows(targets, {
  label: 'termhelm-realistic-managed-demo',
  labelScope: { type: 'project', root: demoRoot },
  autoClose: true,
  shutdownDelayMs: 2_000,
  closeWaitTimeoutMs: 6_000
});
