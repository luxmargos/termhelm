import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import {
  ensurePrivateWindowsDirectory,
  ensurePrivateWindowsDirectoryTree
} from './platforms/windows-security.js';

const REGISTRY_VERSION = 2 as const;
const MAX_REGISTRY_FILE_SIZE = 64 * 1024;
const LOCK_POLL_INTERVAL_MS = 25;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHENTICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const GENERATION_PATTERN = /^[0-9]{20,48}$/;
const GENERATION_TICKET_WIDTH = 20;
const LABEL_ERROR = 'Managed terminal options.label must be a non-empty label without surrounding whitespace.';
export type ManagedLabelScope =
  | { type: 'user' }
  | { type: 'project'; root: string };

export interface ManagedLabelIdentity {
  readonly label: string;
  readonly scope: ManagedLabelScope;
  readonly key: string;
}

export interface ManagedTargetRecordV2 {
  readonly version: typeof REGISTRY_VERSION;
  readonly id: string;
  readonly createdAt: string;
}

export interface ManagedSessionRecordV2 {
  readonly version: typeof REGISTRY_VERSION;
  readonly registryKey: string;
  readonly sessionId: string;
  readonly label: string;
  readonly scope: ManagedLabelScope;
  readonly controlEndpoint: string;
  readonly authenticationToken: string;
  readonly generation: string;
  readonly targets: ManagedTargetRecordV2[];
  /** Informational only. This value must never be used as authority to signal a process. */
  readonly diagnosticPid?: number;
  readonly createdAt: string;
}

export interface ManagedLaunchIntentV2 {
  readonly version: typeof REGISTRY_VERSION;
  readonly registryKey: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly createdAt: string;
}

export type ManagedTargetState = 'ready' | 'stopping' | 'stopped' | 'failed' | 'forced';

export interface ManagedTargetMarkerV2 {
  readonly version: typeof REGISTRY_VERSION;
  readonly sessionId: string;
  readonly targetId: string;
  readonly state: ManagedTargetState;
  readonly updatedAt: string;
}

export interface ManagedManagerStorageOptions {
  /** Intended for isolated embedding and tests. Normal callers should use the per-user default. */
  runtimeDirectory?: string;
  /** Intended only for migration tooling and tests. */
  legacyRegistryDirectory?: string;
  lockPollIntervalMs?: number;
}

export type LegacySupervisorRecordInspection =
  | { status: 'absent'; path: string }
  | { status: 'inactive'; path: string; label: string; diagnosticPid: number }
  | { status: 'migration-required'; path: string; label: string; reason: 'active' | 'ambiguous' };

interface LockOwnerRecord {
  version: typeof REGISTRY_VERSION;
  lockId: string;
  pid: number;
  createdAt: string;
}

function normalizeManagedLabel(label: unknown): string {
  if (typeof label !== 'string' || label.length === 0 || label.trim() !== label) throw new Error(LABEL_ERROR);
  return label.normalize('NFC');
}

function canonicalizeScope(scope: ManagedLabelScope | undefined, baseDirectory: string): ManagedLabelScope {
  if (scope === undefined) return { type: 'user' };
  if (typeof scope !== 'object' || scope === null) throw new Error('Managed terminal label scope is invalid.');
  if (scope.type === 'user') return { type: 'user' };
  if (scope.type !== 'project' || typeof scope.root !== 'string' || scope.root.length === 0) {
    throw new Error('Managed terminal project label scope requires a non-empty root.');
  }
  const candidate = resolve(baseDirectory, scope.root);
  try {
    const root = realpathSync.native(candidate);
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    return { type: 'project', root };
  } catch (error) {
    throw new Error(`Managed terminal project label scope root is not an existing directory: ${candidate}`, { cause: error });
  }
}

function identityKey(label: string, scope: ManagedLabelScope): string {
  const root = scope.type === 'project' ? scope.root : '';
  return createHash('sha256')
    .update(`termhelm\0v${REGISTRY_VERSION}\0${scope.type}\0${root}\0${label}`, 'utf8')
    .digest('hex');
}

export function resolveManagedLabelIdentity(
  label: unknown,
  scope?: ManagedLabelScope,
  baseDirectory = process.cwd()
): ManagedLabelIdentity {
  const normalizedLabel = normalizeManagedLabel(label);
  const canonicalScope = canonicalizeScope(scope, baseDirectory);
  return {
    label: normalizedLabel,
    scope: canonicalScope,
    key: identityKey(normalizedLabel, canonicalScope)
  };
}

function assertIdentity(identity: ManagedLabelIdentity): void {
  const expected = resolveManagedLabelIdentity(identity.label, identity.scope);
  if (identity.key !== expected.key || !scopesEqual(identity.scope, expected.scope)) {
    throw new Error('Managed terminal label identity is not canonical.');
  }
}

function scopesEqual(left: ManagedLabelScope, right: ManagedLabelScope): boolean {
  return left.type === right.type && (left.type === 'user' || (right.type === 'project' && left.root === right.root));
}

function defaultUserRuntimeDirectory(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('Cannot create private managed terminal state because LOCALAPPDATA is unavailable.');
    }
    return join(localAppData, 'TermHelm', `managed-v${REGISTRY_VERSION}`);
  }
  if (typeof process.getuid === 'function') {
    // Keep the user-owned directory directly below the root-owned sticky
    // temporary directory. No untrusted user can rename this entry.
    return join('/tmp', `termhelm-${process.getuid()}-v${REGISTRY_VERSION}`);
  }
  let userFingerprint: string;
  try {
    const info = userInfo();
    userFingerprint = `${info.username}\0${info.homedir}`;
  } catch {
    userFingerprint = tmpdir();
  }
  const userKey = createHash('sha256').update(userFingerprint, 'utf8').digest('hex').slice(0, 16);
  return join(tmpdir(), `termhelm-${userKey}-v${REGISTRY_VERSION}`);
}

export function managedTerminalRuntimeDirectory(options: ManagedManagerStorageOptions = {}): string {
  const path = resolve(options.runtimeDirectory ?? defaultUserRuntimeDirectory());
  if (path === parse(path).root) throw new Error('Managed terminal runtime directory must not be a filesystem root.');
  return path;
}

function assertContainedPath(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relation = relative(resolvedRoot, resolvedCandidate);
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`Managed terminal path escapes its runtime directory: ${resolvedCandidate}`);
  }
}

function verifyOwnedPath(path: string, kind: 'directory' | 'file'): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile())) {
    throw new Error(`Unsafe managed terminal ${kind}: ${path}`);
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`Managed terminal ${kind} is not owned by the current user: ${path}`);
  }
}

function verifyPrivateDirectory(path: string): void {
  verifyOwnedPath(path, 'directory');
  const stats = lstatSync(path);
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`Managed terminal directory permissions are unsafe: ${path}`);
  }
}

function ensureSecureDirectory(path: string): void {
  if (process.platform === 'win32') {
    ensurePrivateWindowsDirectory(path, {
      protectedRoot: false,
      description: 'the managed terminal runtime child directory'
    });
    verifyOwnedPath(path, 'directory');
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  verifyOwnedPath(path, 'directory');
  chmodSync(path, 0o700);
}

const MANAGED_RUNTIME_CHILD_NAMES = ['records', 'locks', 'sessions', 'sockets', 'intents', 'tickets'] as const;

/**
 * Derives a runtime child directory path WITHOUT a PowerShell ACL re-spawn.
 * The runtime tree is established and ACL-validated once at structured entry
 * points (e.g. ensureManagedTerminalRuntimeDirectory / ensureManagedSessionDirectory).
 * Leaf read/write helpers (records/locks/tickets/intents) only need the directory
 * to exist; creating a child of a validated protected root inherits its ACL.
 * Previously each of these calls re-ran a cold powershell.exe per access,
 * which on Windows consumed the entire managed launch replacement deadline
 * for multi-target sessions (assertLatestLaunchIntents alone spawned ~8 times).
 */
function ensureRuntimeChildDirectory(options: ManagedManagerStorageOptions, name: string): string {
  const root = managedTerminalRuntimeDirectory(options);
  const path = join(root, name);
  assertContainedPath(root, path);
  // Never create the protected root here with a recursive mkdir: an inherited
  // (non-protected) root would then fail its own ACL validation. The runtime
  // tree is established and ACL-validated by ensureManagedTerminalRuntimeDirectory
  // at structured entry points; this leaf helper only materializes the child
  // directory (inheriting the protected root's owner/SYSTEM-only ACL).
  if (!existsSync(root)) {
    ensureManagedTerminalRuntimeDirectory(options);
  }
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  return path;
}

export function ensureManagedTerminalRuntimeDirectory(options: ManagedManagerStorageOptions = {}): string {
  const root = managedTerminalRuntimeDirectory(options);
  if (process.platform === 'win32') {
    // Validate the protected root and every inherited child in a single
    // PowerShell process. A per-directory spawn here (one for the root plus
    // one per child) used to cost 7 cold PowerShell launches per call, which
    // alone consumed the whole managed launch replacement deadline. ACLs are
    // still revalidated on every call so in-place DACL broadening is detected.
    const children = MANAGED_RUNTIME_CHILD_NAMES.map(name => join(root, name));
    for (const path of children) assertContainedPath(root, path);
    ensurePrivateWindowsDirectoryTree(
      [{ path: root, mode: 'protected' }, ...children.map(path => ({ path, mode: 'inherited' as const }))],
      { protectedRoot: true, description: 'the managed terminal Windows runtime' }
    );
    verifyOwnedPath(root, 'directory');
    for (const path of children) verifyOwnedPath(path, 'directory');
    return root;
  }
  ensureSecureDirectory(root);
  for (const name of MANAGED_RUNTIME_CHILD_NAMES) {
    const path = join(root, name);
    assertContainedPath(root, path);
    ensureSecureDirectory(path);
  }
  return root;
}

function recordsDirectory(options: ManagedManagerStorageOptions): string {
  return ensureRuntimeChildDirectory(options, 'records');
}

function locksDirectory(options: ManagedManagerStorageOptions): string {
  return ensureRuntimeChildDirectory(options, 'locks');
}

function ticketsDirectory(options: ManagedManagerStorageOptions): string {
  return ensureRuntimeChildDirectory(options, 'tickets');
}

export function managedSessionRecordPath(
  identity: ManagedLabelIdentity,
  options: ManagedManagerStorageOptions = {}
): string {
  assertIdentity(identity);
  const root = managedTerminalRuntimeDirectory(options);
  const path = join(root, 'records', `${identity.key}.json`);
  assertContainedPath(root, path);
  return path;
}

function validateUuid(value: string, description: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`Invalid managed terminal ${description}: ${value}`);
  return value.toLowerCase();
}

function validateGeneration(value: string): string {
  if (!GENERATION_PATTERN.test(value)) throw new Error('Invalid managed terminal launch generation.');
  return value;
}

export function managedSessionDirectory(
  sessionId: string,
  options: ManagedManagerStorageOptions = {}
): string {
  const id = validateUuid(sessionId, 'session ID');
  const root = managedTerminalRuntimeDirectory(options);
  const path = join(root, 'sessions', id);
  assertContainedPath(root, path);
  return path;
}

export function ensureManagedSessionDirectory(
  sessionId: string,
  options: ManagedManagerStorageOptions = {}
): string {
  ensureManagedTerminalRuntimeDirectory(options);
  const path = managedSessionDirectory(sessionId, options);
  const targetsPath = join(path, 'targets');
  assertContainedPath(path, targetsPath);
  if (process.platform === 'win32') {
    // Validate the per-session directory and its `targets` child in a single
    // PowerShell process instead of one spawn per directory.
    ensurePrivateWindowsDirectoryTree(
      [{ path, mode: 'inherited' }, { path: targetsPath, mode: 'inherited' }],
      { protectedRoot: false, description: 'the managed terminal session directory' }
    );
    verifyOwnedPath(path, 'directory');
    verifyOwnedPath(targetsPath, 'directory');
  } else {
    ensureSecureDirectory(path);
    ensureSecureDirectory(targetsPath);
  }
  return path;
}

export function managedControlEndpoint(
  sessionId: string,
  options: ManagedManagerStorageOptions = {}
): string {
  const id = validateUuid(sessionId, 'session ID');
  const root = managedTerminalRuntimeDirectory(options);
  if (process.platform === 'win32') {
    const userKey = createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\termhelm-v${REGISTRY_VERSION}-${userKey}-${id}`;
  }
  const path = join(root, 'sockets', `${id}.sock`);
  assertContainedPath(root, path);
  return path;
}

export function createManagedTargetRecord(id: string = randomUUID()): ManagedTargetRecordV2 {
  return { version: REGISTRY_VERSION, id: validateUuid(id, 'target ID'), createdAt: new Date().toISOString() };
}

export function createManagedAuthenticationToken(): string {
  return randomBytes(32).toString('base64url');
}

function formatManagedLaunchTicket(value: bigint): string {
  const ticket = value.toString().padStart(GENERATION_TICKET_WIDTH, '0');
  if (!GENERATION_PATTERN.test(ticket)) {
    throw new Error('Managed terminal launch generation ticket namespace is exhausted.');
  }
  return ticket;
}

function inspectManagedLaunchTicket(directory: string, name: string): bigint {
  if (!GENERATION_PATTERN.test(name)) {
    throw new Error(`Unsafe managed terminal launch ticket entry: ${JSON.stringify(name)}.`);
  }
  const value = BigInt(name);
  if (value <= 0n || formatManagedLaunchTicket(value) !== name) {
    throw new Error(`Unsafe managed terminal launch ticket entry: ${JSON.stringify(name)}.`);
  }

  const path = join(directory, name);
  assertContainedPath(directory, path);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe managed terminal launch ticket: ${path}`);
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`Managed terminal launch ticket is not owned by the current user: ${path}`);
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`Managed terminal launch ticket permissions are unsafe: ${path}`);
  }
  return value;
}

function highestManagedLaunchTicket(directory: string): bigint {
  let highest = 0n;
  for (const name of readdirSync(directory)) {
    const value = inspectManagedLaunchTicket(directory, name);
    if (value > highest) highest = value;
  }
  return highest;
}

export function createManagedLaunchGeneration(options: ManagedManagerStorageOptions = {}): string {
  const directory = ticketsDirectory(options);
  let next = highestManagedLaunchTicket(directory) + 1n;

  for (;;) {
    const ticket = formatManagedLaunchTicket(next);
    const path = join(directory, ticket);
    assertContainedPath(directory, path);
    let created = false;
    try {
      // mkdir is the cross-process linearization point. Ticket directories are
      // immutable and deliberately never reclaimed, so generations cannot be
      // reused after a crash or a process restart.
      mkdirSync(path, { mode: 0o700 });
      created = true;
      inspectManagedLaunchTicket(directory, ticket);
      chmodSync(path, 0o700);
      return ticket;
    } catch (error) {
      if (created) throw error;
      if (!isPlainObject(error) || error.code !== 'EEXIST') throw error;
      inspectManagedLaunchTicket(directory, ticket);
      next += 1n;
    }
  }
}

export function createManagedSessionRecord(input: {
  identity: ManagedLabelIdentity;
  sessionId?: string;
  controlEndpoint?: string;
  authenticationToken?: string;
  generation?: string;
  targetIds?: readonly string[];
  diagnosticPid?: number;
  storage?: ManagedManagerStorageOptions;
}): ManagedSessionRecordV2 {
  assertIdentity(input.identity);
  const sessionId = validateUuid(input.sessionId ?? randomUUID(), 'session ID');
  const controlEndpoint = input.controlEndpoint ?? managedControlEndpoint(sessionId, input.storage);
  if (controlEndpoint !== managedControlEndpoint(sessionId, input.storage)) {
    throw new Error('Managed terminal control endpoint must be the session-scoped endpoint.');
  }
  const authenticationToken = input.authenticationToken ?? createManagedAuthenticationToken();
  if (!AUTHENTICATION_TOKEN_PATTERN.test(authenticationToken)) {
    throw new Error('Managed terminal authentication token must contain 32 to 256 URL-safe characters.');
  }
  if (input.diagnosticPid !== undefined && (!Number.isInteger(input.diagnosticPid) || input.diagnosticPid <= 0)) {
    throw new Error('Managed terminal diagnostic PID must be a positive integer.');
  }
  const generation = validateGeneration(input.generation ?? createManagedLaunchGeneration(input.storage));
  const targets = (input.targetIds ?? []).map(id => createManagedTargetRecord(id));
  if (targets.length === 0) {
    throw new Error('Managed terminal session records must contain at least one target.');
  }
  if (new Set(targets.map(target => target.id)).size !== targets.length) {
    throw new Error('Managed terminal target IDs must be unique.');
  }
  return {
    version: REGISTRY_VERSION,
    registryKey: input.identity.key,
    sessionId,
    label: input.identity.label,
    scope: input.identity.scope,
    controlEndpoint,
    authenticationToken,
    generation,
    targets,
    ...(input.diagnosticPid === undefined ? {} : { diagnosticPid: input.diagnosticPid }),
    createdAt: new Date().toISOString()
  };
}

function writeJsonAtomically(path: string, value: unknown, containmentRoot: string): void {
  assertContainedPath(containmentRoot, path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  assertContainedPath(containmentRoot, temporaryPath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function readSecureJson(path: string): unknown {
  verifyOwnedPath(path, 'file');
  const stats = statSync(path);
  if (stats.size > MAX_REGISTRY_FILE_SIZE) throw new Error(`Managed terminal registry file is too large: ${path}`);
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`Managed terminal registry file permissions are unsafe: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function intentsDirectory(options: ManagedManagerStorageOptions): string {
  return ensureRuntimeChildDirectory(options, 'intents');
}

function managedLaunchIntentPathInDirectory(
  directory: string,
  identity: ManagedLabelIdentity,
  sessionId: string
): string {
  assertIdentity(identity);
  const id = validateUuid(sessionId, 'session ID');
  const path = join(directory, `${identity.key}.${id}.json`);
  assertContainedPath(directory, path);
  return path;
}

function managedLaunchIntentPath(
  identity: ManagedLabelIdentity,
  sessionId: string,
  options: ManagedManagerStorageOptions
): string {
  return managedLaunchIntentPathInDirectory(intentsDirectory(options), identity, sessionId);
}

function parseManagedLaunchIntent(
  value: unknown,
  identity: ManagedLabelIdentity,
  expectedSessionId?: string
): ManagedLaunchIntentV2 {
  if (
    !isPlainObject(value) ||
    value.version !== REGISTRY_VERSION ||
    value.registryKey !== identity.key ||
    typeof value.sessionId !== 'string' ||
    typeof value.generation !== 'string' ||
    !isIsoDate(value.createdAt)
  ) {
    throw new Error('launch intent metadata is invalid');
  }
  const sessionId = validateUuid(value.sessionId, 'session ID');
  if (expectedSessionId !== undefined && sessionId !== validateUuid(expectedSessionId, 'session ID')) {
    throw new Error('launch intent session does not match its path');
  }
  return {
    version: REGISTRY_VERSION,
    registryKey: identity.key,
    sessionId,
    generation: validateGeneration(value.generation),
    createdAt: value.createdAt
  };
}

function compareManagedLaunchIntents(left: ManagedLaunchIntentV2, right: ManagedLaunchIntentV2): number {
  const generationDifference = BigInt(left.generation) - BigInt(right.generation);
  if (generationDifference !== 0n) return generationDifference < 0n ? -1 : 1;
  return left.sessionId.localeCompare(right.sessionId);
}

export function registerManagedLaunchIntent(
  identity: ManagedLabelIdentity,
  sessionId: string,
  generation: string,
  options: ManagedManagerStorageOptions = {}
): ManagedLaunchIntentV2 {
  assertIdentity(identity);
  const intent: ManagedLaunchIntentV2 = {
    version: REGISTRY_VERSION,
    registryKey: identity.key,
    sessionId: validateUuid(sessionId, 'session ID'),
    generation: validateGeneration(generation),
    createdAt: new Date().toISOString()
  };
  const directory = intentsDirectory(options);
  const path = managedLaunchIntentPath(identity, intent.sessionId, options);
  if (existsSync(path)) throw new Error(`Managed terminal launch intent already exists for session ${intent.sessionId}.`);
  writeJsonAtomically(path, intent, directory);
  return intent;
}

export function readManagedLaunchIntents(
  identity: ManagedLabelIdentity,
  options: ManagedManagerStorageOptions = {}
): ManagedLaunchIntentV2[] {
  assertIdentity(identity);
  const directory = intentsDirectory(options);
  const prefix = `${identity.key}.`;
  const suffix = '.json';
  const intents = readdirSync(directory)
    .filter(name => name.startsWith(prefix) && name.endsWith(suffix))
    .map(name => {
      const sessionId = name.slice(prefix.length, -suffix.length);
      const path = managedLaunchIntentPathInDirectory(directory, identity, sessionId);
      try {
        return parseManagedLaunchIntent(readSecureJson(path), identity, sessionId);
      } catch (error) {
        throw new Error(`Unsafe managed terminal launch intent for label ${JSON.stringify(identity.label)}.`, { cause: error });
      }
    });
  return intents.sort(compareManagedLaunchIntents);
}

export function assertManagedLaunchIntentIsLatest(
  identity: ManagedLabelIdentity,
  expected: ManagedLaunchIntentV2,
  options: ManagedManagerStorageOptions = {}
): void {
  const intents = readManagedLaunchIntents(identity, options);
  const own = intents.find(intent =>
    intent.sessionId === expected.sessionId && intent.generation === expected.generation
  );
  const latest = intents.at(-1);
  if (!own || !latest || compareManagedLaunchIntents(own, latest) !== 0) {
    throw new Error(
      `Managed terminal launch for label ${JSON.stringify(identity.label)} was superseded by a newer contender.`
    );
  }
}

/** Caller must hold the identity's label lock. */
export function removeSupersededManagedLaunchIntents(
  identity: ManagedLabelIdentity,
  winner: ManagedLaunchIntentV2,
  options: ManagedManagerStorageOptions = {}
): void {
  assertManagedLaunchIntentIsLatest(identity, winner, options);
  // Derive the intents directory path without re-validating the Windows
  // runtime tree: the readManagedLaunchIntents call below already ensures it.
  const directory = join(managedTerminalRuntimeDirectory(options), 'intents');
  for (const intent of readManagedLaunchIntents(identity, options)) {
    if (compareManagedLaunchIntents(intent, winner) >= 0) continue;
    try {
      unlinkSync(managedLaunchIntentPathInDirectory(directory, identity, intent.sessionId));
    } catch (error) {
      if (!isPlainObject(error) || error.code !== 'ENOENT') throw error;
    }
  }
}

export function removeManagedLaunchIntent(
  identity: ManagedLabelIdentity,
  expected: ManagedLaunchIntentV2,
  options: ManagedManagerStorageOptions = {}
): boolean {
  const path = managedLaunchIntentPath(identity, expected.sessionId, options);
  if (!existsSync(path)) return false;
  let actual: ManagedLaunchIntentV2;
  try {
    actual = parseManagedLaunchIntent(readSecureJson(path), identity, expected.sessionId);
  } catch (error) {
    throw new Error(`Unsafe managed terminal launch intent for label ${JSON.stringify(identity.label)}.`, { cause: error });
  }
  if (actual.generation !== expected.generation) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isPlainObject(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function parseTargetRecord(value: unknown): ManagedTargetRecordV2 {
  if (!isPlainObject(value) || value.version !== REGISTRY_VERSION || typeof value.id !== 'string' || !isIsoDate(value.createdAt)) {
    throw new Error('invalid target metadata');
  }
  return { version: REGISTRY_VERSION, id: validateUuid(value.id, 'target ID'), createdAt: value.createdAt };
}

function parseSessionRecord(
  value: unknown,
  identity: ManagedLabelIdentity,
  options: ManagedManagerStorageOptions
): ManagedSessionRecordV2 {
  if (!isPlainObject(value)) throw new Error('record is not an object');
  if (value.version !== REGISTRY_VERSION) throw new Error('unsupported record version');
  if (
    typeof value.registryKey !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.label !== 'string' ||
    !isPlainObject(value.scope) ||
    typeof value.controlEndpoint !== 'string' ||
    typeof value.authenticationToken !== 'string' ||
    typeof value.generation !== 'string' ||
    !Array.isArray(value.targets) ||
    !isIsoDate(value.createdAt)
  ) {
    throw new Error('record metadata is incomplete');
  }
  const scopeKeys = Object.keys(value.scope).sort();
  const scope = value.scope.type === 'user' && scopeKeys.length === 1 && scopeKeys[0] === 'type'
    ? { type: 'user' } as const
    : value.scope.type === 'project' &&
        typeof value.scope.root === 'string' &&
        scopeKeys.length === 2 &&
        scopeKeys[0] === 'root' &&
        scopeKeys[1] === 'type'
      ? { type: 'project', root: value.scope.root } as const
      : null;
  if (scope === null) throw new Error('record scope is invalid');
  const sessionId = validateUuid(value.sessionId, 'session ID');
  if (
    value.registryKey !== identity.key ||
    value.label !== identity.label ||
    !scopesEqual(scope, identity.scope)
  ) {
    throw new Error('record identity does not match its registry key');
  }
  if (value.controlEndpoint !== managedControlEndpoint(sessionId, options)) {
    throw new Error('record control endpoint is outside its session');
  }
  if (!AUTHENTICATION_TOKEN_PATTERN.test(value.authenticationToken)) {
    throw new Error('record authentication token is invalid');
  }
  const generation = validateGeneration(value.generation);
  if (value.diagnosticPid !== undefined && (!Number.isInteger(value.diagnosticPid) || (value.diagnosticPid as number) <= 0)) {
    throw new Error('record diagnostic PID is invalid');
  }
  const targets = value.targets.map(parseTargetRecord);
  if (targets.length === 0) throw new Error('record must contain at least one target');
  if (new Set(targets.map(target => target.id)).size !== targets.length) throw new Error('record target IDs are not unique');
  return {
    version: REGISTRY_VERSION,
    registryKey: value.registryKey,
    sessionId,
    label: value.label,
    scope,
    controlEndpoint: value.controlEndpoint,
    authenticationToken: value.authenticationToken,
    generation,
    targets,
    ...(value.diagnosticPid === undefined ? {} : { diagnosticPid: value.diagnosticPid as number }),
    createdAt: value.createdAt
  };
}

export function readManagedSessionRecord(
  identity: ManagedLabelIdentity,
  options: ManagedManagerStorageOptions = {}
): ManagedSessionRecordV2 | null {
  assertIdentity(identity);
  const path = managedSessionRecordPath(identity, options);
  if (!existsSync(path)) return null;
  try {
    return parseSessionRecord(readSecureJson(path), identity, options);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(`Unsafe managed terminal registry record for label ${JSON.stringify(identity.label)}.${detail}`, { cause: error });
  }
}

export function writeManagedSessionRecord(
  identity: ManagedLabelIdentity,
  record: ManagedSessionRecordV2,
  options: ManagedManagerStorageOptions = {}
): void {
  assertIdentity(identity);
  const parsedRecord = parseSessionRecord(record, identity, options);
  const root = ensureManagedTerminalRuntimeDirectory(options);
  writeJsonAtomically(managedSessionRecordPath(identity, options), parsedRecord, root);
}

export function removeManagedSessionRecordIfOwned(
  identity: ManagedLabelIdentity,
  sessionId: string,
  options: ManagedManagerStorageOptions = {}
): boolean {
  // Production callers must hold this identity's label lock for the entire
  // inspect-and-remove operation. Inspect before mutating so a foreign record
  // is never hidden from concurrent fail-closed readers.
  const expectedSessionId = validateUuid(sessionId, 'session ID');
  assertIdentity(identity);
  const path = managedSessionRecordPath(identity, options);
  const record = readManagedSessionRecord(identity, options);
  if (record === null || record.sessionId !== expectedSessionId) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isPlainObject(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function managedTargetMarkerPath(
  sessionId: string,
  targetId: string,
  state: ManagedTargetState,
  options: ManagedManagerStorageOptions = {}
): string {
  const sessionDirectory = managedSessionDirectory(sessionId, options);
  const id = validateUuid(targetId, 'target ID');
  if (!['ready', 'stopping', 'stopped', 'failed', 'forced'].includes(state)) {
    throw new Error(`Invalid managed terminal target state: ${state}`);
  }
  const path = join(sessionDirectory, 'targets', `${id}.${state}.json`);
  assertContainedPath(sessionDirectory, path);
  return path;
}

export function writeManagedTargetMarker(
  sessionId: string,
  targetId: string,
  state: ManagedTargetState,
  options: ManagedManagerStorageOptions = {}
): ManagedTargetMarkerV2 {
  const canonicalSessionId = validateUuid(sessionId, 'session ID');
  const canonicalTargetId = validateUuid(targetId, 'target ID');
  const marker: ManagedTargetMarkerV2 = {
    version: REGISTRY_VERSION,
    sessionId: canonicalSessionId,
    targetId: canonicalTargetId,
    state,
    updatedAt: new Date().toISOString()
  };
  const sessionDirectory = ensureManagedSessionDirectory(canonicalSessionId, options);
  writeJsonAtomically(managedTargetMarkerPath(canonicalSessionId, canonicalTargetId, state, options), marker, sessionDirectory);
  return marker;
}

function parseManagedTargetMarker(
  value: unknown,
  sessionId: string,
  targetId: string,
  state: ManagedTargetState
): ManagedTargetMarkerV2 {
  if (
    !isPlainObject(value) ||
    value.version !== REGISTRY_VERSION ||
    value.sessionId !== sessionId ||
    value.targetId !== targetId ||
    value.state !== state ||
    !isIsoDate(value.updatedAt)
  ) {
    throw new Error('target marker metadata does not match its session-scoped path');
  }
  return {
    version: REGISTRY_VERSION,
    sessionId,
    targetId,
    state,
    updatedAt: value.updatedAt
  };
}

export function readManagedTargetMarker(
  sessionId: string,
  targetId: string,
  state: ManagedTargetState,
  options: ManagedManagerStorageOptions = {}
): ManagedTargetMarkerV2 | null {
  const canonicalSessionId = validateUuid(sessionId, 'session ID');
  const canonicalTargetId = validateUuid(targetId, 'target ID');
  const path = managedTargetMarkerPath(canonicalSessionId, canonicalTargetId, state, options);
  if (!existsSync(path)) return null;
  try {
    // Lexical UUID containment is not enough when recovery metadata is being
    // read: reject a tampered symlink/junction or weak POSIX directory anywhere
    // in the managed ancestor chain before accepting its marker as authority.
    const root = managedTerminalRuntimeDirectory(options);
    const sessionsPath = join(root, 'sessions');
    const sessionPath = managedSessionDirectory(canonicalSessionId, options);
    const targetsPath = join(sessionPath, 'targets');
    assertContainedPath(root, sessionsPath);
    assertContainedPath(root, sessionPath);
    assertContainedPath(sessionPath, targetsPath);
    for (const directory of [root, sessionsPath, sessionPath, targetsPath]) {
      verifyPrivateDirectory(directory);
    }
    return parseManagedTargetMarker(readSecureJson(path), canonicalSessionId, canonicalTargetId, state);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(
      `Unsafe managed terminal target marker for session ${JSON.stringify(canonicalSessionId)}, target ${JSON.stringify(canonicalTargetId)}, state ${JSON.stringify(state)}.${detail}`,
      { cause: error }
    );
  }
}

export function removeManagedSessionDirectory(
  sessionId: string,
  options: ManagedManagerStorageOptions = {}
): void {
  const root = managedTerminalRuntimeDirectory(options);
  const path = managedSessionDirectory(sessionId, options);
  assertContainedPath(root, path);
  rmSync(path, { recursive: true, force: true });
  if (process.platform !== 'win32') rmSync(managedControlEndpoint(sessionId, options), { force: true });
}

function lockPath(identity: ManagedLabelIdentity, options: ManagedManagerStorageOptions): string {
  const directory = locksDirectory(options);
  const path = join(directory, `${identity.key}.lock`);
  assertContainedPath(managedTerminalRuntimeDirectory(options), path);
  return path;
}

function lockOwnerPath(path: string): string {
  const ownerPath = join(path, 'owner.json');
  assertContainedPath(path, ownerPath);
  return ownerPath;
}

function parseLockOwner(value: unknown): LockOwnerRecord {
  if (
    !isPlainObject(value) ||
    value.version !== REGISTRY_VERSION ||
    typeof value.lockId !== 'string' ||
    !UUID_PATTERN.test(value.lockId) ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !isIsoDate(value.createdAt)
  ) {
    throw new Error('Managed terminal lock owner metadata is invalid.');
  }
  return { version: REGISTRY_VERSION, lockId: value.lockId.toLowerCase(), pid: value.pid, createdAt: value.createdAt };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function acquireLock(
  identity: ManagedLabelIdentity,
  deadline: number,
  options: ManagedManagerStorageOptions
): Promise<{ path: string; owner: LockOwnerRecord }> {
  const path = lockPath(identity, options);
  const pollIntervalMs = options.lockPollIntervalMs ?? LOCK_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('Managed terminal lock poll interval must be a positive finite number.');
  }
  for (;;) {
    const owner: LockOwnerRecord = {
      version: REGISTRY_VERSION,
      lockId: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString()
    };
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
      verifyOwnedPath(path, 'directory');
      writeJsonAtomically(lockOwnerPath(path), owner, path);
      return { path, owner };
    } catch (error) {
      if (created) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      if (!isPlainObject(error) || error.code !== 'EEXIST') {
        if (existsSync(path) && !lstatSync(path).isDirectory()) {
          throw new Error(`Unsafe managed terminal lock path for label ${JSON.stringify(identity.label)}.`);
        }
        throw error;
      }
    }

    try {
      verifyOwnedPath(path, 'directory');
      const ownerPath = lockOwnerPath(path);
      if (!existsSync(ownerPath)) {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > LOCK_INITIALIZATION_GRACE_MS) {
          throw new Error(
            `Managed terminal lock for label ${JSON.stringify(identity.label)} has ambiguous ownership. ` +
            'Locks are never reclaimed automatically; confirm no managed launch is active and remove the lock manually.'
          );
        }
      } else {
        try {
          parseLockOwner(readSecureJson(ownerPath));
        } catch (error) {
          // The owner can atomically rename the whole lock directory between
          // our existence check and metadata read. That is a normal handoff,
          // so retry it rather than misclassifying it as corrupt ownership.
          if (isPlainObject(error) && error.code === 'ENOENT') throw error;
          throw new Error(
            `Managed terminal lock for label ${JSON.stringify(identity.label)} has ambiguous ownership. ` +
            'Locks are never reclaimed automatically; confirm no managed launch is active and remove the lock manually.',
            { cause: error }
          );
        }
      }
    } catch (error) {
      if (!isPlainObject(error) || error.code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out while acquiring managed terminal lock for label ${JSON.stringify(identity.label)}.`);
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out while acquiring managed terminal lock for label ${JSON.stringify(identity.label)}. ` +
        'Locks are never reclaimed automatically; confirm no managed launch is active and remove the lock manually.'
      );
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function releaseLock(lock: { path: string; owner: LockOwnerRecord }): void {
  const quarantinePath = `${lock.path}.${randomUUID()}.releasing`;
  try {
    renameSync(lock.path, quarantinePath);
  } catch (error) {
    if (isPlainObject(error) && error.code === 'ENOENT') {
      throw new Error('Managed terminal lock ownership was lost before release.', { cause: error });
    }
    throw error;
  }
  try {
    const currentOwner = parseLockOwner(readSecureJson(lockOwnerPath(quarantinePath)));
    if (currentOwner.lockId !== lock.owner.lockId) throw new Error('Managed terminal lock ownership changed before release.');
    rmSync(quarantinePath, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(quarantinePath) && !existsSync(lock.path)) renameSync(quarantinePath, lock.path);
    throw error;
  }
}

export async function withManagedLabelLocks<T>(
  identities: readonly ManagedLabelIdentity[],
  timeoutMs: number,
  callback: () => T | Promise<T>,
  options: ManagedManagerStorageOptions = {}
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Managed terminal lock timeout must be a non-negative finite number.');
  }
  const identitiesByKey = new Map<string, ManagedLabelIdentity>();
  for (const identity of identities) {
    assertIdentity(identity);
    const existing = identitiesByKey.get(identity.key);
    if (existing && (existing.label !== identity.label || !scopesEqual(existing.scope, identity.scope))) {
      throw new Error('Managed terminal registry key collision detected.');
    }
    identitiesByKey.set(identity.key, identity);
  }
  const orderedIdentities = [...identitiesByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  const acquired: { path: string; owner: LockOwnerRecord }[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    for (const identity of orderedIdentities) acquired.push(await acquireLock(identity, deadline, options));
    return await callback();
  } finally {
    const releaseErrors: unknown[] = [];
    for (const lock of acquired.reverse()) {
      try {
        releaseLock(lock);
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    if (releaseErrors.length > 0) throw new AggregateError(releaseErrors, 'Failed to release managed terminal label locks safely.');
  }
}

function legacyRegistryDirectory(options: ManagedManagerStorageOptions): string {
  return resolve(options.legacyRegistryDirectory ?? join(tmpdir(), 'termhelm-supervisors'));
}

function legacyRegistryPath(label: string, options: ManagedManagerStorageOptions): string {
  const directory = legacyRegistryDirectory(options);
  const fileName = `${label.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`;
  const path = join(directory, fileName);
  assertContainedPath(directory, path);
  return path;
}

export function inspectLegacySupervisorRecord(
  label: unknown,
  options: ManagedManagerStorageOptions = {}
): LegacySupervisorRecordInspection {
  const normalizedLabel = normalizeManagedLabel(label);
  const directory = legacyRegistryDirectory(options);
  const path = legacyRegistryPath(normalizedLabel, options);
  try {
    verifyOwnedPath(directory, 'directory');
  } catch (error) {
    if (isPlainObject(error) && error.code === 'ENOENT') return { status: 'absent', path };
    return { status: 'migration-required', path, label: normalizedLabel, reason: 'ambiguous' };
  }

  const directNames = new Set([
    legacyRegistryPath(normalizedLabel, options),
    legacyRegistryPath(normalizedLabel.normalize('NFD'), options)
  ]);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return { status: 'migration-required', path, label: normalizedLabel, reason: 'ambiguous' };
  }

  for (const name of entries) {
    const entryPath = join(directory, name);
    try {
      assertContainedPath(directory, entryPath);
      // A 0.1 filename was lossy. An exact sanitized-name collision is
      // therefore ambiguous even when its JSON happens to name another label.
      if (directNames.has(entryPath)) {
        return { status: 'migration-required', path: entryPath, label: normalizedLabel, reason: 'ambiguous' };
      }

      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_REGISTRY_FILE_SIZE) {
        return { status: 'migration-required', path: entryPath, label: normalizedLabel, reason: 'ambiguous' };
      }
      const record = JSON.parse(readFileSync(entryPath, 'utf8')) as unknown;
      if (!isPlainObject(record) || typeof record.label !== 'string') {
        return { status: 'migration-required', path: entryPath, label: normalizedLabel, reason: 'ambiguous' };
      }
      if (record.label.normalize('NFC') === normalizedLabel) {
        // Version 0.1 has no authenticated acknowledgement or process-tree
        // recovery evidence. A matching saved PID is diagnostic only.
        return { status: 'migration-required', path: entryPath, label: normalizedLabel, reason: 'ambiguous' };
      }
    } catch {
      // An entry that changes while being inspected cannot be proven unrelated
      // to this canonically normalized label, so migration remains fail-closed.
      return { status: 'migration-required', path: entryPath, label: normalizedLabel, reason: 'ambiguous' };
    }
  }
  return { status: 'absent', path };
}

export function removeInactiveLegacySupervisorRecord(
  label: unknown,
  options: ManagedManagerStorageOptions = {}
): boolean {
  // Legacy records are never removed automatically. The inspection validates
  // the label and provides migration guidance to callers.
  inspectLegacySupervisorRecord(label, options);
  return false;
}
