import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANAGED_TERMINAL_LABEL_ERROR,
  readTerminalWindowsConfig,
  validateManagedTerminalLaunchOptions,
  validateTerminalTarget,
  validateTerminalWindowsConfig
} from '../src/config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('config validation', () => {
  it('accepts plain config without a managed label', () => {
    expect(validateTerminalWindowsConfig({
      targets: [{ title: 'api', cwd: '.', command: 'pnpm dev', env: { A: 'B' } }],
      options: { exitAfterCommand: false }
    })).toMatchObject({ targets: [{ title: 'api', command: 'pnpm dev' }], options: { exitAfterCommand: false } });
  });

  it('defaults an omitted target cwd and validates an explicit cwd like inline CLI mode', () => {
    expect(validateTerminalTarget({ title: 'api', command: 'pnpm dev' }).cwd).toBe(
      realpathSync(process.cwd())
    );

    for (const cwd of ['', ' ', '\t']) {
      expect(() => validateTerminalTarget({ title: 'api', cwd, command: 'pnpm dev' })).toThrow(
        'cwd must be a non-empty path when provided'
      );
    }
    for (const cwd of ['package.json', 'test/__terminal-windows-missing-cwd__']) {
      expect(() => validateTerminalTarget({ title: 'api', cwd, command: 'pnpm dev' })).toThrow(
        'cwd must resolve to an existing directory'
      );
    }
  });

  it('requires an exact, non-blank managed label', () => {
    for (const value of [undefined, {}, { label: '' }, { label: ' ' }, { label: ' dev' }, { label: 'dev ' }, { label: 1 }]) {
      expect(() => validateManagedTerminalLaunchOptions(value)).toThrow(MANAGED_TERMINAL_LABEL_ERROR);
    }
  });

  it('normalizes labels to NFC and treats replaceLabels as deduplicated additions', () => {
    expect(validateManagedTerminalLaunchOptions({
      label: 'de\u0301v',
      replaceLabels: ['dév', 'API', 'API', 'api']
    })).toEqual({
      label: 'dév',
      labelScope: { type: 'user' },
      replaceLabels: ['API', 'api']
    });
  });

  it('validates timeout and boolean option types', () => {
    expect(() => validateManagedTerminalLaunchOptions({ label: 'dev', shutdownDelayMs: -1 })).toThrow('shutdownDelayMs');
    expect(() => validateManagedTerminalLaunchOptions({ label: 'dev', shutdownDelayMs: 2.5 })).toThrow('shutdownDelayMs');
    expect(() => validateManagedTerminalLaunchOptions({ label: 'dev', closeWaitTimeoutMs: 0x8000_0000 })).toThrow('closeWaitTimeoutMs');
    expect(() => validateManagedTerminalLaunchOptions({ label: 'dev', replaceTimeoutMs: Number.NaN })).toThrow('replaceTimeoutMs');
    expect(() => validateManagedTerminalLaunchOptions({ label: 'dev', exitAfterCommand: 'yes' })).toThrow('exitAfterCommand');
  });

  it('resolves a config project root relative to the config file and canonicalizes it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'terminal-windows-config-'));
    temporaryDirectories.push(directory);
    const projectDirectory = join(directory, 'project');
    mkdirSync(projectDirectory);
    const configPath = join(directory, 'terminal-windows.json');
    writeFileSync(configPath, JSON.stringify({
      targets: [{ title: 'api', cwd: '.', command: 'pnpm dev' }],
      options: { label: 'dev', labelScope: { type: 'project', root: './project' } }
    }));

    expect(readTerminalWindowsConfig(configPath).options?.labelScope).toEqual({
      type: 'project',
      root: realpathSync(projectDirectory)
    });
  });

  it('requires an explicit, existing project root', () => {
    expect(() => validateManagedTerminalLaunchOptions({ label: 'dev', labelScope: { type: 'project' } })).toThrow('root is required');
    expect(() => validateManagedTerminalLaunchOptions({
      label: 'dev', labelScope: { type: 'project', root: './does-not-exist' }
    })).toThrow('must resolve to an existing directory');
    const filePath = join(mkdtempSync(join(tmpdir(), 'terminal-windows-root-file-')), 'not-a-directory');
    temporaryDirectories.push(dirname(filePath));
    writeFileSync(filePath, 'not a project root');
    expect(() => validateManagedTerminalLaunchOptions({
      label: 'dev', labelScope: { type: 'project', root: filePath }
    })).toThrow('existing directory');
  });

  it('rejects missing targets and invalid env values', () => {
    expect(() => validateTerminalWindowsConfig({ targets: [] })).toThrow('targets array');
    expect(() => validateTerminalWindowsConfig({
      targets: [{ title: 'api', cwd: '.', command: 'x', env: { A: 1 } }]
    })).toThrow('env.A');
  });
});
