import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: childProcess.spawnSync
}));

import { closeMacTerminalTab } from '../src/platforms/macos.js';

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
});
