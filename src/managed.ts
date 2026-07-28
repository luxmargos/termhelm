import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManagedTerminalLaunchOptions, validateTerminalTarget } from './config.js';
import {
  openManagedControlServer,
  requestManagedSessionStop,
  type ManagedControlServer
} from './control.js';
import {
  assertManagedLaunchIntentIsLatest,
  createManagedLaunchGeneration,
  createManagedSessionRecord,
  ensureManagedSessionDirectory,
  inspectLegacySupervisorRecord,
  managedTargetMarkerPath,
  readManagedSessionRecord,
  readManagedTargetMarker,
  removeInactiveLegacySupervisorRecord,
  removeManagedLaunchIntent,
  removeManagedSessionDirectory,
  removeManagedSessionRecordIfOwned,
  removeSupersededManagedLaunchIntents,
  registerManagedLaunchIntent,
  resolveManagedLabelIdentity,
  withManagedLabelLocks,
  writeManagedSessionRecord,
  writeManagedTargetMarker,
  type ManagedLabelIdentity,
  type ManagedLaunchIntentV2,
  type ManagedSessionRecordV2,
  type ManagedTargetState
} from './manager.js';
import { launchLinuxTerminalController, resolveLinuxLauncher } from './platforms/linux.js';
import { launchMacTerminalController } from './platforms/macos.js';
import {
  launchWindowsTerminalController,
  resolveWindowsControllerBackend,
  type WindowsControllerBackend
} from './platforms/windows.js';
import type {
  TerminalControllerOptions,
  TerminalProcessController
} from './platforms/controller.js';
import { TerminalControllerLaunchError } from './platforms/controller.js';
import type {
  InternalTerminalLaunchOptions,
  LinuxLauncher,
  ManagedTerminalCloseReason,
  ManagedTerminalCloseResult,
  ManagedTerminalLaunchOptions,
  ManagedTerminalSession,
  ResolvedTerminalTarget,
  TerminalTarget
} from './types.js';

export const DEFAULT_MANAGED_SHUTDOWN_DELAY_MS = 2_500;
export const DEFAULT_MANAGED_CLOSE_WAIT_TIMEOUT_MS = 6_000;
export const DEFAULT_MANAGED_REPLACE_EXTRA_TIMEOUT_MS = 3_000;

const MARKER_POLL_INTERVAL_MS = 50;

type ManagedSessionState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface TargetOwnership {
  readonly id: string;
  readonly target: ResolvedTerminalTarget;
  readonly controllerOptions: TerminalControllerOptions;
  controller?: TerminalProcessController;
  neverLaunched: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function targetTokenPath(sessionDirectory: string, targetId: string): string {
  return join(sessionDirectory, 'targets', `${targetId}.alive`);
}

function supervisorTokenPath(sessionDirectory: string): string {
  return join(sessionDirectory, 'supervisor.alive');
}

function migrationError(identity: ManagedLabelIdentity, reason: 'active' | 'ambiguous'): Error {
  return new Error(
    `Legacy terminal-windows 0.1.x state for label ${JSON.stringify(identity.label)} is ${reason}. ` +
    'Stop the 0.1.x supervisor manually and remove its legacy record before retrying. ' +
    'terminal-windows 0.2.0 will not signal or kill a process through a legacy PID.'
  );
}

interface ManagedPlatformBackend {
  linuxLauncher: LinuxLauncher | null;
  windowsController: WindowsControllerBackend | null;
}

function preflightManagedBackend(): ManagedPlatformBackend {
  if (process.platform === 'win32') {
    const windowsController = resolveWindowsControllerBackend();
    if (!windowsController) {
      throw new Error(
        'Neither the native Windows controller nor the bundled PowerShell controller passed its ownership self-test. ' +
        'Refusing to launch without safe process-tree ownership.'
      );
    }
    return { linuxLauncher: null, windowsController };
  }
  if (process.platform === 'linux') {
    const launcher = resolveLinuxLauncher();
    if (!launcher) throw new Error('No supported Linux terminal emulator was found.');
    return { linuxLauncher: launcher, windowsController: null };
  }
  if (process.platform !== 'darwin') {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  return { linuxLauncher: null, windowsController: null };
}

function launchController(
  target: ResolvedTerminalTarget,
  launchOptions: InternalTerminalLaunchOptions,
  controllerOptions: TerminalControllerOptions,
  backend: ManagedPlatformBackend
): TerminalProcessController {
  if (process.platform === 'darwin') {
    return launchMacTerminalController(target, launchOptions, controllerOptions);
  }
  if (process.platform === 'win32') {
    return launchWindowsTerminalController(target, launchOptions, controllerOptions, backend.windowsController);
  }
  if (process.platform === 'linux' && backend.linuxLauncher) {
    return launchLinuxTerminalController(target, backend.linuxLauncher, launchOptions, controllerOptions);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function markerExists(
  record: ManagedSessionRecordV2,
  targetId: string,
  state: ManagedTargetState
): boolean {
  return readManagedTargetMarker(record.sessionId, targetId, state) !== null;
}

function targetTerminationConfirmed(record: ManagedSessionRecordV2, targetId: string): boolean {
  return markerExists(record, targetId, 'stopped') || markerExists(record, targetId, 'failed');
}

function sessionTerminationConfirmed(record: ManagedSessionRecordV2): boolean {
  return record.targets.every(target => targetTerminationConfirmed(record, target.id));
}

function recordsMatch(left: ManagedSessionRecordV2, right: ManagedSessionRecordV2): boolean {
  return left.version === right.version
    && left.registryKey === right.registryKey
    && left.sessionId === right.sessionId
    && left.label === right.label
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
    && left.controlEndpoint === right.controlEndpoint
    && left.authenticationToken === right.authenticationToken
    && left.generation === right.generation
    && left.createdAt === right.createdAt
    && left.diagnosticPid === right.diagnosticPid
    && left.targets.length === right.targets.length
    && left.targets.every((target, index) => {
      const other = right.targets[index];
      return other !== undefined
        && target.version === other.version
        && target.id === other.id
        && target.createdAt === other.createdAt;
    });
}

async function waitForSessionTermination(
  identity: ManagedLabelIdentity,
  record: ManagedSessionRecordV2,
  deadline: number
): Promise<boolean> {
  while (true) {
    if (sessionTerminationConfirmed(record)) return true;
    const currentRecord = readManagedSessionRecord(identity);
    if (currentRecord !== null && !recordsMatch(currentRecord, record)) {
      throw new Error(
        `Managed terminal registry ownership changed unexpectedly for label ${JSON.stringify(identity.label)}.`
      );
    }
    const remaining = remainingTime(deadline);
    if (remaining === 0) return false;
    await delay(Math.min(MARKER_POLL_INTERVAL_MS, remaining));
  }
}

async function replaceExistingSession(
  identity: ManagedLabelIdentity,
  deadline: number,
  contenderGeneration: string
): Promise<void> {
  const legacy = inspectLegacySupervisorRecord(identity.label);
  if (legacy.status === 'migration-required') throw migrationError(identity, legacy.reason);
  if (legacy.status === 'inactive' && !removeInactiveLegacySupervisorRecord(identity.label)) {
    throw new Error(
      `Legacy terminal-windows 0.1.x state for label ${JSON.stringify(identity.label)} changed while being inspected. ` +
      'Refusing replacement because ownership is uncertain.'
    );
  }

  const record = readManagedSessionRecord(identity);
  if (record === null) return;
  const generationDifference = BigInt(record.generation) - BigInt(contenderGeneration);
  if (generationDifference > 0n) {
    throw new Error(
      `Managed terminal launch for label ${JSON.stringify(identity.label)} was superseded by a newer recorded generation.`
    );
  }
  if (generationDifference === 0n) {
    throw new Error(
      `Managed terminal generation ownership is ambiguous for label ${JSON.stringify(identity.label)}.`
    );
  }

  const recoveryAlreadyConfirmed = sessionTerminationConfirmed(record);
  const remaining = remainingTime(deadline);
  if (remaining === 0) {
    throw new Error(
      `Timed out before the previous managed process tree for label ${JSON.stringify(identity.label)} could be stopped.`
    );
  }
  try {
    // Even when recovery markers already prove termination, give a live owner
    // a short authenticated handoff opportunity so it can settle `closed`.
    await requestManagedSessionStop({
      endpoint: record.controlEndpoint,
      authenticationToken: record.authenticationToken,
      requestId: randomUUID(),
      reason: 'replaced',
      timeoutMs: recoveryAlreadyConfirmed ? Math.min(1_000, remaining) : remaining
    });
  } catch (error) {
    const confirmed = await waitForSessionTermination(identity, record, deadline);
    if (!confirmed) {
      throw new Error(
        `Could not authenticate and confirm shutdown of the previous managed process tree for label ` +
        `${JSON.stringify(identity.label)}. Refusing to launch a replacement. ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  const currentRecord = readManagedSessionRecord(identity);
  if (currentRecord === null) return;
  if (!recordsMatch(currentRecord, record)) {
    throw new Error(
      `Managed terminal registry ownership changed unexpectedly for label ${JSON.stringify(identity.label)}.`
    );
  }
  if (!sessionTerminationConfirmed(record)) {
    const confirmed = await waitForSessionTermination(identity, record, deadline);
    if (!confirmed) {
      throw new Error(
        `The previous managed process tree for label ${JSON.stringify(identity.label)} did not acknowledge termination. ` +
        'Refusing to launch a replacement.'
      );
    }
  }
  if (!removeManagedSessionRecordIfOwned(identity, record.sessionId)) {
    throw new Error(
      `Could not remove the stopped managed terminal record for label ${JSON.stringify(identity.label)} safely.`
    );
  }
}

class ManagedTerminalSessionImpl implements ManagedTerminalSession {
  readonly id: string;
  readonly label: string;
  readonly ready: Promise<void>;
  readonly closed: Promise<ManagedTerminalCloseResult>;

  private readonly options: ManagedTerminalLaunchOptions;
  private readonly targets: readonly ResolvedTerminalTarget[];
  private readonly currentIdentity: ManagedLabelIdentity;
  private readonly replacementIdentities: readonly ManagedLabelIdentity[];
  private readonly launchIntents: ReadonlyMap<string, ManagedLaunchIntentV2>;
  private readonly readyDeferred = deferred<void>();
  private readonly closedDeferred = deferred<ManagedTerminalCloseResult>();
  private readonly ownership: TargetOwnership[];
  private readonly sessionDirectory: string;
  private readonly supervisorToken: string;
  private readonly shutdownDelayMs: number;
  private readonly closeWaitTimeoutMs: number;
  private readonly replaceTimeoutMs: number;
  private readonly initialization: Promise<void>;
  private state: ManagedSessionState = 'starting';
  private record: ManagedSessionRecordV2;
  private controlServer: ManagedControlServer | null = null;
  private recordPublished = false;
  private readySettled = false;
  private closedResult: ManagedTerminalCloseResult | null = null;
  private stopOperation: Promise<ManagedTerminalCloseResult> | null = null;
  private monitorOperation: Promise<void> | null = null;
  private infrastructureCleanup: Promise<void> | null = null;
  private initializationError: unknown;
  private requestedStopReason: ManagedTerminalCloseReason | null = null;
  private readonly lifecycleWarnings: string[] = [];
  private readonly controllerStates = new Map<string, 'ready' | 'stopping' | 'stopped'>();
  private readonly processExitHandler: () => void;

  constructor(targets: readonly ResolvedTerminalTarget[], options: ManagedTerminalLaunchOptions) {
    this.options = options;
    this.targets = targets;
    this.id = randomUUID();
    this.shutdownDelayMs = options.shutdownDelayMs ?? DEFAULT_MANAGED_SHUTDOWN_DELAY_MS;
    this.closeWaitTimeoutMs = options.closeWaitTimeoutMs ?? DEFAULT_MANAGED_CLOSE_WAIT_TIMEOUT_MS;
    this.replaceTimeoutMs = options.replaceTimeoutMs
      ?? this.shutdownDelayMs + this.closeWaitTimeoutMs + DEFAULT_MANAGED_REPLACE_EXTRA_TIMEOUT_MS;
    this.currentIdentity = resolveManagedLabelIdentity(options.label, options.labelScope);
    this.label = this.currentIdentity.label;
    const identities = [
      this.currentIdentity,
      ...(options.replaceLabels ?? []).map(label =>
        resolveManagedLabelIdentity(label, this.currentIdentity.scope)
      )
    ];
    this.replacementIdentities = [...new Map(identities.map(identity => [identity.key, identity])).values()];
    const generation = createManagedLaunchGeneration();
    this.record = createManagedSessionRecord({
      identity: this.currentIdentity,
      sessionId: this.id,
      generation,
      targetIds: targets.map(() => randomUUID()),
      diagnosticPid: process.pid
    });
    this.sessionDirectory = ensureManagedSessionDirectory(this.id);
    const launchIntents = new Map<string, ManagedLaunchIntentV2>();
    try {
      for (const identity of this.replacementIdentities) {
        launchIntents.set(identity.key, registerManagedLaunchIntent(identity, this.id, generation));
      }
    } catch (error) {
      for (const identity of this.replacementIdentities) {
        const intent = launchIntents.get(identity.key);
        if (!intent) continue;
        try {
          removeManagedLaunchIntent(identity, intent);
        } catch {
          // Preserve the registration failure; the UUID-scoped intent remains
          // fail-closed if it could not be inspected safely.
        }
      }
      removeManagedSessionDirectory(this.id);
      throw error;
    }
    this.launchIntents = launchIntents;
    this.supervisorToken = supervisorTokenPath(this.sessionDirectory);
    this.ownership = this.record.targets.map((targetRecord, index) => ({
      id: targetRecord.id,
      target: targets[index]!,
      controllerOptions: {
        id: targetRecord.id,
        sessionId: this.id,
        controlDirectory: join(this.sessionDirectory, 'targets'),
        targetTokenPath: targetTokenPath(this.sessionDirectory, targetRecord.id),
        readyPath: managedTargetMarkerPath(this.id, targetRecord.id, 'ready'),
        stoppingPath: managedTargetMarkerPath(this.id, targetRecord.id, 'stopping'),
        stoppedPath: managedTargetMarkerPath(this.id, targetRecord.id, 'stopped'),
        failedPath: managedTargetMarkerPath(this.id, targetRecord.id, 'failed'),
        forcedPath: managedTargetMarkerPath(this.id, targetRecord.id, 'forced'),
        gracefulShutdownMs: this.shutdownDelayMs
      },
      neverLaunched: true
    }));
    this.ready = this.readyDeferred.promise;
    this.closed = this.closedDeferred.promise;
    // Preserve the public rejection while preventing a caller that attaches on
    // the next turn from causing an unhandled-rejection process warning.
    void this.ready.catch(() => {});
    void this.closed.catch(() => {});
    this.processExitHandler = () => this.disconnectControllersSynchronously();
    process.once('exit', this.processExitHandler);
    this.initialization = this.initialize();
  }

  close(): Promise<ManagedTerminalCloseResult> {
    return this.stop('closed');
  }

  stop(reason: ManagedTerminalCloseReason): Promise<ManagedTerminalCloseResult> {
    if (this.closedResult) return Promise.resolve(this.closedResult);
    this.requestedStopReason ??= reason;
    if (this.stopOperation) return this.stopOperation;
    const operation = this.stopAfterInitialization(reason).catch(error => {
      this.stopOperation = null;
      throw error;
    });
    this.stopOperation = operation;
    return operation;
  }

  private async initialize(): Promise<void> {
    try {
      // Probe controller backends before starting the replacement deadline or
      // taking label locks. A blocked native executable can consume its probe
      // timeout, but it must not steal the time reserved for stopping the
      // predecessor once the PowerShell fallback has been selected.
      const platformBackend = preflightManagedBackend();
      const deadline = Date.now() + this.replaceTimeoutMs;
      await withManagedLabelLocks(this.replacementIdentities, this.replaceTimeoutMs, async () => {
        try {
          if (this.requestedStopReason) {
            throw new Error('Managed terminal session was closed before launch started.');
          }
          for (const identity of this.replacementIdentities) {
            const intent = this.launchIntents.get(identity.key)!;
            assertManagedLaunchIntentIsLatest(identity, intent);
            removeSupersededManagedLaunchIntents(identity, intent);
          }
          for (const identity of this.replacementIdentities) {
            await replaceExistingSession(
              identity,
              deadline,
              this.launchIntents.get(identity.key)!.generation
            );
            this.assertLatestLaunchIntents();
            if (this.requestedStopReason) {
              throw new Error('Managed terminal session was closed during replacement.');
            }
          }
          if (remainingTime(deadline) === 0) {
            throw new Error('Managed terminal replacement deadline expired before launch.');
          }
          this.assertLatestLaunchIntents();

          writeFileSync(this.supervisorToken, `${this.id}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          this.controlServer = await openManagedControlServer({
            endpoint: this.record.controlEndpoint,
            authenticationToken: this.record.authenticationToken,
            onStop: async reason => await this.stop(reason),
            sessionId: this.id,
            controllerTargetIds: this.record.targets.map(target => target.id),
            onControllerState: (targetId, state) => {
              const previous = this.controllerStates.get(targetId);
              const valid = previous === undefined
                || previous === state
                || (previous === 'ready' && (state === 'stopping' || state === 'stopped'))
                || (previous === 'stopping' && state === 'stopped');
              if (!valid) {
                throw new Error(`Managed terminal controller ${targetId} reported an invalid ${previous} -> ${state} transition.`);
              }
              writeManagedTargetMarker(this.id, targetId, state);
              this.controllerStates.set(targetId, state);
            }
          });
          this.assertLatestLaunchIntents();
          writeManagedSessionRecord(this.currentIdentity, this.record);
          this.recordPublished = true;

          const launchOptions: InternalTerminalLaunchOptions = {
            exitAfterCommand: this.options.exitAfterCommand ?? true,
            supervisorPid: process.pid,
            shutdownTokenPath: this.supervisorToken,
            shutdownStateDirectory: this.sessionDirectory,
            closeWaitTimeoutMs: this.closeWaitTimeoutMs,
            controlEndpoint: this.record.controlEndpoint,
            authenticationToken: this.record.authenticationToken
          };
          for (const ownedTarget of this.ownership) {
            this.assertLatestLaunchIntents();
            if (this.requestedStopReason) {
              throw new Error('Managed terminal session was closed before all targets became ready.');
            }
            try {
              ownedTarget.controller = launchController(
                ownedTarget.target,
                launchOptions,
                ownedTarget.controllerOptions,
                platformBackend
              );
              ownedTarget.neverLaunched = false;
            } catch (error) {
              if (error instanceof TerminalControllerLaunchError) {
                ownedTarget.controller = error.controller;
                ownedTarget.neverLaunched = false;
              }
              throw error;
            }
            await this.waitForTargetReadiness(ownedTarget.id, deadline);
            this.assertLatestLaunchIntents();
          }
          this.assertLatestLaunchIntents();
        } catch (error) {
          await this.rollbackLaunch(error);
          throw error;
        }
      });

      this.assertLatestLaunchIntents();
      this.state = 'ready';
      this.readySettled = true;
      this.readyDeferred.resolve();
      this.monitorOperation = this.monitorNaturalTermination();
      void this.monitorOperation.catch(error => {
        if (!this.closedResult) void this.stop('launch-failed').catch(() => {});
        this.initializationError ??= error;
      });
    } catch (error) {
      let initializationError = error;
      // Do not inspect marker state in the catch condition: corrupted recovery
      // metadata can itself throw. Rollback is idempotent and performs its own
      // guarded confirmation, ensuring the public promises are always settled.
      if (this.ownership.some(ownedTarget => !ownedTarget.neverLaunched)) {
        try {
          await this.rollbackLaunch(error);
        } catch (rollbackError) {
          initializationError = rollbackError;
        }
      }
      this.initializationError = initializationError;
      this.state = 'failed';
      if (!this.readySettled) {
        this.readySettled = true;
        this.readyDeferred.reject(initializationError);
      }
      // Cleanup must remain best-effort here: a tampered marker or other
      // recovery-state error must not make initialize() reject independently
      // of the public ready/closed promises.
      try {
        this.requestOwnedTargetShutdowns();
        if (this.allTargetsConfirmedTerminated()) {
          await this.finishConfirmedStop(this.requestedStopReason ?? 'launch-failed');
        }
      } catch (cleanupError) {
        this.lifecycleWarnings.push(`Initialization cleanup warning: ${errorMessage(cleanupError)}`);
      }
    }
  }

  private assertLatestLaunchIntents(): void {
    for (const identity of this.replacementIdentities) {
      assertManagedLaunchIntentIsLatest(identity, this.launchIntents.get(identity.key)!);
    }
  }

  private async rollbackLaunch(launchError: unknown): Promise<void> {
    const requestErrors = this.requestOwnedTargetShutdowns();
    const deadline = Date.now() + this.shutdownDelayMs + this.closeWaitTimeoutMs;
    let confirmed = false;
    try {
      confirmed = await this.waitForOwnedTargets(deadline);
    } catch (error) {
      requestErrors.push(error);
    }
    if (!confirmed) {
      throw new AggregateError(
        [launchError, ...requestErrors],
        `Managed terminal launch failed and rollback could not confirm every owned process tree stopped: ` +
        errorMessage(launchError)
      );
    }
  }

  private async stopAfterInitialization(reason: ManagedTerminalCloseReason): Promise<ManagedTerminalCloseResult> {
    await this.initialization;
    if (this.closedResult) return this.closedResult;
    this.state = 'stopping';

    const requestErrors = this.requestOwnedTargetShutdowns();

    const deadline = Date.now() + this.shutdownDelayMs + this.closeWaitTimeoutMs;
    let confirmed = false;
    try {
      confirmed = await this.waitForOwnedTargets(deadline);
    } catch (error) {
      requestErrors.push(error);
    }
    if (!confirmed) {
      const original = this.initializationError ? ` Initial launch error: ${errorMessage(this.initializationError)}` : '';
      throw new AggregateError(
        requestErrors,
        `Managed terminal session ${this.id} could not confirm every owned process tree stopped. ` +
        `Its registry record was retained and no replacement is safe.${original}`
      );
    }
    return await this.finishConfirmedStop(reason);
  }

  private requestOwnedTargetShutdowns(): unknown[] {
    const errors: unknown[] = [];
    for (const ownedTarget of this.ownership) {
      let terminated = false;
      try {
        terminated = this.targetConfirmedTerminated(ownedTarget.id);
      } catch (error) {
        errors.push(error);
      }
      if (terminated) continue;

      if (ownedTarget.neverLaunched) {
        try {
          writeManagedTargetMarker(this.id, ownedTarget.id, 'failed');
        } catch (error) {
          errors.push(error);
        }
        continue;
      }

      try {
        writeManagedTargetMarker(this.id, ownedTarget.id, 'stopping');
      } catch (error) {
        errors.push(error);
      }
      try {
        ownedTarget.controller?.requestClose();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const error of errors) {
      this.lifecycleWarnings.push(`Shutdown request warning: ${errorMessage(error)}`);
    }
    return errors;
  }

  private targetConfirmedTerminated(targetId: string): boolean {
    return targetTerminationConfirmed(this.record, targetId);
  }

  private allTargetsConfirmedTerminated(): boolean {
    return sessionTerminationConfirmed(this.record);
  }

  private async waitForOwnedTargets(deadline: number): Promise<boolean> {
    while (!this.allTargetsConfirmedTerminated()) {
      const remaining = remainingTime(deadline);
      if (remaining === 0) return false;
      await delay(Math.min(MARKER_POLL_INTERVAL_MS, remaining));
    }
    return true;
  }

  private async waitForTargetReadiness(targetId: string, deadline: number): Promise<void> {
    while (true) {
      if (this.requestedStopReason) {
        throw new Error(`Managed terminal target ${targetId} was closed before readiness.`);
      }
      if (readManagedTargetMarker(this.id, targetId, 'failed') !== null) {
        throw new Error(`Managed terminal target ${targetId} failed before readiness.`);
      }
      if (readManagedTargetMarker(this.id, targetId, 'ready') !== null) return;
      const remaining = remainingTime(deadline);
      if (remaining === 0) {
        throw new Error(`Managed terminal target ${targetId} did not acknowledge readiness.`);
      }
      await delay(Math.min(MARKER_POLL_INTERVAL_MS, remaining));
    }
  }

  private async finishConfirmedStop(reason: ManagedTerminalCloseReason): Promise<ManagedTerminalCloseResult> {
    if (this.closedResult) return this.closedResult;
    if (!this.allTargetsConfirmedTerminated()) {
      throw new Error(`Refusing to finish managed terminal session ${this.id} before all targets terminate.`);
    }

    const warnings: string[] = [...this.lifecycleWarnings];
    const forcedTargetIds: string[] = [];
    for (const ownedTarget of this.ownership) {
      const controller = ownedTarget.controller;
      if (!controller) continue;
      if (readManagedTargetMarker(this.id, ownedTarget.id, 'forced') !== null) {
        forcedTargetIds.push(ownedTarget.id);
      }
      try {
        // The process marker is already authoritative. This zero-time close is
        // used only for exact-identity, best-effort UI cleanup on macOS.
        controller.close(0);
        controller.dispose();
      } catch (error) {
        warnings.push(`Target ${ownedTarget.id} cleanup warning: ${errorMessage(error)}`);
      }
    }

    this.state = reason === 'launch-failed' ? 'failed' : 'stopped';
    const result: ManagedTerminalCloseResult = {
      reason,
      forcedTargetIds,
      warnings
    };
    this.closedResult = result;
    // No controller remains live once every target has acknowledged
    // termination, so synchronous disconnect cleanup is no longer needed.
    process.removeListener('exit', this.processExitHandler);
    this.closedDeferred.resolve(result);
    this.scheduleInfrastructureCleanup();
    return result;
  }

  private scheduleInfrastructureCleanup(): void {
    if (this.infrastructureCleanup) return;
    this.infrastructureCleanup = new Promise(resolve => {
      setTimeout(() => {
        void (async () => {
          let sessionDirectoryCanBeRemoved = !this.recordPublished;
          try {
            if (this.recordPublished) {
              await withManagedLabelLocks([this.currentIdentity], this.replaceTimeoutMs, async () => {
                const currentRecord = readManagedSessionRecord(this.currentIdentity);
                if (currentRecord?.sessionId === this.id) {
                  if (!removeManagedSessionRecordIfOwned(this.currentIdentity, this.id)) {
                    throw new Error(`Could not safely remove the registry record for managed terminal session ${this.id}.`);
                  }
                }
                this.recordPublished = false;
                sessionDirectoryCanBeRemoved = true;
              });
            }
          } catch {
            // A lock or registry ambiguity leaves the stopped record and its
            // recovery markers intact for a future fail-closed inspection.
          }
          try {
            await this.controlServer?.closeGracefully();
          } catch {
            // Targets and the registry are already confirmed clean. A control
            // endpoint cleanup error must not become an unhandled rejection.
          } finally {
            this.controlServer = null;
            try {
              rmSync(this.supervisorToken, { force: true });
            } catch {
              // All owned targets are stopped; retaining a token is harmless
              // recovery debris and must not reject an unobserved task.
            }
            // Retain this generation's winning intents as durable per-label
            // high-water fences. The next higher generation prunes them while
            // holding the same sorted label locks. Removing the winner here
            // could let a delayed, lower-ticket contender resurrect.
            if (sessionDirectoryCanBeRemoved) {
              try {
                removeManagedSessionDirectory(this.id);
              } catch {
                // Conservative recovery debris is preferable to an unhandled
                // cleanup rejection after process termination was confirmed.
              }
            }
            resolve();
          }
        })();
      }, 0);
    });
  }

  private disconnectControllersSynchronously(): void {
    try {
      rmSync(this.supervisorToken, { force: true });
    } catch {
      // Continue removing every per-target token; authenticated transport
      // disconnect remains the independent controller shutdown trigger.
    }
    for (const ownedTarget of this.ownership) {
      try {
        rmSync(ownedTarget.controllerOptions.targetTokenPath!, { force: true });
      } catch {
        // Best effort during the synchronous process exit event.
      }
    }
  }

  private async monitorNaturalTermination(): Promise<void> {
    while (this.state === 'ready') {
      if (this.allTargetsConfirmedTerminated()) {
        await this.stop('target-exited');
        return;
      }
      await delay(MARKER_POLL_INTERVAL_MS);
    }
  }
}

/**
 * Starts an authenticated managed terminal session and returns lifecycle
 * promises immediately. Required label validation is synchronous and happens
 * before any registry, filesystem, replacement, or process operation.
 */
export function startManagedTerminalWindows(
  targets: TerminalTarget[],
  options: ManagedTerminalLaunchOptions
): ManagedTerminalSession {
  const validatedOptions = validateManagedTerminalLaunchOptions(options);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('Managed terminal targets must be a non-empty array.');
  }
  const validatedTargets = targets.map((target, index) =>
    validateTerminalTarget(target, `targets[${index}]`)
  );
  return new ManagedTerminalSessionImpl(validatedTargets, validatedOptions);
}

/** Long-running wrapper used by the CLI and callers that do not need a handle. */
export async function launchManagedTerminalWindows(
  targets: TerminalTarget[],
  options: ManagedTerminalLaunchOptions
): Promise<void> {
  const session = startManagedTerminalWindows(targets, options) as ManagedTerminalSessionImpl;
  let signalExitCode: number | undefined;
  const onSignal = (exitCode: number) => (): void => {
    signalExitCode ??= exitCode;
    void session.stop('signal').catch(() => {});
  };
  const signalHandlers = {
    SIGINT: onSignal(130),
    SIGTERM: onSignal(143),
    SIGHUP: onSignal(129)
  } as const;
  for (const [signal, handler] of Object.entries(signalHandlers)) process.once(signal, handler);
  try {
    await session.ready;
    await session.closed;
  } catch (error) {
    try {
      const closeResult = await session.stop('launch-failed');
      if (closeResult.reason === 'signal') return;
    } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], 'Managed terminal launch and confirmed rollback both failed.');
    }
    throw error;
  } finally {
    for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
    if (signalExitCode !== undefined) process.exitCode = signalExitCode;
  }
}
