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
    encodedPayload: string;
  };
}

export type ManagedTerminalLabelScope =
  | { type: 'user' }
  | { type: 'project'; root: string };

export interface ManagedTerminalLaunchOptions {
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
  /** Managed targets exit after their command by default. */
  exitAfterCommand?: boolean;
}

export type ManagedTerminalCloseReason =
  | 'closed'
  | 'replaced'
  | 'signal'
  | 'supervisor-disconnected'
  | 'target-exited'
  | 'launch-failed';

export interface ManagedTerminalCloseResult {
  readonly reason: ManagedTerminalCloseReason;
  readonly forcedTargetIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface ManagedTerminalSession {
  readonly id: string;
  readonly label: string;
  readonly ready: Promise<void>;
  readonly closed: Promise<ManagedTerminalCloseResult>;
  close(): Promise<ManagedTerminalCloseResult>;
}

export interface TerminalWindowSession {
  close(): void;
}

/**
 * Config files can be used in plain or managed mode, so `label` is optional at
 * the file-shape level. It becomes required when the config is launched in
 * managed mode.
 */
export type TerminalWindowsConfigOptions =
  & TerminalLaunchOptions
  & Partial<ManagedTerminalLaunchOptions>;

export interface TerminalWindowsConfig {
  targets: TerminalTarget[];
  options?: TerminalWindowsConfigOptions;
}

export type LinuxLauncher = (
  target: ResolvedTerminalTarget,
  shell: string,
  posixCommand: string
) => TerminalLaunchCommand;
