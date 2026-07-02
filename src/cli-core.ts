import { parseArgs } from 'node:util';
import type { TerminalTarget } from './types.js';

export type CliMode = 'launch' | 'managed';

export interface CliRequest {
  mode?: CliMode;
  help: boolean;
  configPath?: string;
  target?: TerminalTarget;
}

export function helpText(): string {
  return `terminal-windows

Usage:
  terminal-windows launch --config <path>
  terminal-windows managed --config <path>
  terminal-windows launch --title <title> --cwd <cwd> --command <command>

Options:
  --config <path>         Read targets and options from a JSON config file.
  --title <title>         Title for a single inline target.
  --cwd <cwd>             Working directory for a single inline target.
  --command <command>     Command for a single inline target.
  --env KEY=VALUE         Environment variable for a single inline target. Repeatable.
  --exit-message <text>   Message printed after the command exits.
  --help                  Show this help text.
`;
}

function inlineTarget(values: Record<string, string | string[] | boolean | undefined>): TerminalTarget | undefined {
  if (!values.title && !values.cwd && !values.command) return undefined;
  if (typeof values.title !== 'string' || typeof values.cwd !== 'string' || typeof values.command !== 'string') {
    throw new Error('Inline mode requires --title, --cwd, and --command.');
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
    cwd: values.cwd,
    command: values.command,
    env: Object.keys(env).length > 0 ? env : undefined,
    exitMessage: typeof values['exit-message'] === 'string' ? values['exit-message'] : undefined
  };
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
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });

  if (parsed.values.help) return { mode, help: true };

  const configPath = parsed.values.config;
  const target = inlineTarget(parsed.values);

  if (typeof configPath === 'string' && target) throw new Error('Use either --config or inline target flags, not both.');
  if (typeof configPath === 'string') return { mode, help: false, configPath };
  if (target) return { mode, help: false, target };

  throw new Error('Missing --config or inline target flags.');
}
