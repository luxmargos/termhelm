import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('realistic nested managed-launch demo', () => {
  it('publishes fresh, kill, and non-GUI smoke scripts with all daemon fixtures', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts).toMatchObject({
      'demo:managed:fresh': expect.stringContaining('examples/managed-launch/fresh.mjs'),
      'demo:managed:kill': expect.stringContaining('examples/managed-launch/kill.mjs'),
      'demo:managed:smoke': expect.stringContaining('examples/managed-launch/smoke.mjs')
    });
    for (const path of [
      'examples/managed-launch/fresh.mjs',
      'examples/managed-launch/supervisor.mjs',
      'examples/managed-launch/monitor.mjs',
      'examples/managed-launch/kill.mjs',
      'examples/managed-launch/daemons/api-server.mjs',
      'examples/managed-launch/daemons/web-server.mjs',
      'examples/managed-launch/daemons/event-server.mjs',
      'examples/managed-launch/daemons/worker.mjs',
      'examples/managed-launch/daemons/worker-child.mjs'
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  it('starts every mock daemon, checks health, and drains the worker tree', () => {
    const output = execFileSync(process.execPath, ['examples/managed-launch/smoke.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000
    });
    expect(output).toContain('[demo-smoke] all mock daemons and health checks passed');
    expect(output).toContain('[demo-monitor] nested managed launch is ready');
  });
});
