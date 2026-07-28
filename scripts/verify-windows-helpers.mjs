import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helperName = 'terminal-windows-controller.exe';
const powerShellControllerRelativePath = 'native/windows/terminal-windows-controller.ps1';
const supportedArchitectures = ['x64', 'arm64'];
const expectedPeMachine = { x64: 0x8664, arm64: 0xaa64 };

function requestedArchitectures(args) {
  const architectureIndex = args.indexOf('--architecture');
  const equalsArgument = args.find(argument => argument.startsWith('--architecture='));
  const architecture = architectureIndex === -1
    ? equalsArgument?.slice('--architecture='.length)
    : args[architectureIndex + 1];

  if (architecture === undefined) return supportedArchitectures;
  if (!supportedArchitectures.includes(architecture)) {
    throw new Error(`Unsupported Windows helper architecture: ${architecture}`);
  }
  return [architecture];
}

function packagedPath(packageFiles, expected) {
  return packageFiles.some(entry => {
    const normalized = String(entry).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized.length > 0 && (normalized === expected || expected.startsWith(`${normalized}/`));
  });
}

async function validateHelper(architecture) {
  const helperPath = join(repositoryRoot, 'native', `win32-${architecture}`, helperName);
  let stats;
  try {
    stats = await lstat(helperPath);
  } catch {
    throw new Error(`Missing ${architecture} Windows controller helper: ${relative(repositoryRoot, helperPath)}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 64) {
    throw new Error(`Invalid ${architecture} Windows controller helper: ${relative(repositoryRoot, helperPath)}`);
  }

  const handle = await open(helperPath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.subarray(0, 2).toString('ascii') !== 'MZ') {
      throw new Error(`Invalid PE signature for ${architecture} Windows controller helper: ${relative(repositoryRoot, helperPath)}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset > stats.size - 6) {
      throw new Error(`Invalid PE header offset for ${architecture} Windows controller helper: ${relative(repositoryRoot, helperPath)}`);
    }
    const peHeader = Buffer.alloc(6);
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
    if (peRead.bytesRead !== peHeader.length || !peHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
      throw new Error(`Invalid PE header for ${architecture} Windows controller helper: ${relative(repositoryRoot, helperPath)}`);
    }
    const actualMachine = peHeader.readUInt16LE(4);
    if (actualMachine !== expectedPeMachine[architecture]) {
      throw new Error(
        `Wrong PE architecture for ${architecture} Windows controller helper: ` +
        `expected 0x${expectedPeMachine[architecture].toString(16)}, found 0x${actualMachine.toString(16)}`
      );
    }
  } finally {
    await handle.close();
  }
}

async function validatePowerShellController() {
  const controllerPath = join(repositoryRoot, ...powerShellControllerRelativePath.split('/'));
  let stats;
  try {
    stats = await lstat(controllerPath);
  } catch {
    throw new Error(`Missing Windows PowerShell fallback controller: ${powerShellControllerRelativePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 256) {
    throw new Error(`Invalid Windows PowerShell fallback controller: ${powerShellControllerRelativePath}`);
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
    throw new Error(`Invalid Windows PowerShell fallback controller: ${powerShellControllerRelativePath}`);
  }
}

async function main() {
  const architectures = requestedArchitectures(process.argv.slice(2));
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

  for (const architecture of architectures) {
    if (!packagedPath(packageFiles, `native/win32-${architecture}`)) {
      errors.push(`package.json files does not include native/win32-${architecture}.`);
      continue;
    }
    try {
      await validateHelper(architecture);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`terminal-windows package validation: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Validated Windows controller helpers: ${architectures.join(', ')} plus PowerShell fallback`);
}

main().catch(error => {
  console.error(`terminal-windows package validation: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
