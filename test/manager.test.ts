import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertManagedLaunchIntentIsLatest,
  createManagedLaunchGeneration,
  createManagedSessionRecord,
  ensureManagedTerminalRuntimeDirectory,
  inspectLegacySupervisorRecord,
  managedSessionRecordPath,
  managedTargetMarkerPath,
  managedTerminalRuntimeDirectory,
  readManagedTargetMarker,
  readManagedLaunchIntents,
  readManagedSessionRecord,
  removeInactiveLegacySupervisorRecord,
  removeManagedSessionRecordIfOwned,
  removeManagedLaunchIntent,
  removeSupersededManagedLaunchIntents,
  registerManagedLaunchIntent,
  resolveManagedLabelIdentity,
  withManagedLabelLocks,
  writeManagedSessionRecord,
  writeManagedTargetMarker,
  type ManagedManagerStorageOptions
} from '../src/manager.js';

describe('managed terminal registry', () => {
  let sandbox: string;
  let storage: ManagedManagerStorageOptions;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'termhelm-manager-test-'));
    storage = {
      runtimeDirectory: join(sandbox, 'runtime'),
      legacyRegistryDirectory: join(sandbox, 'legacy'),
      lockPollIntervalMs: 5
    };
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('requires a non-empty label without surrounding whitespace', () => {
    const expected = 'Managed terminal options.label must be a non-empty label without surrounding whitespace.';
    expect(() => resolveManagedLabelIdentity(undefined)).toThrow(expected);
    expect(() => resolveManagedLabelIdentity('')).toThrow(expected);
    expect(() => resolveManagedLabelIdentity(' dev')).toThrow(expected);
    expect(() => resolveManagedLabelIdentity('dev ')).toThrow(expected);
  });

  it('normalizes Unicode, preserves case, and avoids lossy label collisions', () => {
    const composed = resolveManagedLabelIdentity('\u00e9');
    const decomposed = resolveManagedLabelIdentity('e\u0301');
    expect(decomposed).toEqual(composed);
    expect(resolveManagedLabelIdentity('Dev').key).not.toBe(resolveManagedLabelIdentity('dev').key);
    expect(resolveManagedLabelIdentity('api/dev').key).not.toBe(resolveManagedLabelIdentity('api?dev').key);
  });

  it('separates user and canonical project scopes', () => {
    const project = join(sandbox, 'project');
    mkdirSync(project);
    const user = resolveManagedLabelIdentity('dev');
    const scoped = resolveManagedLabelIdentity('dev', { type: 'project', root: './project' }, sandbox);
    const absolute = resolveManagedLabelIdentity('dev', { type: 'project', root: project });
    expect(scoped).toEqual(absolute);
    expect(scoped.key).not.toBe(user.key);
    expect(scoped.scope).toEqual({ type: 'project', root: realpathSync.native(project) });
  });

  it('creates private runtime directories and hash-only registry paths', () => {
    const defaultRoot = managedTerminalRuntimeDirectory();
    expect(dirname(defaultRoot)).toBe(resolve(typeof process.getuid === 'function' ? '/tmp' : tmpdir()));

    const root = ensureManagedTerminalRuntimeDirectory(storage);
    expect(root).toBe(managedTerminalRuntimeDirectory(storage));
    if (process.platform !== 'win32') expect(statSync(root).mode & 0o777).toBe(0o700);
    const identity = resolveManagedLabelIdentity('../../do-not-use-as-a-path');
    const path = managedSessionRecordPath(identity, storage);
    expect(path).toMatch(/[0-9a-f]{64}\.json$/);
    expect(path).not.toContain(identity.label);
    expect(() => ensureManagedTerminalRuntimeDirectory({ runtimeDirectory: '/' })).toThrow('must not be a filesystem root');
  });

  it.skipIf(process.platform !== 'win32')('enforces owner/SYSTEM-only Windows runtime ACLs', () => {
    const root = ensureManagedTerminalRuntimeDirectory(storage);
    const identity = resolveManagedLabelIdentity('windows-acl');
    const record = createManagedSessionRecord({
      identity,
      targetIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      storage
    });
    writeManagedSessionRecord(identity, record, storage);
    const paths = [root, join(root, 'records'), managedSessionRecordPath(identity, storage)];
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$paths = @([Environment]::GetEnvironmentVariable('TERMHELM_TEST_ACL_PATHS') | ConvertFrom-Json)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$system = 'S-1-5-18'
foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user) { throw "Owner mismatch: $path" }
  if ($path -eq $paths[0] -and -not $acl.AreAccessRulesProtected) { throw "Root ACL is not protected: $path" }
  $userFullControl = $false
  $systemFullControl = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw "Unexpected deny rule: $sid" }
    if ($sid -ne $user -and $sid -ne $system) { throw "Unexpected ACL principal: $sid" }
    $hasFullControl = (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
    if (-not $hasFullControl) { throw "Incomplete ACL rights: $sid" }
    if ($sid -eq $user) { $userFullControl = $true }
    if ($sid -eq $system) { $systemFullControl = $true }
  }
  if (-not $userFullControl -or -not $systemFullControl) { throw "Missing owner or SYSTEM ACL: $path" }
}
`;
    const powershell = join(
      process.env.SystemRoot!,
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    const result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, TERMHELM_TEST_ACL_PATHS: JSON.stringify(paths) }
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('fails closed for a pre-existing Windows runtime with inherited permissions', () => {
    mkdirSync(storage.runtimeDirectory!);
    expect(() => ensureManagedTerminalRuntimeDirectory(storage)).toThrow(
      'Could not establish a private DACL for the managed terminal Windows runtime.'
    );
    expect(readdirSync(storage.runtimeDirectory!)).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('revalidates a Windows runtime after in-place DACL broadening', () => {
    const root = ensureManagedTerminalRuntimeDirectory(storage);
    const powershell = join(
      process.env.SystemRoot!,
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('TERMHELM_TEST_ACL_PATH')
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($false, $true)
Set-Acl -LiteralPath $path -AclObject $acl
`;
    const result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, TERMHELM_TEST_ACL_PATH: root }
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(() => ensureManagedTerminalRuntimeDirectory(storage)).toThrow(
      'Could not establish a private DACL for the managed terminal Windows runtime.'
    );
  });

  it.skipIf(process.platform !== 'win32')('revalidates a Windows runtime after path replacement', () => {
    const root = ensureManagedTerminalRuntimeDirectory(storage);
    rmSync(root, { recursive: true });
    mkdirSync(root);

    expect(() => ensureManagedTerminalRuntimeDirectory(storage)).toThrow(
      'Could not establish a private DACL for the managed terminal Windows runtime.'
    );
  });

  it.skipIf(process.platform !== 'win32')('rejects a junction replacing the protected Windows runtime', () => {
    const root = ensureManagedTerminalRuntimeDirectory(storage);
    const junctionTarget = join(sandbox, 'junction-target');
    rmSync(root, { recursive: true });
    mkdirSync(junctionTarget);
    symlinkSync(junctionTarget, root, 'junction');

    expect(() => ensureManagedTerminalRuntimeDirectory(storage)).toThrow(
      'Could not establish a private DACL for the managed terminal Windows runtime.'
    );
  });

  it('allocates immutable, runtime-global launch generations with exclusive tickets', () => {
    const first = createManagedLaunchGeneration(storage);
    const second = createManagedLaunchGeneration(storage);
    const third = createManagedLaunchGeneration(storage);

    expect([first, second, third]).toEqual([
      '00000000000000000001',
      '00000000000000000002',
      '00000000000000000003'
    ]);
    const tickets = join(managedTerminalRuntimeDirectory(storage), 'tickets');
    expect(readdirSync(tickets).sort()).toEqual([first, second, third]);
    for (const ticket of [first, second, third]) {
      expect(statSync(join(tickets, ticket)).isDirectory()).toBe(true);
      if (process.platform !== 'win32') expect(statSync(join(tickets, ticket)).mode & 0o777).toBe(0o700);
    }
  });

  it('continues after the highest immutable launch ticket without reusing gaps', () => {
    const root = ensureManagedTerminalRuntimeDirectory(storage);
    const tickets = join(root, 'tickets');
    mkdirSync(join(tickets, '00000000000000000003'), { mode: 0o700 });

    expect(createManagedLaunchGeneration(storage)).toBe('00000000000000000004');
    expect(readdirSync(tickets).sort()).toEqual([
      '00000000000000000003',
      '00000000000000000004'
    ]);
  });

  it('fails closed for malformed or tampered launch ticket entries', () => {
    const root = ensureManagedTerminalRuntimeDirectory(storage);
    const tickets = join(root, 'tickets');
    writeFileSync(join(tickets, 'not-a-ticket'), 'tampered');
    expect(() => createManagedLaunchGeneration(storage)).toThrow('Unsafe managed terminal launch ticket entry');
    expect(readdirSync(tickets)).toEqual(['not-a-ticket']);

    const wrongTypeStorage = { ...storage, runtimeDirectory: join(sandbox, 'wrong-type-runtime') };
    const wrongTypeTickets = join(ensureManagedTerminalRuntimeDirectory(wrongTypeStorage), 'tickets');
    writeFileSync(join(wrongTypeTickets, '00000000000000000001'), 'tampered');
    expect(() => createManagedLaunchGeneration(wrongTypeStorage)).toThrow('Unsafe managed terminal launch ticket');

    if (process.platform !== 'win32') {
      const unsafeModeStorage = { ...storage, runtimeDirectory: join(sandbox, 'unsafe-mode-runtime') };
      const unsafeModeTickets = join(ensureManagedTerminalRuntimeDirectory(unsafeModeStorage), 'tickets');
      const ticket = join(unsafeModeTickets, '00000000000000000001');
      mkdirSync(ticket, { mode: 0o700 });
      chmodSync(ticket, 0o755);
      expect(() => createManagedLaunchGeneration(unsafeModeStorage)).toThrow('launch ticket permissions are unsafe');
    }
  });

  it('writes and reads exact, versioned session records atomically with private permissions', () => {
    const identity = resolveManagedLabelIdentity('dev');
    const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const record = createManagedSessionRecord({
      identity,
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      targetIds: [targetId],
      diagnosticPid: process.pid,
      storage
    });
    writeManagedSessionRecord(identity, record, storage);

    expect(readManagedSessionRecord(identity, storage)).toEqual(record);
    const path = managedSessionRecordPath(identity, storage);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(managedTerminalRuntimeDirectory(storage), 'records'))).toEqual([`${identity.key}.json`]);
    expect(readdirSync(join(managedTerminalRuntimeDirectory(storage), 'tickets'))).toEqual([record.generation]);
  });

  it('fails closed for tampered identity metadata and unsafe file permissions', () => {
    const identity = resolveManagedLabelIdentity('dev');
    const record = createManagedSessionRecord({
      identity,
      targetIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      storage
    });
    writeManagedSessionRecord(identity, record, storage);
    const path = managedSessionRecordPath(identity, storage);
    const tampered = { ...JSON.parse(readFileSync(path, 'utf8')), label: 'other' };
    writeFileSync(path, JSON.stringify(tampered), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => readManagedSessionRecord(identity, storage)).toThrow('Unsafe managed terminal registry record');

    writeManagedSessionRecord(identity, record, storage);
    if (process.platform !== 'win32') {
      chmodSync(path, 0o644);
      expect(() => readManagedSessionRecord(identity, storage)).toThrow('permissions are unsafe');
    }
  });

  it('rejects session records whose scope metadata is not exact', () => {
    const targetIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
    const userIdentity = resolveManagedLabelIdentity('user-scope');
    const userRecord = createManagedSessionRecord({ identity: userIdentity, targetIds, storage });
    writeManagedSessionRecord(userIdentity, userRecord, storage);
    const userPath = managedSessionRecordPath(userIdentity, storage);

    for (const scope of [
      { type: 'user', root: sandbox },
      { type: 'user', unexpected: true }
    ]) {
      writeFileSync(userPath, JSON.stringify({ ...userRecord, scope }), { mode: 0o600 });
      chmodSync(userPath, 0o600);
      expect(() => readManagedSessionRecord(userIdentity, storage)).toThrow('record scope is invalid');
    }

    const projectRoot = join(sandbox, 'project');
    mkdirSync(projectRoot, { mode: 0o700 });
    const projectIdentity = resolveManagedLabelIdentity('project-scope', { type: 'project', root: projectRoot });
    const projectRecord = createManagedSessionRecord({ identity: projectIdentity, targetIds, storage });
    writeManagedSessionRecord(projectIdentity, projectRecord, storage);
    const projectPath = managedSessionRecordPath(projectIdentity, storage);
    writeFileSync(projectPath, JSON.stringify({
      ...projectRecord,
      scope: { ...projectRecord.scope, unexpected: true }
    }), { mode: 0o600 });
    chmodSync(projectPath, 0o600);
    expect(() => readManagedSessionRecord(projectIdentity, storage)).toThrow('record scope is invalid');
  });

  it('rejects empty target ownership in created and parsed records', () => {
    const identity = resolveManagedLabelIdentity('dev');
    expect(() => createManagedSessionRecord({ identity, targetIds: [], storage })).toThrow('at least one target');

    const record = createManagedSessionRecord({
      identity,
      targetIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      storage
    });
    writeManagedSessionRecord(identity, record, storage);
    const path = managedSessionRecordPath(identity, storage);
    const tampered = { ...JSON.parse(readFileSync(path, 'utf8')), targets: [] };
    writeFileSync(path, JSON.stringify(tampered), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => readManagedSessionRecord(identity, storage)).toThrow('at least one target');
  });

  it('never hides a foreign registry record while checking session ownership', () => {
    const identity = resolveManagedLabelIdentity('dev');
    const record = createManagedSessionRecord({
      identity,
      targetIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      storage
    });
    writeManagedSessionRecord(identity, record, storage);
    expect(removeManagedSessionRecordIfOwned(identity, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', storage)).toBe(false);
    expect(readManagedSessionRecord(identity, storage)).toEqual(record);
    expect(removeManagedSessionRecordIfOwned(identity, record.sessionId, storage)).toBe(true);
    expect(readManagedSessionRecord(identity, storage)).toBeNull();
  });

  it('retains the newest per-label intent as a durable fence against delayed contenders', () => {
    const identity = resolveManagedLabelIdentity('latest-wins');
    const first = registerManagedLaunchIntent(
      identity,
      '11111111-1111-4111-8111-111111111111',
      '00000000000000000001',
      storage
    );
    const latest = registerManagedLaunchIntent(
      identity,
      '22222222-2222-4222-8222-222222222222',
      '00000000000000000002',
      storage
    );

    expect(() => assertManagedLaunchIntentIsLatest(identity, first, storage)).toThrow('superseded');
    expect(() => removeSupersededManagedLaunchIntents(identity, first, storage)).toThrow('superseded');
    expect(() => assertManagedLaunchIntentIsLatest(identity, latest, storage)).not.toThrow();
    removeSupersededManagedLaunchIntents(identity, latest, storage);
    expect(readManagedLaunchIntents(identity, storage)).toEqual([latest]);
    expect(removeManagedLaunchIntent(identity, first, storage)).toBe(false);

    const delayed = registerManagedLaunchIntent(
      identity,
      '33333333-3333-4333-8333-333333333333',
      first.generation,
      storage
    );
    expect(() => assertManagedLaunchIntentIsLatest(identity, delayed, storage)).toThrow('superseded');
    expect(readManagedLaunchIntents(identity, storage)).toEqual([delayed, latest]);

    // This internal removal primitive is reserved for constructor rollback;
    // normal managed-session cleanup deliberately retains the winner.
    expect(removeManagedLaunchIntent(identity, delayed, storage)).toBe(true);
    expect(removeManagedLaunchIntent(identity, latest, storage)).toBe(true);
    expect(readManagedLaunchIntents(identity, storage)).toEqual([]);
  });

  it('uses target UUIDs rather than titles for recovery markers', () => {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const marker = writeManagedTargetMarker(sessionId, targetId, 'stopped', storage);
    const path = managedTargetMarkerPath(sessionId, targetId, 'stopped', storage);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(marker);
    expect(readManagedTargetMarker(sessionId, targetId, 'stopped', storage)).toEqual(marker);
    expect(readManagedTargetMarker(sessionId, targetId, 'ready', storage)).toBeNull();
    expect(path).not.toContain('title');
    expect(() => managedTargetMarkerPath('../escape', targetId, 'stopped', storage)).toThrow('Invalid managed terminal session ID');
  });

  it('fails closed for a malformed or mismatched existing target marker', () => {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    writeManagedTargetMarker(sessionId, targetId, 'ready', storage);
    const path = managedTargetMarkerPath(sessionId, targetId, 'ready', storage);
    writeFileSync(path, JSON.stringify({
      version: 2,
      sessionId,
      targetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      state: 'ready',
      updatedAt: new Date().toISOString()
    }), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => readManagedTargetMarker(sessionId, targetId, 'ready', storage)).toThrow('Unsafe managed terminal target marker');

    writeFileSync(path, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => readManagedTargetMarker(sessionId, targetId, 'ready', storage)).toThrow('registry file is too large');
  });

  it('rejects target markers reached through a symlinked session ancestor', () => {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const marker = writeManagedTargetMarker(sessionId, targetId, 'stopped', storage);
    const markerPath = managedTargetMarkerPath(sessionId, targetId, 'stopped', storage);
    const sessionPath = dirname(dirname(markerPath));
    const outsideSessionPath = join(sandbox, 'outside-session');
    const outsideTargetsPath = join(outsideSessionPath, 'targets');
    mkdirSync(outsideTargetsPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(outsideTargetsPath, `${targetId}.stopped.json`), JSON.stringify(marker), { mode: 0o600 });

    rmSync(sessionPath, { recursive: true, force: true });
    symlinkSync(outsideSessionPath, sessionPath, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => readManagedTargetMarker(sessionId, targetId, 'stopped', storage)).toThrow(
      'Unsafe managed terminal target marker'
    );
  });

  it('rejects target markers reached through a symlinked targets ancestor', () => {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const marker = writeManagedTargetMarker(sessionId, targetId, 'stopped', storage);
    const markerPath = managedTargetMarkerPath(sessionId, targetId, 'stopped', storage);
    const targetsPath = dirname(markerPath);
    const outsideTargetsPath = join(sandbox, 'outside-targets');
    mkdirSync(outsideTargetsPath, { mode: 0o700 });
    writeFileSync(join(outsideTargetsPath, `${targetId}.stopped.json`), JSON.stringify(marker), { mode: 0o600 });

    rmSync(targetsPath, { recursive: true, force: true });
    symlinkSync(outsideTargetsPath, targetsPath, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => readManagedTargetMarker(sessionId, targetId, 'stopped', storage)).toThrow(
      'Unsafe managed terminal target marker'
    );
  });

  it('serializes same-label contenders and releases locks after errors', async () => {
    const identity = resolveManagedLabelIdentity('dev');
    const events: string[] = [];
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const entered = new Promise<void>(resolvePromise => { enteredFirst = resolvePromise; });
    const gate = new Promise<void>(resolvePromise => { releaseFirst = resolvePromise; });

    const first = withManagedLabelLocks([identity], 500, async () => {
      events.push('first-start');
      enteredFirst();
      await gate;
      events.push('first-end');
    }, storage);
    await entered;
    const second = withManagedLabelLocks([identity], 500, () => {
      events.push('second');
    }, storage);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    expect(events).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);

    await expect(withManagedLabelLocks([identity], 100, async () => {
      await withManagedLabelLocks([identity], 20, () => undefined, storage);
    }, storage)).rejects.toThrow('Timed out while acquiring managed terminal lock');
    await expect(withManagedLabelLocks([identity], 100, () => 'released', storage)).resolves.toBe('released');
  });

  it('retries lock inspection across atomic release handoffs', async () => {
    const identity = resolveManagedLabelIdentity('handoff');
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        withManagedLabelLocks([identity], 2_000, () => index, storage)
      )
    );
    expect(results.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 24 }, (_, index) => index)
    );
  });

  it('deduplicates and orders multiple label locks without deadlocking', async () => {
    const first = resolveManagedLabelIdentity('first');
    const second = resolveManagedLabelIdentity('second');
    const results = await Promise.all([
      withManagedLabelLocks([first, second, first], 500, async () => {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
        return 1;
      }, storage),
      withManagedLabelLocks([second, first], 500, () => 2, storage)
    ]);
    expect(results.sort()).toEqual([1, 2]);
  });

  it('fails closed when existing lock ownership is ambiguous', async () => {
    const identity = resolveManagedLabelIdentity('dev');
    ensureManagedTerminalRuntimeDirectory(storage);
    const path = join(managedTerminalRuntimeDirectory(storage), 'locks', `${identity.key}.lock`);
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, 'owner.json'), '{"invalid":true}', { mode: 0o600 });
    await expect(withManagedLabelLocks([identity], 20, () => undefined, storage)).rejects.toThrow('ambiguous ownership');
  });

  it('never automatically reclaims a lock from its diagnostic PID', async () => {
    const identity = resolveManagedLabelIdentity('stale');
    ensureManagedTerminalRuntimeDirectory(storage);
    const path = join(managedTerminalRuntimeDirectory(storage), 'locks', `${identity.key}.lock`);
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, 'owner.json'), JSON.stringify({
      version: 2,
      lockId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pid: 2_147_483_647,
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    await expect(withManagedLabelLocks([identity], 100, () => 'acquired', storage)).rejects.toThrow(
      'Locks are never reclaimed automatically'
    );
  });

  it('requires manual migration for every extant legacy record and never removes one', () => {
    const legacyDirectory = storage.legacyRegistryDirectory!;
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    const inactivePath = join(legacyDirectory, 'old.json');
    writeFileSync(inactivePath, JSON.stringify({ label: 'old', pid: 2_147_483_647 }), { mode: 0o600 });
    expect(inspectLegacySupervisorRecord('old', storage)).toMatchObject({
      status: 'migration-required',
      label: 'old',
      reason: 'ambiguous'
    });
    expect(removeInactiveLegacySupervisorRecord('old', storage)).toBe(false);
    expect(inspectLegacySupervisorRecord('old', storage)).toMatchObject({ status: 'migration-required' });

    writeFileSync(join(legacyDirectory, 'active.json'), JSON.stringify({ label: 'active', pid: process.pid }), { mode: 0o600 });
    expect(inspectLegacySupervisorRecord('active', storage)).toMatchObject({ status: 'migration-required', reason: 'ambiguous' });
    expect(removeInactiveLegacySupervisorRecord('active', storage)).toBe(false);

    writeFileSync(join(legacyDirectory, 'api_dev.json'), JSON.stringify({ label: 'api?dev', pid: 2_147_483_647 }), { mode: 0o600 });
    expect(inspectLegacySupervisorRecord('api/dev', storage)).toMatchObject({ status: 'migration-required', reason: 'ambiguous' });
  });

  it('detects canonically equivalent legacy labels even when their lossy filenames differ', () => {
    const legacyDirectory = storage.legacyRegistryDirectory!;
    mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
    const decomposedLabel = 'de\u0301v';
    const composedLabel = decomposedLabel.normalize('NFC');
    const legacyFileName = `${decomposedLabel.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`;
    const normalizedFileName = `${composedLabel.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`;
    expect(legacyFileName).not.toBe(normalizedFileName);
    writeFileSync(join(legacyDirectory, legacyFileName), JSON.stringify({
      label: decomposedLabel,
      pid: process.pid,
      shutdownTokenPath: join(sandbox, 'legacy.alive')
    }), { mode: 0o600 });

    expect(inspectLegacySupervisorRecord(composedLabel, storage)).toMatchObject({
      status: 'migration-required',
      label: composedLabel,
      reason: 'ambiguous'
    });
  });
});
