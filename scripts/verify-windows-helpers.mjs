import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powerShellControllerRelativePath = 'native/windows/termhelm-controller.ps1';

function packagedPath(packageFiles, expected) {
  return packageFiles.some(entry => {
    const normalized = String(entry).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized.length > 0 && (normalized === expected || expected.startsWith(`${normalized}/`));
  });
}

async function validatePowerShellController() {
  const controllerPath = join(repositoryRoot, ...powerShellControllerRelativePath.split('/'));
  let stats;
  try {
    stats = await lstat(controllerPath);
  } catch {
    throw new Error(`Missing Windows PowerShell controller: ${powerShellControllerRelativePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 256) {
    throw new Error(`Invalid Windows PowerShell controller: ${powerShellControllerRelativePath}`);
  }
  const source = await readFile(controllerPath, 'utf8');
  const requiredSourceFragments = [
    '[switch] $SelfTest',
    '[string] $PayloadPath',
    'ConvertFrom-Json -ErrorAction Stop',
    '[IO.File]::Delete($payloadFullPath)',
    '$expectedSessionId = $payloadIdentity.Substring',
    'Controller payload identity does not match its filename.',
    '[StringComparison]::Ordinal',
    '$runEntered = $true',
    'Write-PreLaunchFailureMarker $payload $payloadDirectory $expectedSessionId $expectedTargetId',
    '[TerminalWindows.PowerShellController]::Run(',
    'EntryPoint = "SetEnvironmentVariableW"',
    'ExactSpelling = true',
    'CreateJobObject'
  ];
  if (requiredSourceFragments.some(fragment => !source.includes(fragment))) {
    throw new Error(`Invalid Windows PowerShell controller: ${powerShellControllerRelativePath}`);
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  const errors = [];

  if (!packagedPath(packageFiles, powerShellControllerRelativePath)) {
    errors.push(`package.json files does not include ${powerShellControllerRelativePath}.`);
  } else {
    try {
      await validatePowerShellController();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`termhelm package validation: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Validated Windows PowerShell controller: ${powerShellControllerRelativePath}`);
}

main().catch(error => {
  console.error(`termhelm package validation: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
