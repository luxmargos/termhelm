export interface TerminalTarget {
  /** Terminal window title. Titles are display-only and are never used as process identity. */
  title: string;
  /** Working directory for the command. Defaults to the current working directory. */
  cwd?: string;
  /** Command string executed by the terminal shell. */
  command: string;
  /** Extra environment variables applied only to this command. */
  env?: Record<string, string>;
  /** Message printed after the command exits. */
  exitMessage?: string;
}

/** @internal Validated target shape used after cwd defaulting and resolution. */
export interface ResolvedTerminalTarget extends TerminalTarget {
  cwd: string;
}

export interface TerminalLaunchCommand {
  command: string;
  args: string[];
}

export interface TerminalLaunchOptions {
  /** Close terminal UI after its owned process tree stops. Defaults to false. */
  autoClose?: boolean;
  /** Exit after the command instead of leaving an interactive shell. */
  exitAfterCommand?: boolean;
}

/** @internal Controller metadata; intentionally not re-exported by the package entry point. */
export interface InternalTerminalLaunchOptions extends TerminalLaunchOptions {
  supervisorPid?: number;
  shutdownTokenPath?: string;
  shutdownStateDirectory?: string;
  shutdownCompletePath?: string;
  closeWaitTimeoutMs?: number;
  controlEndpoint?: string;
  authenticationToken?: string;
  posixSidecar?: {
    executablePath: string;
    scriptPath: string;
    payloadPath: string;
    finalizerPayloadPath: string;
    detachedFinalizerPayloadPath: string;
  };
}

export type ManagedTerminalLabelScope =
  | { type: 'user' }
  | { type: 'project'; root: string };

export interface ManagedTerminalLaunchOptions extends TerminalLaunchOptions {
  /** Stable logical identity for replacement. Required for every managed launch. */
  label: string;
  /** User-global by default, or explicitly scoped to a canonical project root. */
  labelScope?: ManagedTerminalLabelScope;
  /** Additional labels to replace. The current label is always replaced automatically. */
  replaceLabels?: string[];
  /** Graceful shutdown period before force is used. Defaults to 2,500 ms. */
  shutdownDelayMs?: number;
  /** Time allowed to confirm forced shutdown. Defaults to 6,000 ms. */
  closeWaitTimeoutMs?: number;
  /** Total deadline for replacement acknowledgement. */
  replaceTimeoutMs?: number;
}

export type ManagedTerminalCloseReason =
  | 'closed'
  | 'replaced'
  | 'signal'
  | 'supervisor-disconnected'
  | 'target-exited'
  | 'launch-failed';

export type TerminalUiCloseOutcome =
  | 'closed'
  | 'preserved'
  | 'host-managed'
  | 'refused-shared'
  | 'cancelled'
  | 'unsupported';

export interface TerminalUiCloseResult {
  readonly targetId: string;
  readonly outcome: TerminalUiCloseOutcome;
}

export interface ManagedTerminalCloseResult {
  readonly reason: ManagedTerminalCloseReason;
  readonly forcedTargetIds: readonly string[];
  readonly uiCloseResults: readonly TerminalUiCloseResult[];
  readonly warnings: readonly string[];
}

export interface ManagedTerminalSession {
  readonly id: string;
  readonly label: string;
  readonly ready: Promise<void>;
  readonly closed: Promise<ManagedTerminalCloseResult>;
  close(): Promise<ManagedTerminalCloseResult>;
}

/** Point-in-time readiness result for a session owned by a detached supervisor. */
export interface DetachedManagedTerminalLaunchResult {
  readonly sessionId: string;
  readonly label: string;
}

export interface ManagedTerminalKillOptions {
  /** User-global by default, or explicitly scoped to a canonical project root. */
  labelScope?: ManagedTerminalLabelScope;
  /** Total deadline for locating and stopping the managed session. */
  timeoutMs?: number;
}

export type ManagedTerminalKillResult =
  | { readonly status: 'killed'; readonly label: string; readonly sessionId: string }
  | { readonly status: 'not-found'; readonly label: string };

export interface TerminalWindowCloseResult {
  readonly uiCloseResults: readonly TerminalUiCloseResult[];
  readonly warnings: readonly string[];
}

export interface TerminalWindowSession {
  /** Settles after every plain target reaches authoritative terminal completion. */
  readonly closed: Promise<TerminalWindowCloseResult>;
  close(): void;
}

/**
 * Config files can launch plain or managed sessions. Supplying `label` selects
 * managed behavior; omitting it selects a plain launch.
 */
export type TerminalWindowsConfigOptions =
  & TerminalLaunchOptions
  & Partial<ManagedTerminalLaunchOptions>;

export interface TerminalWindowsConfig {
  targets: TerminalTarget[];
  options?: TerminalWindowsConfigOptions;
  /** Run a managed config in a hidden detached supervisor. Requires options.label. */
  detached?: boolean;
}

export type LinuxTerminalAdapterId =
  | 'gnome-terminal'
  | 'konsole'
  | 'xfce4-terminal'
  | 'xterm';

export interface LinuxTerminalCapabilities {
  readonly title: boolean;
  readonly holdOpen: boolean;
  readonly exactProcess: boolean;
  readonly waitsForCommand: boolean;
}

export interface LinuxLauncher {
  (
    target: ResolvedTerminalTarget,
    shell: string,
    posixCommand: string,
    uiOptions?: { readonly holdOpen: boolean }
  ): TerminalLaunchCommand;
  /** Present on built-in capability-based adapters; optional for legacy test/custom callables. */
  readonly adapterId?: LinuxTerminalAdapterId;
  readonly executable?: string;
  readonly capabilities?: LinuxTerminalCapabilities;
}
