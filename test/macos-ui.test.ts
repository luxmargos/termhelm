import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: childProcess.spawnSync
}));

import { closeMacTerminalTab, launchMacTerminalController } from '../src/platforms/macos.js';

describe('mocked macOS Terminal UI cleanup', () => {
  beforeEach(() => childProcess.spawnSync.mockReset());

  it('closes only the tab matching both captured window ID and TTY', () => {
    closeMacTerminalTab(731, '/dev/ttys042');

    expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
    const [executable, args, options] = childProcess.spawnSync.mock.calls[0]!;
    expect(executable).toBe('osascript');
    expect(options).toEqual({ stdio: 'ignore' });
    const script = (args as string[]).filter((_, index) => index % 2 === 1).join('\n');
    expect(script).toContain('targetWindowId to 731');
    expect(script).toContain('targetTty to "/dev/ttys042"');
    expect(script).toContain('first window whose id is targetWindowId');
    expect(script).toContain('tty of targetTab is targetTty');
    expect(script).toContain('close targetTab');
    expect(script).not.toContain('custom title');
  });

  it('sources managed launch logic from a private script instead of submitting multiline shell input', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '731\n/dev/ttys042\n',
      stderr: '',
      error: undefined
    });

    const controller = launchMacTerminalController({
      title: 'private launch',
      cwd: process.cwd(),
      command: 'printf managed-command-sentinel',
      env: { TERMHELM_SECRET_SENTINEL: 'private-value' }
    });
    const controlDirectory = dirname(controller.readyPath);
    const launchScriptPath = join(controlDirectory, `${controller.id}.launch.sh`);

    try {
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
      const [executable, args, options] = childProcess.spawnSync.mock.calls[0]!;
      expect(executable).toBe('osascript');
      expect(options).toEqual({ encoding: 'utf8' });
      const doScript = (args as string[]).find(argument => argument.startsWith('set targetTab to do script '));
      expect(doScript).toBeDefined();
      expect(doScript).toBe(`set targetTab to do script ". '${launchScriptPath}'"`);
      expect(doScript).not.toMatch(/[\r\n]/);
      expect(doScript).not.toContain('termhelm_runner_');
      expect(doScript).not.toContain('managed-command-sentinel');
      expect(doScript).not.toContain('TERMHELM_SECRET_SENTINEL');

      expect(existsSync(launchScriptPath)).toBe(true);
      expect(statSync(launchScriptPath).mode & 0o777).toBe(0o600);
      const launchScript = readFileSync(launchScriptPath, 'utf8');
      expect(launchScript.startsWith(`/bin/rm -f '${launchScriptPath}'\n`)).toBe(true);
      expect(launchScript).toContain(`termhelm_runner_${controller.id.replace(/-/g, '_')}`);
    } finally {
      rmSync(controlDirectory, { recursive: true, force: true });
    }
  });

  it('removes the private launch script when osascript cannot start', () => {
    const controlDirectory = mkdtempSync(join(tmpdir(), 'termhelm-macos-ui-'));
    childProcess.spawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('osascript is unavailable')
    });

    try {
      expect(() => launchMacTerminalController(
        {
          title: 'failed private launch',
          cwd: process.cwd(),
          command: 'exit 0'
        },
        {},
        { controlDirectory }
      )).toThrow('Failed to launch Terminal: osascript is unavailable');
      expect(readdirSync(controlDirectory).some(name => name.endsWith('.launch.sh'))).toBe(false);
    } finally {
      rmSync(controlDirectory, { recursive: true, force: true });
    }
  });
});
