import { fileURLToPath } from 'node:url';
import { posixShellQuote } from '../../dist/index.js';

export const demoRoot = fileURLToPath(new URL('.', import.meta.url));
export const demoLabel = 'termhelm-realistic-managed-demo';

const daemon = name => fileURLToPath(new URL(`./daemons/${name}.mjs`, import.meta.url));
const nodeCommand = name => `${posixShellQuote(process.execPath)} ${posixShellQuote(daemon(name))}`;

export function demoEnvironment() {
  return {
    TERMHELM_DEMO_API_PORT: process.env.TERMHELM_DEMO_API_PORT ?? '43801',
    TERMHELM_DEMO_WEB_PORT: process.env.TERMHELM_DEMO_WEB_PORT ?? '43802',
    TERMHELM_DEMO_EVENT_PORT: process.env.TERMHELM_DEMO_EVENT_PORT ?? '43803'
  };
}

export function demoTargets() {
  const environment = demoEnvironment();
  return [
    {
      title: 'termhelm-demo-api',
      cwd: demoRoot,
      command: nodeCommand('api-server'),
      env: environment,
      exitMessage: '[demo] API daemon completed.'
    },
    {
      title: 'termhelm-demo-web',
      cwd: demoRoot,
      command: nodeCommand('web-server'),
      env: environment,
      exitMessage: '[demo] Web daemon completed.'
    },
    {
      title: 'termhelm-demo-events',
      cwd: demoRoot,
      command: nodeCommand('event-server'),
      env: environment,
      exitMessage: '[demo] Event daemon completed.'
    },
    {
      title: 'termhelm-demo-worker-tree',
      cwd: demoRoot,
      command: nodeCommand('worker'),
      exitMessage: '[demo] Worker process tree completed.'
    }
  ];
}

export function demoManagedOptions() {
  return {
    label: demoLabel,
    labelScope: { type: 'project', root: demoRoot },
    autoClose: true,
    shutdownDelayMs: 2_000,
    closeWaitTimeoutMs: 6_000
  };
}
