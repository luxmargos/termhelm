import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WINDOWS_PRIVATE_DIRECTORY_PATH_ENV = 'TERMHELM_PRIVATE_DIRECTORY_PATH';
const WINDOWS_PRIVATE_DIRECTORY_MODE_ENV = 'TERMHELM_PRIVATE_DIRECTORY_MODE';

const WINDOWS_PRIVATE_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$encodedPath = [Environment]::GetEnvironmentVariable('${WINDOWS_PRIVATE_DIRECTORY_PATH_ENV}')
$mode = [Environment]::GetEnvironmentVariable('${WINDOWS_PRIVATE_DIRECTORY_MODE_ENV}')
if ([String]::IsNullOrWhiteSpace($encodedPath)) { throw 'Missing private directory path.' }
if ($mode -ne 'protected' -and $mode -ne 'inherited') { throw 'Invalid private directory mode.' }
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow

function Assert-PrivateDirectory([string]$candidate, [bool]$requireProtected) {
  if (-not [IO.Directory]::Exists($candidate)) { throw "Private directory does not exist: $candidate" }
  $attributes = [IO.File]::GetAttributes($candidate)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Private directory is a reparse point: $candidate"
  }
  $actual = [IO.Directory]::GetAccessControl($candidate, [Security.AccessControl.AccessControlSections]'Access,Owner')
  if ($requireProtected -and -not $actual.AreAccessRulesProtected) {
    throw "Private directory ACL inheritance is enabled: $candidate"
  }
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) {
    throw "Private directory ACL owner mismatch: $candidate"
  }
  $userFullControl = $false
  $systemFullControl = $false
  foreach ($rule in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -ne $allow) { throw "Unexpected private directory deny rule: $sid" }
    if ($sid -ne $user.Value -and $sid -ne $system.Value) {
      throw "Unexpected private directory ACL principal: $sid"
    }
    $hasFullControl = (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
    $hasContainerInheritance = (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0)
    $hasObjectInheritance = (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0)
    if (-not $hasFullControl -or -not $hasContainerInheritance -or -not $hasObjectInheritance -or $rule.PropagationFlags -ne $propagation) {
      throw "Incomplete or non-inheritable private directory ACL rights: $sid"
    }
    if ($sid -eq $user.Value) { $userFullControl = $true }
    if ($sid -eq $system.Value) { $systemFullControl = $true }
  }
  if (-not $userFullControl -or -not $systemFullControl) {
    throw "Private directory ACL does not grant FullControl to the owner and SYSTEM: $candidate"
  }
}

if ([IO.Directory]::Exists($path)) {
  # Never repair a pre-existing path. Revalidate its current DACL on every call,
  # including in-place ACL changes that preserve filesystem identity.
  Assert-PrivateDirectory $path ($mode -eq 'protected')
} elseif ($mode -eq 'protected') {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($user)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user, 'FullControl', $inheritance, $propagation, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inheritance, $propagation, $allow)))
  [void][IO.Directory]::CreateDirectory($path, $acl)
  Assert-PrivateDirectory $path $true
} else {
  # The parent must already be protected. Creation inherits only its owner/SYSTEM
  # rules, and the immediate postcondition rejects any weaker or broader ACL.
  [void][IO.Directory]::CreateDirectory($path)
  Assert-PrivateDirectory $path $false
}
`;

export function privateWindowsDirectoryIdentity(path: string): string {
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe private Windows directory: ${path}`);
  }
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeNs)}`;
}

export interface PrivateWindowsDirectoryOptions {
  /** Protected roots are created atomically with inheritance disabled. */
  protectedRoot?: boolean;
  description?: string;
}

export function ensurePrivateWindowsDirectory(
  path: string,
  options: PrivateWindowsDirectoryOptions = {}
): string {
  const resolvedPath = resolve(path);
  if (process.platform !== 'win32') return resolvedPath;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    throw new Error(`Cannot secure ${options.description ?? 'the Windows directory'} because SystemRoot is unavailable.`);
  }
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand', Buffer.from(WINDOWS_PRIVATE_DIRECTORY_SCRIPT, 'utf16le').toString('base64')
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      [WINDOWS_PRIVATE_DIRECTORY_PATH_ENV]: Buffer.from(resolvedPath, 'utf8').toString('base64'),
      [WINDOWS_PRIVATE_DIRECTORY_MODE_ENV]: options.protectedRoot === false ? 'inherited' : 'protected'
    }
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit status ${String(result.status)}`;
    throw new Error(`Could not establish a private DACL for ${options.description ?? 'the Windows directory'}. ${detail}`);
  }
  return resolvedPath;
}

export function revalidatePrivateWindowsDirectory(
  path: string,
  expectedIdentity: string,
  options: PrivateWindowsDirectoryOptions = {}
): void {
  if (process.platform !== 'win32') return;
  ensurePrivateWindowsDirectory(path, options);
  if (privateWindowsDirectoryIdentity(path) !== expectedIdentity) {
    throw new Error(`Private Windows directory identity changed: ${path}`);
  }
}
