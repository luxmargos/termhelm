#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { killManagedTerminalWindows } from '../../dist/index.js';

const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const result = await killManagedTerminalWindows('termhelm-realistic-managed-demo', {
  labelScope: { type: 'project', root: demoRoot },
  timeoutMs: 15_000
});
console.log(`[demo-kill] ${result.status}${result.status === 'killed' ? ` session=${result.sessionId}` : ''}`);
