#!/usr/bin/env node
import { launchManagedTerminalWindows } from '../../dist/index.js';
import { demoManagedOptions, demoTargets } from './session.mjs';

console.log('[demo-supervisor] launching four managed daemon trees in foreground mode');
console.log('[demo-supervisor] this process remains alive until the session stops');
await launchManagedTerminalWindows(demoTargets(), demoManagedOptions());
