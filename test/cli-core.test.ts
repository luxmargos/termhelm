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

  it('parses kill config mode', () => {
    expect(parseTerminalWindowsCliArgs(['kill', '--config', 'termhelm.json'])).toEqual({
      mode: 'kill',
      help: false,
      configPath: 'termhelm.json'
    });
  });

  it('parses an inline plain launch', () => {
    expect(parseTerminalWindowsCliArgs([
      'launch', '--title', 'api', '--cwd', '.', '--command', 'pnpm dev',
      '--env', 'NODE_ENV=development', '--exit-message', 'done'
    ])).toMatchObject({
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

  it('uses a label to select managed launch behavior', () => {
    expect(parseTerminalWindowsCliArgs([
      'launch', '--label', 'local-dev', '--title', 'api', '--command', 'pnpm dev'
    ])).toMatchObject({
      mode: 'launch',
      managedOptions: {
        label: 'local-dev',
        labelScope: { type: 'user' },
        replaceLabels: []
      }
    });
  });

  it('validates a managed label before resolving the inline cwd', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'launch', '--label', '', '--title', 'api', '--cwd', '\0', '--command', 'pnpm dev'
    ])).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
  });

  it('canonicalizes an explicit project scope for managed launch', () => {
    expect(parseTerminalWindowsCliArgs([
      'launch', '--label', 'local-dev', '--label-scope', 'project', '--project-root', '.',
      '--title', 'api', '--cwd', '.', '--command', 'pnpm dev'
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
      'launch', '--label', 'local-dev', '--label-scope', 'project',
      '--title', 'api', '--cwd', 'test', '--command', 'pnpm dev'
    ]);

    expect(request.target?.cwd).toBe(cwd);
    expect(request.managedOptions?.labelScope).toEqual({ type: 'project', root: cwd });
  });

  it('uses the current working directory as the implicit kill project root', () => {
    const request = parseTerminalWindowsCliArgs([
      'kill', '--label', 'local-dev', '--label-scope', 'project'
    ]);

    expect(request.managedOptions?.labelScope).toEqual({
      type: 'project',
      root: realpathSync(process.cwd())
    });
  });

  it('prefers an explicit project root over the inline cwd', () => {
    const request = parseTerminalWindowsCliArgs([
      'launch', '--label', 'local-dev', '--label-scope', 'project', '--project-root', '.',
      '--title', 'api', '--cwd', 'test', '--command', 'pnpm dev'
    ]);

    expect(request.target?.cwd).toBe(realpathSync(join(process.cwd(), 'test')));
    expect(request.managedOptions?.labelScope).toEqual({
      type: 'project',
      root: realpathSync(process.cwd())
    });
  });

  it.each(['', ' ', '\t'])('rejects an explicitly blank project root %j', (projectRoot) => {
    expect(() => parseTerminalWindowsCliArgs([
      'launch', '--label', 'local-dev', '--label-scope', 'project', '--project-root', projectRoot,
      '--title', 'api', '--command', 'pnpm dev'
    ])).toThrow('--project-root must be a non-empty path when provided');
  });

  it('rejects project roots outside project scope', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'kill', '--label', 'dev', '--project-root', '.'
    ])).toThrow('--project-root is only valid');
  });

  it('requires a label when managed identity flags are present', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'launch', '--label-scope', 'project', '--title', 'api', '--command', 'x'
    ])).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
  });

  it('rejects inline flags combined with config mode', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'launch', '--config', 'termhelm.json', '--label', 'dev'
    ])).toThrow('either --config or inline flags');
    expect(() => parseTerminalWindowsCliArgs([
      'kill', '--config', 'termhelm.json', '--label', 'dev'
    ])).toThrow('either --config or inline flags');
  });

  it('parses an inline kill by label', () => {
    expect(parseTerminalWindowsCliArgs(['kill', '--label', 'local-dev'])).toMatchObject({
      mode: 'kill',
      managedOptions: {
        label: 'local-dev',
        labelScope: { type: 'user' }
      }
    });
  });

  it('rejects target flags in kill mode', () => {
    expect(() => parseTerminalWindowsCliArgs([
      'kill', '--label', 'local-dev', '--title', 'api'
    ])).toThrow('Kill accepts only managed label identity flags');
  });

  it('requires a label for inline kill mode', () => {
    expect(() => parseTerminalWindowsCliArgs(['kill'])).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
  });

  it('rejects missing config or inline target flags for launch', () => {
    expect(() => parseTerminalWindowsCliArgs(['launch'])).toThrow('Missing --config');
  });

  it('rejects the removed managed command', () => {
    expect(() => parseTerminalWindowsCliArgs(['managed'])).toThrow('Unknown command: managed');
  });

  it('provides help text', () => {
    expect(parseTerminalWindowsCliArgs(['--help'])).toEqual({ help: true });
    expect(helpText()).toContain('termhelm launch [--label <label>]');
    expect(helpText()).toContain('termhelm kill --label <label>');
    expect(helpText()).toContain('A launch with a label is managed');
    expect(helpText()).toContain('Defaults to the current working directory');
    expect(helpText()).toContain('Defaults to the resolved --cwd');
  });
});
