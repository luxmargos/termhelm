import { describe, expect, it } from 'vitest';
import { validateTerminalWindowsConfig } from '../src/config.js';

describe('config validation', () => {
  it('accepts a valid config', () => {
    expect(validateTerminalWindowsConfig({ targets: [{ title: 'api', cwd: '.', command: 'pnpm dev', env: { A: 'B' } }], options: { label: 'dev' } })).toMatchObject({ targets: [{ title: 'api', command: 'pnpm dev' }], options: { label: 'dev' } });
  });
  it('rejects missing targets', () => {
    expect(() => validateTerminalWindowsConfig({ targets: [] })).toThrow('targets array');
  });
  it('rejects invalid env values', () => {
    expect(() => validateTerminalWindowsConfig({ targets: [{ title: 'api', cwd: '.', command: 'x', env: { A: 1 } }] })).toThrow('env.A');
  });
});
