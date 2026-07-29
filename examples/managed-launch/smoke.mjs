#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const basePort = 44_000 + (process.pid % 1_000);
const env = {
  ...process.env,
  TERMHELM_DEMO_API_PORT: String(basePort),
  TERMHELM_DEMO_WEB_PORT: String(basePort + 1),
  TERMHELM_DEMO_EVENT_PORT: String(basePort + 2)
};
const daemon = name => fileURLToPath(new URL(`./daemons/${name}.mjs`, import.meta.url));
const children = [];

function start(name) {
  const child = spawn(process.execPath, [daemon(name)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
  return { child, ready: waitFor(() => output.includes('READY '), 10_000, () => `${name} output:\n${output}`) };
}

async function waitFor(predicate, timeoutMs, detail) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for demo daemon. ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for demo process exit.')), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

try {
  const started = ['api-server', 'web-server', 'event-server', 'worker'].map(start);
  await Promise.all(started.map(item => item.ready));

  for (const port of [basePort, basePort + 1, basePort + 2]) {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) throw new Error(`Demo health endpoint ${port} returned ${response.status}.`);
  }

  const monitor = spawn(process.execPath, [fileURLToPath(new URL('./monitor.mjs', import.meta.url))], {
    env,
    stdio: 'inherit'
  });
  children.push(monitor);
  const monitorStatus = await waitForExit(monitor, 15_000);
  if (monitorStatus !== 0) throw new Error(`Demo monitor exited with ${String(monitorStatus)}.`);
  console.log('[demo-smoke] all mock daemons and health checks passed');
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await Promise.all(children.map(child => waitForExit(child, 5_000).catch(() => {
    child.kill('SIGKILL');
    return null;
  })));
}
