import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultBuildScriptPath = join(repositoryRoot, 'native', 'windows', 'build.ps1');

function commandWasNotFound(error) {
  return error !== undefined && error !== null && error.code === 'ENOENT';
}

/**
 * Run the native helper build with PowerShell Core when available, falling
 * back to Windows PowerShell only when `pwsh` cannot be found.
 */
export function runWindowsHelperBuild(
  args,
  {
    spawn = spawnSync,
    buildScriptPath = defaultBuildScriptPath,
    report = message => console.error(message)
  } = {}
) {
  const powershellArgs = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', buildScriptPath,
    ...args
  ];
  const candidates = ['pwsh', 'powershell.exe'];

  for (let index = 0; index < candidates.length; index += 1) {
    const command = candidates[index];
    const result = spawn(command, powershellArgs, { stdio: 'inherit' });
    if (result.error === undefined) {
      if (result.status !== null) return result.status;
      report(`${command} ended without an exit status${result.signal ? ` (${result.signal})` : ''}.`);
      return 1;
    }

    if (index === 0 && commandWasNotFound(result.error)) {
      report('pwsh was not found; falling back to Windows PowerShell (powershell.exe).');
      continue;
    }

    if (commandWasNotFound(result.error)) {
      report('Neither pwsh nor powershell.exe was found. Install PowerShell or run this build on Windows.');
    } else {
      report(`Could not start ${command}: ${result.error.message}`);
    }
    return 1;
  }

  return 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runWindowsHelperBuild(process.argv.slice(2));
}
