#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./worker-child.mjs', import.meta.url));
const child = spawn(process.execPath, [childPath], { stdio: 'inherit' });
console.log(`READY worker pid=${process.pid} child=${child.pid}`);

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}; asking child ${child.pid} to stop`);
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  timer.unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
child.once('exit', (code, signal) => {
  console.log(`[worker] child exited code=${String(code)} signal=${String(signal)}`);
  process.exit(stopping ? 0 : (code ?? 1));
});
