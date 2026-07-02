import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TerminalTarget, TerminalWindowsConfig } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEnv(value: unknown, context: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${context}.env must be an object.`);
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${context}.env.${key} must be a string.`);
    env[key] = item;
  }
  return env;
}

export function validateTerminalTarget(value: unknown, context = 'target'): TerminalTarget {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  if (typeof value.title !== 'string' || value.title.length === 0) throw new Error(`${context}.title must be a non-empty string.`);
  if (typeof value.cwd !== 'string' || value.cwd.length === 0) throw new Error(`${context}.cwd must be a non-empty string.`);
  if (typeof value.command !== 'string' || value.command.length === 0) throw new Error(`${context}.command must be a non-empty string.`);
  if (value.exitMessage !== undefined && typeof value.exitMessage !== 'string') throw new Error(`${context}.exitMessage must be a string.`);
  return { title: value.title, cwd: resolve(value.cwd), command: value.command, env: validateEnv(value.env, context), exitMessage: value.exitMessage };
}

export function validateTerminalWindowsConfig(value: unknown): TerminalWindowsConfig {
  if (!isRecord(value)) throw new Error('Config must be an object.');
  if (!Array.isArray(value.targets) || value.targets.length === 0) throw new Error('Config must include a non-empty targets array.');
  if (value.options !== undefined && !isRecord(value.options)) throw new Error('Config options must be an object.');
  return { targets: value.targets.map((target, index) => validateTerminalTarget(target, `targets[${index}]`)), options: value.options };
}

export function readTerminalWindowsConfig(path: string): TerminalWindowsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON config ${path}: ${message}`);
  }
  return validateTerminalWindowsConfig(parsed);
}
