import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateManagedTerminalLabel, validateManagedTerminalLaunchOptions } from './config.js';
import type { ManagedTerminalLabelScope, ManagedTerminalLaunchOptions, ResolvedTerminalTarget } from './types.js';

export type CliMode = 'launch' | 'managed';

export interface CliRequest {
  mode?: CliMode;
  help: boolean;
  configPath?: string;
  target?: ResolvedTerminalTarget;
  managedOptions?: ManagedTerminalLaunchOptions;
}

export function helpText(): string {
  return `terminal-windows

Usage:
  terminal-windows launch --config <path>
  terminal-windows managed --config <path>
  terminal-windows launch --title <title> [--cwd <cwd>] --command <command>
  terminal-windows managed --label <label> --title <title> [--cwd <cwd>] --command <command>

Options:
  --config <path>              Read targets and options from a JSON config file.
  --title <title>              Display title for a single inline target.
  --cwd <cwd>                  Working directory for a single inline target. Defaults to the current working directory.
  --command <command>          Command for a single inline target.
  --env KEY=VALUE              Environment variable for a single inline target. Repeatable.
  --exit-message <text>        Message printed after the command exits.
  --label <label>              Required identity for an inline managed launch.
  --label-scope user|project   Scope the managed label. Defaults to user.
  --project-root <path>        Existing project root. Defaults to the resolved --cwd for project scope.
  --help                       Show this help text.

Managed config files must provide options.label. Managed identity flags apply
only to inline mode; put them in the config options object when using --config.
`;
}

type CliValues = Record<string, string | string[] | boolean | undefined>;

function resolveInlineCwd(value: CliValues['cwd']): string {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error('--cwd must be a non-empty path when provided.');
  }
  if (typeof value === 'string' && value.includes('\0')) {
    throw new Error('--cwd must not contain NUL.');
  }

  const displayValue = value === undefined ? 'the current working directory' : value;
  try {
    const cwd = realpathSync(resolve(value ?? process.cwd()));
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
    return cwd;
  } catch {
    throw new Error(`--cwd must resolve to an existing directory: ${displayValue}`);
  }
}

function inlineTarget(values: CliValues): ResolvedTerminalTarget | undefined {
  if (values.title === undefined && values.cwd === undefined && values.command === undefined) return undefined;
  if (typeof values.title !== 'string' || typeof values.command !== 'string') {
    throw new Error('Inline mode requires --title and --command.');
  }

  const envValues = Array.isArray(values.env) ? values.env : values.env ? [String(values.env)] : [];
  const env: Record<string, string> = {};
  for (const entry of envValues) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid --env value: ${entry}. Expected KEY=VALUE.`);
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  return {
    title: values.title,
    cwd: resolveInlineCwd(values.cwd),
    command: values.command,
    env: Object.keys(env).length > 0 ? env : undefined,
    exitMessage: typeof values['exit-message'] === 'string' ? values['exit-message'] : undefined
  };
}

function hasManagedIdentityFlags(values: CliValues): boolean {
  return values.label !== undefined || values['label-scope'] !== undefined || values['project-root'] !== undefined;
}

function inlineManagedOptions(
  values: CliValues,
  label: string,
  cwd: string
): ManagedTerminalLaunchOptions {
  const scopeValue = values['label-scope'];
  const projectRoot = values['project-root'];
  if (scopeValue !== undefined && scopeValue !== 'user' && scopeValue !== 'project') {
    throw new Error('--label-scope must be user or project.');
  }

  let labelScope: ManagedTerminalLabelScope | undefined;
  if (scopeValue === 'project') {
    if (projectRoot !== undefined && (typeof projectRoot !== 'string' || projectRoot.trim().length === 0)) {
      throw new Error('--project-root must be a non-empty path when provided.');
    }
    labelScope = { type: 'project', root: typeof projectRoot === 'string' ? projectRoot : cwd };
  } else {
    if (projectRoot !== undefined) throw new Error('--project-root is only valid when --label-scope is project.');
    if (scopeValue === 'user') labelScope = { type: 'user' };
  }

  return validateManagedTerminalLaunchOptions({ label, labelScope });
}

export function parseTerminalWindowsCliArgs(args: string[]): CliRequest {
  const [mode] = args;
  if (!mode || mode === '--help' || mode === '-h') return { help: true };
  if (mode !== 'launch' && mode !== 'managed') throw new Error(`Unknown command: ${mode}`);

  const parsed = parseArgs({
    args: args.slice(1),
    options: {
      config: { type: 'string' },
      title: { type: 'string' },
      cwd: { type: 'string' },
      command: { type: 'string' },
      env: { type: 'string', multiple: true },
      'exit-message': { type: 'string' },
      label: { type: 'string' },
      'label-scope': { type: 'string' },
      'project-root': { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });

  if (parsed.values.help) return { mode, help: true };

  const values = parsed.values as CliValues;
  const configPath = values.config;
  const hasInlineTargetFlags = values.title !== undefined || values.cwd !== undefined || values.command !== undefined;
  const hasIdentityFlags = hasManagedIdentityFlags(values);

  if (mode === 'launch' && hasIdentityFlags) {
    throw new Error('--label, --label-scope, and --project-root are only valid for managed mode.');
  }
  if (typeof configPath === 'string' && hasIdentityFlags) {
    throw new Error('Managed identity flags cannot be combined with --config; define them in config options.');
  }
  if (typeof configPath === 'string' && hasInlineTargetFlags) {
    throw new Error('Use either --config or inline target flags, not both.');
  }
  if (typeof configPath === 'string') return { mode, help: false, configPath };
  if (hasInlineTargetFlags) {
    // Match the library boundary: a managed inline label is validated before
    // any remaining option, target, filesystem, or launch work.
    const label = mode === 'managed' ? validateManagedTerminalLabel(values.label) : undefined;
    const target = inlineTarget(values)!;
    const managedOptions = label === undefined
      ? undefined
      : inlineManagedOptions(values, label, target.cwd);
    return managedOptions
      ? { mode, help: false, target, managedOptions }
      : { mode, help: false, target };
  }

  throw new Error('Missing --config or inline target flags.');
}
