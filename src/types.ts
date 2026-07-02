export interface TerminalTarget {
  /** Terminal window title. */
  title: string;
  /** Working directory for the command. */
  cwd: string;
  /** Command string executed by the terminal shell. */
  command: string;
  /** Extra environment variables applied only to this command. */
  env?: Record<string, string>;
  /** Message printed after the command exits. */
  exitMessage?: string;
}

export interface TerminalLaunchCommand {
  command: string;
  args: string[];
}

export interface TerminalLaunchOptions {
  supervisorPid?: number;
  shutdownTokenPath?: string;
  shutdownStateDirectory?: string;
  shutdownCompletePath?: string;
  exitAfterCommand?: boolean;
  closeWaitTimeoutMs?: number;
  useMacTerminalCustomTitleClose?: boolean;
}

export interface ManagedTerminalLaunchOptions {
  label?: string;
  shutdownDelayMs?: number;
  replaceLabels?: string[];
  replaceTimeoutMs?: number;
  closeWaitTimeoutMs?: number;
  exitAfterCommand?: boolean;
  useMacTerminalCustomTitleClose?: boolean;
}

export interface TerminalWindowSession {
  close(): void;
}

export interface TerminalWindowsConfig {
  targets: TerminalTarget[];
  options?: ManagedTerminalLaunchOptions & TerminalLaunchOptions;
}

export type LinuxLauncher = (
  target: TerminalTarget,
  shell: string,
  posixCommand: string
) => TerminalLaunchCommand;
