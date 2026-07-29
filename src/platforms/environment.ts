import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const TEMPORARY_DIRECTORY_NAMES = new Set(['TMPDIR', 'TMP', 'TEMP']);

export function usableTemporaryDirectory(path: string, cwd: string): string | null {
  if (path.length === 0 || path.includes('\0')) return null;
  const candidate = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  try {
    if (!statSync(candidate).isDirectory()) return null;
    accessSync(candidate, fsConstants.W_OK | fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

export function sanitizeInheritedTemporaryDirectories(
  inherited: NodeJS.ProcessEnv,
  explicit: Readonly<Record<string, string>> | undefined,
  cwd: string,
  caseInsensitive = false
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  const explicitNames = new Set(
    Object.keys(explicit ?? {}).map(name => caseInsensitive ? name.toUpperCase() : name)
  );
  for (const [name, value] of Object.entries(environment)) {
    const comparedName = caseInsensitive ? name.toUpperCase() : name;
    if (!TEMPORARY_DIRECTORY_NAMES.has(comparedName) || explicitNames.has(comparedName)) continue;
    const usable = value === undefined ? null : usableTemporaryDirectory(value, cwd);
    if (usable === null) delete environment[name];
    else environment[name] = usable;
  }
  return environment;
}
