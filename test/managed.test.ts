import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedTerminalLaunchOptions, TerminalTarget } from '../src/types.js';

const managerFunctions = vi.hoisted(() => ({
  assertManagedLaunchIntentIsLatest: vi.fn(),
  createManagedLaunchGeneration: vi.fn(),
  createManagedSessionRecord: vi.fn(),
  ensureManagedSessionDirectory: vi.fn(),
  inspectLegacySupervisorRecord: vi.fn(),
  managedTargetMarkerPath: vi.fn(),
  readManagedSessionRecord: vi.fn(),
  readManagedTargetMarker: vi.fn(),
  removeInactiveLegacySupervisorRecord: vi.fn(),
  removeManagedLaunchIntent: vi.fn(),
  removeManagedSessionDirectory: vi.fn(),
  removeManagedSessionRecordIfOwned: vi.fn(),
  removeSupersededManagedLaunchIntents: vi.fn(),
  registerManagedLaunchIntent: vi.fn(),
  resolveManagedLabelIdentity: vi.fn(),
  withManagedLabelLocks: vi.fn(),
  writeManagedSessionRecord: vi.fn(),
  writeManagedTargetMarker: vi.fn()
}));

vi.mock('../src/manager.js', () => managerFunctions);

import { startManagedTerminalWindows } from '../src/managed.js';

const validTarget: TerminalTarget = {
  title: 'api',
  cwd: '.',
  command: 'node server.js'
};

function expectNoManagerSideEffects(): void {
  for (const managerFunction of Object.values(managerFunctions)) {
    expect(managerFunction).not.toHaveBeenCalled();
  }
}

describe('managed session input boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a missing label before invoking any registry or filesystem primitive', () => {
    expect(() => startManagedTerminalWindows(
      [validTarget],
      undefined as unknown as ManagedTerminalLaunchOptions
    )).toThrow('Managed terminal options.label must be a non-empty label without surrounding whitespace.');
    expectNoManagerSideEffects();
  });

  it('rejects an invalid label before reading the remaining options', () => {
    let labelScopeRead = false;
    const options = {
      label: ' invalid',
      get labelScope() {
        labelScopeRead = true;
        throw new Error('label scope must not be read');
      }
    } as ManagedTerminalLaunchOptions;

    expect(() => startManagedTerminalWindows([validTarget], options)).toThrow(
      'Managed terminal options.label must be a non-empty label without surrounding whitespace.'
    );
    expect(labelScopeRead).toBe(false);
    expectNoManagerSideEffects();
  });

  it('validates every target before constructing registry state', () => {
    expect(() => startManagedTerminalWindows(
      [{ title: 'api', cwd: '.', command: '' }],
      { label: 'dev' }
    )).toThrow('targets[0].command must be a non-empty string.');
    expectNoManagerSideEffects();
  });

  it('rejects non-portable environment metadata before constructing registry state', () => {
    expect(() => startManagedTerminalWindows(
      [{ ...validTarget, env: { 'BAD;NAME': 'value' } }],
      { label: 'dev' }
    )).toThrow('invalid portable environment variable name');
    expectNoManagerSideEffects();
  });
});
