import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  ManagedTerminalLabelScope,
  ManagedTerminalLaunchOptions,
  ResolvedTerminalTarget,
  TerminalWindowsConfig,
  TerminalWindowsConfigOptions
} from './types.js';

export const MANAGED_TERMINAL_LABEL_ERROR =
  'Managed terminal options.label must be a non-empty label without surrounding whitespace.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLabel(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${context} must be a non-empty label without surrounding whitespace.`);
  }
  return value.normalize('NFC');
}

export function validateManagedTerminalLabel(value: unknown): string {
  try {
    return normalizeLabel(value, 'Managed terminal options.label');
  } catch {
    throw new Error(MANAGED_TERMINAL_LABEL_ERROR);
  }
}

function validateEnv(value: unknown, context: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${context}.env must be an object.`);
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${context}.env contains an invalid portable environment variable name: ${key}`);
    }
    if (typeof item !== 'string') throw new Error(`${context}.env.${key} must be a string.`);
    if (item.includes('\0')) throw new Error(`${context}.env.${key} must not contain NUL.`);
    env[key] = item;
  }
  return env;
}

const MAX_PORTABLE_TIMEOUT_MS = 0x7fff_ffff;

function validateNonNegativeNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_PORTABLE_TIMEOUT_MS
  ) {
    throw new Error(`${context} must be an integer from 0 through ${MAX_PORTABLE_TIMEOUT_MS}.`);
  }
  return value;
}

function validateLabelScope(value: unknown, baseDirectory: string): ManagedTerminalLabelScope {
  if (value === undefined) return { type: 'user' };
  if (!isRecord(value) || (value.type !== 'user' && value.type !== 'project')) {
    throw new Error("Managed terminal options.labelScope.type must be 'user' or 'project'.");
  }
  if (value.type === 'user') {
    if (value.root !== undefined) throw new Error('Managed terminal options.labelScope.root is only valid for project scope.');
    return { type: 'user' };
  }
  if (typeof value.root !== 'string' || value.root.length === 0) {
    throw new Error('Managed terminal options.labelScope.root is required for project scope.');
  }
  try {
    const root = realpathSync(resolve(baseDirectory, value.root));
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    return { type: 'project', root };
  } catch {
    throw new Error(`Managed terminal options.labelScope.root must resolve to an existing directory: ${value.root}`);
  }
}

function validateReplaceLabels(value: unknown, currentLabel?: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Managed terminal options.replaceLabels must be an array of labels.');

  const labels: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const label = normalizeLabel(value[index], `Managed terminal options.replaceLabels[${index}]`);
    if (label === currentLabel || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function validateConfigOptions(value: Record<string, unknown>, baseDirectory: string): TerminalWindowsConfigOptions {
  const label = value.label === undefined ? undefined : validateManagedTerminalLabel(value.label);
  const options: TerminalWindowsConfigOptions = {};

  // Managed-only fields are intentionally deferred when no label exists. This
  // lets plain configs remain label-free and ensures managed config mode reports
  // the required-label error before touching a project root.
  if (label !== undefined) {
    options.label = label;
    options.labelScope = validateLabelScope(value.labelScope, baseDirectory);

    const replaceLabels = validateReplaceLabels(value.replaceLabels, label);
    if (replaceLabels !== undefined) options.replaceLabels = replaceLabels;

    const shutdownDelayMs = validateNonNegativeNumber(value.shutdownDelayMs, 'Managed terminal options.shutdownDelayMs');
    if (shutdownDelayMs !== undefined) options.shutdownDelayMs = shutdownDelayMs;

    const closeWaitTimeoutMs = validateNonNegativeNumber(value.closeWaitTimeoutMs, 'Managed terminal options.closeWaitTimeoutMs');
    if (closeWaitTimeoutMs !== undefined) options.closeWaitTimeoutMs = closeWaitTimeoutMs;

    const replaceTimeoutMs = validateNonNegativeNumber(value.replaceTimeoutMs, 'Managed terminal options.replaceTimeoutMs');
    if (replaceTimeoutMs !== undefined) options.replaceTimeoutMs = replaceTimeoutMs;
  }

  if (value.exitAfterCommand !== undefined) {
    if (typeof value.exitAfterCommand !== 'boolean') throw new Error('Terminal options.exitAfterCommand must be a boolean.');
    options.exitAfterCommand = value.exitAfterCommand;
  }

  return options;
}

export function validateManagedTerminalLaunchOptions(
  value: unknown,
  baseDirectory = process.cwd()
): ManagedTerminalLaunchOptions {
  // Validate the required identity first. Callers can rely on this happening
  // before project-root filesystem access or any process/registry operation.
  const label = validateManagedTerminalLabel(isRecord(value) ? value.label : undefined);
  const options = validateConfigOptions(value as Record<string, unknown>, baseDirectory);
  return {
    ...options,
    label,
    labelScope: options.labelScope ?? { type: 'user' },
    replaceLabels: options.replaceLabels ?? []
  };
}

export function validateTerminalTarget(value: unknown, context = 'target'): ResolvedTerminalTarget {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  if (typeof value.title !== 'string' || value.title.length === 0) throw new Error(`${context}.title must be a non-empty string.`);
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.trim().length === 0)) {
    throw new Error(`${context}.cwd must be a non-empty path when provided.`);
  }
  if (typeof value.command !== 'string' || value.command.length === 0) throw new Error(`${context}.command must be a non-empty string.`);
  if (value.exitMessage !== undefined && typeof value.exitMessage !== 'string') throw new Error(`${context}.exitMessage must be a string.`);
  if (value.title.includes('\0')) throw new Error(`${context}.title must not contain NUL.`);
  if (typeof value.cwd === 'string' && value.cwd.includes('\0')) throw new Error(`${context}.cwd must not contain NUL.`);
  if (value.command.includes('\0')) throw new Error(`${context}.command must not contain NUL.`);
  if (value.exitMessage?.includes('\0')) throw new Error(`${context}.exitMessage must not contain NUL.`);

  const displayCwd = value.cwd === undefined ? 'the current working directory' : value.cwd;
  let cwd: string;
  try {
    cwd = realpathSync(resolve(value.cwd ?? process.cwd()));
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`${context}.cwd must resolve to an existing directory: ${displayCwd}`);
  }

  return { title: value.title, cwd, command: value.command, env: validateEnv(value.env, context), exitMessage: value.exitMessage };
}

export function validateTerminalWindowsConfig(value: unknown, baseDirectory = process.cwd()): TerminalWindowsConfig {
  if (!isRecord(value)) throw new Error('Config must be an object.');
  if (!Array.isArray(value.targets) || value.targets.length === 0) throw new Error('Config must include a non-empty targets array.');
  if (value.options !== undefined && !isRecord(value.options)) throw new Error('Config options must be an object.');
  return {
    targets: value.targets.map((target, index) => validateTerminalTarget(target, `targets[${index}]`)),
    options: value.options === undefined ? undefined : validateConfigOptions(value.options, baseDirectory)
  };
}

export function readTerminalWindowsConfig(path: string): TerminalWindowsConfig {
  const configPath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON config ${path}: ${message}`);
  }
  return validateTerminalWindowsConfig(parsed, dirname(configPath));
}
