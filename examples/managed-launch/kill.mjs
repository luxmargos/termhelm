#!/usr/bin/env node
import { killManagedTerminalWindows } from '../../dist/index.js';
import { demoLabel, demoManagedOptions } from './session.mjs';

const options = demoManagedOptions();
const result = await killManagedTerminalWindows(demoLabel, {
  labelScope: options.labelScope,
  timeoutMs: 15_000
});
console.log(`[demo-kill] ${result.status}${result.status === 'killed' ? ` session=${result.sessionId}` : ''}`);
