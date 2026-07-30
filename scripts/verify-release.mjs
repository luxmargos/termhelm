import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const headless = process.argv.includes('--headless');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;

function spawnPortable(command, args, options = {}) {
  return spawnSync(command, args, {
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    windowsHide: true,
    ...options
  });
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnPortable(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} exited with status ${String(result.status)}.`);
  }
}

function available(command) {
  const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    stdio: 'ignore',
    windowsHide: true
  });
  return result.error === undefined && result.status === 0;
}

function requireNativeEnvironment() {
  if (headless) {
    console.warn('HEADLESS MODE: GUI/native-host acceptance is not release evidence.');
    return;
  }
  if (process.platform === 'darwin' && process.env.TERMHELM_MANUAL_MACOS !== '1') {
    throw new Error('Set TERMHELM_MANUAL_MACOS=1 for the native macOS release gate.');
  }
  if (process.platform === 'linux') {
    if (process.env.TERMHELM_LINUX_GUI_TEST !== '1' || !process.env.DISPLAY) {
      throw new Error('Run under Xvfb/a desktop with DISPLAY and TERMHELM_LINUX_GUI_TEST=1.');
    }
    for (const command of ['xterm', 'bash', 'zsh', 'dash', 'fish']) {
      const resolved = spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
      if (resolved.error || resolved.status !== 0) {
        throw new Error(`The native Linux release gate requires ${command}.`);
      }
    }
  }
  if (process.platform === 'win32') {
    for (const host of ['powershell.exe', 'pwsh']) {
      if (!available(host)) throw new Error(`The native Windows release gate requires ${host}.`);
    }
  }
}

function parsePackJson(stdout) {
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error('npm pack did not return JSON metadata.');
  return JSON.parse(stdout.slice(start))[0];
}

function verifyPackedArtifact() {
  const directory = mkdtempSync(join(tmpdir(), 'termhelm-release-pack-'));
  try {
    const packed = spawnPortable(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], {
      cwd: root,
      encoding: 'utf8'
    });
    if (packed.error || packed.status !== 0) {
      throw packed.error ?? new Error(`npm pack failed: ${packed.stderr}`);
    }
    const metadata = parsePackJson(packed.stdout);
    const files = new Set(metadata.files.map(entry => String(entry.path).replaceAll('\\', '/')));
    for (const required of [
      'dist/index.js',
      'dist/index.d.ts',
      'dist/cli.js',
      'dist/detached-supervisor.js',
      'dist/platforms/posix-sidecar.js',
      'dist/platforms/linux-launcher-watch.js',
      'native/windows/termhelm-controller.ps1',
      'README.md',
      'LICENSE',
      'package.json'
    ]) {
      if (!files.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
    }
    const archive = join(directory, metadata.filename);
    run(npm, ['init', '-y'], { cwd: directory, stdio: 'ignore' });
    // npm init created the package at directory; install there to avoid a tar dependency.
    run(npm, ['install', '--ignore-scripts', archive], { cwd: directory, stdio: 'ignore' });
    writeFileSync(join(directory, 'import-smoke.mjs'), [
      "import * as termhelm from '@luxmargos/termhelm';",
      "import metadata from '@luxmargos/termhelm/package.json' with { type: 'json' };",
      "if (typeof termhelm.launchTerminalWindows !== 'function') throw new Error('Missing launch API');",
      "if (typeof termhelm.startManagedTerminalWindows !== 'function') throw new Error('Missing managed session API');",
      "if (typeof termhelm.launchDetachedManagedTerminalWindows !== 'function') throw new Error('Missing detached managed API');",
      `if (metadata.version !== ${JSON.stringify(metadata.version)}) throw new Error('Version mismatch');`
    ].join('\n'));
    run(node, [join(directory, 'import-smoke.mjs')], { cwd: directory });
    if (process.platform === 'win32') {
      const packedController = join(
        directory, 'node_modules', '@luxmargos', 'termhelm',
        'native', 'windows', 'termhelm-controller.ps1'
      );
      for (const host of ['powershell.exe', 'pwsh']) {
        run(host, [
          '-NoLogo', '-NoProfile', '-NonInteractive',
          ...(host === 'powershell.exe' ? ['-ExecutionPolicy', 'Bypass'] : []),
          '-File', packedController, '-SelfTest'
        ], { cwd: directory });
      }
    } else {
      const cli = join(directory, 'node_modules', '@luxmargos', 'termhelm', 'dist', 'cli.js');
      if ((statSync(cli).mode & 0o111) === 0) throw new Error('Packed CLI is not executable.');
    }
    console.log(`Verified packed artifact ${basename(archive)} (${metadata.entryCount} files).`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function testFiles(directory, relative = 'test') {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const childRelative = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(absolute, childRelative));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(childRelative);
  }
  return files.sort();
}

function main() {
  requireNativeEnvironment();
  run(pnpm, ['install', '--frozen-lockfile']);
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  run(pnpm, ['run', 'build']);
  run(pnpm, ['run', 'test:types']);
  run(pnpm, ['run', 'verify:windows-helpers']);
  const tests = testFiles(join(root, 'test'));
  run(pnpm, ['exec', 'vitest', 'run', ...tests, '--reporter=dot'], {
    env: process.platform === 'linux'
      ? { ...process.env, TERMHELM_LINUX_GUI_TEST: '0' }
      : process.env
  });
  if (!headless && process.platform === 'linux') {
    run(pnpm, ['exec', 'vitest', 'run', 'test/linux-terminal.integration.test.ts', '--reporter=verbose']);
  }
  if (!headless && process.platform === 'darwin') {
    run(pnpm, ['exec', 'vitest', 'run', 'test/macos-terminal.manual.test.ts', '--reporter=verbose']);
  }
  verifyPackedArtifact();
  console.log(`\nTermHelm ${headless ? 'headless checks' : `${process.platform} native release gate`} passed.`);
}

try {
  main();
} catch (error) {
  console.error(`termhelm release verification: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
