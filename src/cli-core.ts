import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateManagedTerminalLabel, validateManagedTerminalLaunchOptions } from './config.js';
import type { ManagedTerminalLabelScope, ManagedTerminalLaunchOptions, ResolvedTerminalTarget } from './types.js';

export type CliMode = 'launch' | 'kill';

export interface CliRequest {
  mode?: CliMode;
  help: boolean;
  configPath?: string;
  target?: ResolvedTerminalTarget;
  managedOptions?: ManagedTerminalLaunchOptions;
}

export function helpText(): string {
  return `termhelm

Usage:
  termhelm launch --config <path>
  termhelm launch [--label <label>] --title <title> [--cwd <cwd>] --command <command>
  termhelm kill --config <path>
  termhelm kill --label <label> [--label-scope user|project] [--project-root <path>]

Options:
  --config <path>              Read targets and options from a JSON config file.
  --title <title>              Display title for a single inline target.
  --cwd <cwd>                  Working directory for a single inline target. Defaults to the current working directory.
  --command <command>          Command for a single inline target.
  --env KEY=VALUE              Environment variable for a single inline target. Repeatable.
  --exit-message <text>        Message printed after the command exits.
  --label <label>              Enable managed launch behavior, or select the session to kill.
  --label-scope user|project   Scope the managed label. Defaults to user.
  --project-root <path>        Project root. Defaults to the resolved --cwd for launch, or current directory for kill.
  --help                       Show this help text.

A launch with a label is managed; a launch without one is plain. Config files
select managed behavior by defining options.label. Kill reads the same label and
scope from the config used to launch the session.
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
  if (
    values.title === undefined
    && values.cwd === undefined
    && values.command === undefined
    && values.env === undefined
    && values['exit-message'] === undefined
  ) return undefined;
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
  cwd?: string
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
    labelScope = {
      type: 'project',
      root: typeof projectRoot === 'string' ? projectRoot : (cwd ?? resolveInlineCwd(undefined))
    };
  } else {
    if (projectRoot !== undefined) throw new Error('--project-root is only valid when --label-scope is project.');
    if (scopeValue === 'user') labelScope = { type: 'user' };
  }

  return validateManagedTerminalLaunchOptions({ label, labelScope });
}

export function parseTerminalWindowsCliArgs(args: string[]): CliRequest {
  const [mode] = args;
  if (!mode || mode === '--help' || mode === '-h') return { help: true };
  if (mode !== 'launch' && mode !== 'kill') throw new Error(`Unknown command: ${mode}`);

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
  const hasInlineTargetFlags = values.title !== undefined
    || values.cwd !== undefined
    || values.command !== undefined
    || values.env !== undefined
    || values['exit-message'] !== undefined;
  const hasIdentityFlags = hasManagedIdentityFlags(values);

  if (typeof configPath === 'string' && (hasIdentityFlags || hasInlineTargetFlags)) {
    throw new Error('Use either --config or inline flags, not both; define labels and targets in the config file.');
  }
  if (typeof configPath === 'string') return { mode, help: false, configPath };

  if (mode === 'kill') {
    if (hasInlineTargetFlags) throw new Error('Kill accepts only managed label identity flags or --config.');
    const label = validateManagedTerminalLabel(values.label);
    const managedOptions = inlineManagedOptions(values, label);
    return { mode, help: false, managedOptions };
  }

  if (hasInlineTargetFlags) {
    // A label changes launch semantics, so validate it before target filesystem
    // access and never fall back to a plain launch when it is invalid.
    const label = hasIdentityFlags ? validateManagedTerminalLabel(values.label) : undefined;
    const target = inlineTarget(values)!;
    const managedOptions = label === undefined
      ? undefined
      : inlineManagedOptions(values, label, target.cwd);
    return managedOptions
      ? { mode, help: false, target, managedOptions }
      : { mode, help: false, target };
  }

  if (hasIdentityFlags) validateManagedTerminalLabel(values.label);
  throw new Error('Missing --config or inline target flags.');
}
