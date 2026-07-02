import { describe, expect, it } from 'vitest';
import { helpText, parseTerminalWindowsCliArgs } from '../src/cli-core.js';

describe('CLI argument parsing', () => {
  it('parses launch config mode', () => {
    expect(parseTerminalWindowsCliArgs(['launch', '--config', 'terminal-windows.json'])).toEqual({
      mode: 'launch',
      help: false,
      configPath: 'terminal-windows.json'
    });
  });

  it('parses managed config mode', () => {
    expect(parseTerminalWindowsCliArgs(['managed', '--config', 'terminal-windows.json'])).toMatchObject({
      mode: 'managed',
      configPath: 'terminal-windows.json'
    });
  });

  it('parses inline target flags', () => {
    expect(
      parseTerminalWindowsCliArgs([
        'launch',
        '--title',
        'api',
        '--cwd',
        '.',
        '--command',
        'pnpm dev',
        '--env',
        'NODE_ENV=development',
        '--exit-message',
        'done'
      ])
    ).toMatchObject({
      mode: 'launch',
      target: {
        title: 'api',
        cwd: '.',
        command: 'pnpm dev',
        env: { NODE_ENV: 'development' },
        exitMessage: 'done'
      }
    });
  });

  it('rejects missing config or inline target flags', () => {
    expect(() => parseTerminalWindowsCliArgs(['launch'])).toThrow('Missing --config');
  });

  it('provides help text', () => {
    expect(parseTerminalWindowsCliArgs(['--help'])).toEqual({ help: true });
    expect(helpText()).toContain('terminal-windows managed --config');
  });
});
