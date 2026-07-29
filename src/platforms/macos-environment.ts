import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { usableTemporaryDirectory } from './environment.js';

let cachedDarwinUserTemporaryDirectory: string | undefined;

function privateDarwinTemporaryDirectory(path: string): string | null {
  const usable = usableTemporaryDirectory(path, '/');
  if (usable === null) return null;
  try {
    const canonical = realpathSync(usable);
    const stats = statSync(canonical);
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return null;
    return (stats.mode & 0o077) === 0 ? canonical : null;
  } catch {
    return null;
  }
}

export function resolvePrivateDarwinTemporaryDirectory(
  configuredDirectory: () => string = () => {
    const environment = { ...process.env };
    delete environment.TMPDIR;
    delete environment.TMP;
    delete environment.TEMP;
    return execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
      encoding: 'utf8',
      env: environment
    }).trim();
  }
): string {
  let configured: string;
  try {
    configured = configuredDirectory();
  } catch (error) {
    throw new Error('Cannot resolve the private Darwin user temporary directory.', { cause: error });
  }
  const privateDirectory = privateDarwinTemporaryDirectory(configured);
  if (privateDirectory === null) {
    throw new Error('The Darwin user temporary directory is unavailable or not private.');
  }
  return privateDirectory;
}

function darwinUserTemporaryDirectory(): string {
  if (process.platform !== 'darwin') return realpathSync(tmpdir());
  if (cachedDarwinUserTemporaryDirectory !== undefined) {
    const privateDirectory = privateDarwinTemporaryDirectory(cachedDarwinUserTemporaryDirectory);
    if (privateDirectory !== null) return privateDirectory;
    cachedDarwinUserTemporaryDirectory = undefined;
  }
  const resolved = resolvePrivateDarwinTemporaryDirectory();
  cachedDarwinUserTemporaryDirectory = resolved;
  return resolved;
}

export function macAutomationEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: darwinUserTemporaryDirectory()
  };
  delete environment.TMP;
  delete environment.TEMP;
  return environment;
}

export function macInheritedTargetEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(macAutomationEnvironment()).filter((entry): entry is [string, string] => {
      const [name, value] = entry;
      if (value === undefined) return false;
      // Terminal.app owns terminal identity and shell bookkeeping. The caller
      // snapshot supplies runtime/tool configuration without replacing these.
      return !/^(?:TERM(?:$|_)|COLORTERM$|COLORFGBG$|TTY$|PWD$|OLDPWD$|SHLVL$|_$)/.test(name);
    })
  );
}
