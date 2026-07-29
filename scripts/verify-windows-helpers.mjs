import { spawnSync } from 'node:child_process';
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
    'foreach ($privatePath in @($commandFile, $exitMessageFile))',
    '$expectedSessionId = $payloadIdentity.Substring',
    'Controller payload identity does not match its filename.',
    'Controller command-file identity is invalid.',
    'Controller exit-message-file identity is invalid.',
    '[StringComparison]::Ordinal',
    '$runEntered = $true',
    'Write-PreLaunchFailureMarker $payload $payloadDirectory $expectedSessionId $expectedTargetId',
    '[TerminalWindows.PowerShellController]::Run(',
    'EntryPoint = "SetEnvironmentVariableW"',
    'ExactSpelling = true',
    'CreateJobObject',
    '" /d /q /v:off /c "'
  ];
  if (requiredSourceFragments.some(fragment => !source.includes(fragment))) {
    throw new Error(`Invalid Windows PowerShell controller: ${powerShellControllerRelativePath}`);
  }
  if (source.includes('/c call') || source.includes('paths containing percent signs are unsupported')) {
    throw new Error(`Obsolete Windows command-file transport remains in ${powerShellControllerRelativePath}`);
  }

  if (process.platform === 'win32') {
    const hosts = ['pwsh', 'powershell.exe'];
    let available = 0;
    for (const host of hosts) {
      const probe = spawnSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: 'ignore',
        windowsHide: true
      });
      if (probe.error || probe.status !== 0) continue;
      available += 1;
      const parse = spawnSync(host, [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-Command', '[void][ScriptBlock]::Create([IO.File]::ReadAllText($env:TERMHELM_CONTROLLER_PATH))'
      ], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, TERMHELM_CONTROLLER_PATH: controllerPath }
      });
      if (parse.error || parse.status !== 0) {
        throw new Error(`${host} could not parse the bundled Windows controller: ${parse.stderr || parse.error?.message}`);
      }
      const selfTest = spawnSync(host, [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        ...(host.toLowerCase().includes('powershell') ? ['-ExecutionPolicy', 'Bypass'] : []),
        '-File', controllerPath,
        '-SelfTest'
      ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      if (selfTest.error || selfTest.status !== 0) {
        throw new Error(`${host} failed the bundled Job Object/C# self-test: ${selfTest.stderr || selfTest.error?.message}`);
      }
    }
    if (available === 0) throw new Error('No PowerShell host is available for native Windows helper verification.');
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
