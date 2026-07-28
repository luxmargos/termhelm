import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANAGED_TERMINAL_LABEL_ERROR } from '../src/config.js';
import { helpText, parseTerminalWindowsCliArgs } from '../src/cli-core.js';

describe('CLI argument parsing', () => {
  it('parses launch config mode', () => {
    expect(parseTerminalWindowsCliArgs(['launch', '--config', 'termhelm.json'])).toEqual({
      mode: 'launch',
      help: false,
      configPath: 'termhelm.json'
    });
  });

  it('parses managed config mode', () => {
    expect(parseTerminalWindowsCliArgs(['managed', '--config', 'termhelm.json'])).toEqual({
      mode: 'managed',
      help: false,
      configPath: 'termhelm.json'
    });
  });

  it('parses inline launch target flags', () => {
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
        cwd: realpathSync(process.cwd()),
        command: 'pnpm dev',
        env: { NODE_ENV: 'development' },
        exitMessage: 'done'
      }
    });
  });

  it('defaults an omitted inline cwd to the canonical current working directory', () => {
    expect(parseTerminalWindowsCliArgs([
      'launch', '--title', 'api', '--command', 'pnpm dev'
    ])).toMatchObject({
      target: {
        title: 'api',
        cwd: realpathSync(process.cwd()),
        command: 'pnpm dev'
      }
    });
  });

  it.each(['', ' ', '\t'])('rejects an explicitly blank inline cwd %j', (cwd) => {
    expect(() => parseTerminalWindowsCliArgs([
      'launch', '--title', 'api', '--cwd', cwd, '--command', 'pnpm dev'
    ])).toThrow('--cwd');
  });

  it.each(['package.json', 'test/__termhelm-missing-cwd__'])(
    'rejects a cwd that is not an existing directory: %s',
    (cwd) => {
      expect(() => parseTerminalWindowsCliArgs([
        'launch', '--title', 'api', '--cwd', cwd, '--command', 'pnpm dev'
      ])).toThrow('--cwd must resolve to an existing directory');
    }
  );

  it('requires a label for inline managed mode', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'managed', '--title', 'api', '--cwd', '.', '--command', 'pnpm dev'
    ])).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
    expect(() => parseTerminalWindowsCliArgs([
      'managed', '--command', 'pnpm dev'
    ])).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
  });

  it('validates the managed label before resolving the inline cwd', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'managed', '--title', 'api', '--cwd', '\0', '--command', 'pnpm dev'
    ])).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
  });

  it('parses a user-scoped inline managed target', () => {
    expect(parseTerminalWindowsCliArgs([
      'managed', '--label', 'local-dev', '--title', 'api', '--cwd', '.', '--command', 'pnpm dev'
    ])).toMatchObject({
      mode: 'managed',
      managedOptions: {
        label: 'local-dev',
        labelScope: { type: 'user' },
        replaceLabels: []
      }
    });
  });

  it('canonicalizes an explicit project scope for inline managed mode', () => {
    expect(parseTerminalWindowsCliArgs([
      'managed',
      '--label', 'local-dev',
      '--label-scope', 'project',
      '--project-root', '.',
      '--title', 'api',
      '--cwd', '.',
      '--command', 'pnpm dev'
    ])).toMatchObject({
      managedOptions: {
        label: 'local-dev',
        labelScope: { type: 'project', root: realpathSync(process.cwd()) }
      }
    });
  });

  it('uses the resolved inline cwd as an implicit project root', () => {
    const cwd = realpathSync(join(process.cwd(), 'test'));
    const request = parseTerminalWindowsCliArgs([
      'managed',
      '--label', 'local-dev',
      '--label-scope', 'project',
      '--title', 'api',
      '--cwd', 'test',
      '--command', 'pnpm dev'
    ]);

    expect(request.target?.cwd).toBe(cwd);
    expect(request.managedOptions?.labelScope).toEqual({ type: 'project', root: cwd });
  });

  it('uses the current working directory as the implicit cwd and project root', () => {
    const cwd = realpathSync(process.cwd());
    const request = parseTerminalWindowsCliArgs([
      'managed',
      '--label', 'local-dev',
      '--label-scope', 'project',
      '--title', 'api',
      '--command', 'pnpm dev'
    ]);

    expect(request.target?.cwd).toBe(cwd);
    expect(request.managedOptions?.labelScope).toEqual({ type: 'project', root: cwd });
  });

  it('prefers an explicit project root over the inline cwd', () => {
    const request = parseTerminalWindowsCliArgs([
      'managed',
      '--label', 'local-dev',
      '--label-scope', 'project',
      '--project-root', '.',
      '--title', 'api',
      '--cwd', 'test',
      '--command', 'pnpm dev'
    ]);

    expect(request.target?.cwd).toBe(realpathSync(join(process.cwd(), 'test')));
    expect(request.managedOptions?.labelScope).toEqual({
      type: 'project',
      root: realpathSync(process.cwd())
    });
  });

  it.each(['', ' ', '\t'])('rejects an explicitly blank project root %j', (projectRoot) => {
    expect(() => parseTerminalWindowsCliArgs([
      'managed',
      '--label', 'local-dev',
      '--label-scope', 'project',
      '--project-root', projectRoot,
      '--title', 'api',
      '--command', 'pnpm dev'
    ])).toThrow('--project-root must be a non-empty path when provided');
  });

  it('rejects project roots outside project scope', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'managed', '--label', 'dev', '--project-root', '.', '--title', 'api', '--cwd', '.', '--command', 'x'
    ])).toThrow('--project-root is only valid');
  });

  it('rejects managed identity flags in plain or config mode', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'launch', '--label', 'dev', '--title', 'api', '--cwd', '.', '--command', 'x'
    ])).toThrow('only valid for managed mode');
    expect(() => parseTerminalWindowsCliArgs([
      'managed', '--config', 'termhelm.json', '--label', 'dev'
    ])).toThrow('cannot be combined with --config');
  });

  it('rejects missing config or inline target flags', () => {
    expect(() => parseTerminalWindowsCliArgs(['launch'])).toThrow('Missing --config');
  });

  it('provides help text', () => {
    expect(parseTerminalWindowsCliArgs(['--help'])).toEqual({ help: true });
    expect(helpText()).toContain('termhelm managed --label <label>');
    expect(helpText()).toContain('Defaults to the current working directory');
    expect(helpText()).toContain('Defaults to the resolved --cwd');
    expect(helpText()).toContain('Managed config files must provide options.label');
  });
});
