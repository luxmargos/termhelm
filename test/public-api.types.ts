import type {
  ManagedTerminalCloseResult,
  ManagedTerminalKillOptions,
  ManagedTerminalKillResult,
  ManagedTerminalLaunchOptions,
  ManagedTerminalSession,
  TerminalLaunchOptions,
  TerminalTarget
} from '../src/index.js';
import {
  killManagedTerminalWindows,
  launchManagedTerminalWindows,
  startManagedTerminalWindows
} from '../src/index.js';

// @ts-expect-error Controller metadata is intentionally absent from the public entry point.
import type { InternalTerminalLaunchOptions } from '../src/index.js';
// @ts-expect-error Internal supervised shell construction is not a root export.
import { buildSupervisedPosixCommand } from '../src/index.js';
// @ts-expect-error Internal controller-aware POSIX construction is not a root export.
import { buildPosixCommand } from '../src/index.js';

const target: TerminalTarget = { title: 'api', command: 'pnpm dev' };
const options: ManagedTerminalLaunchOptions = { label: 'dev', autoClose: true };
const plainOptions: TerminalLaunchOptions = { autoClose: true, exitAfterCommand: true };
const session: ManagedTerminalSession = startManagedTerminalWindows([target], options);
const ready: Promise<void> = session.ready;
const closed: Promise<ManagedTerminalCloseResult> = session.closed;
const closeResult: Promise<ManagedTerminalCloseResult> = session.close();
const wrapperResult: Promise<void> = launchManagedTerminalWindows([target], options);
const killOptions: ManagedTerminalKillOptions = { timeoutMs: 5_000 };
const killResult: Promise<ManagedTerminalKillResult> = killManagedTerminalWindows('dev', killOptions);

// @ts-expect-error A managed label has no fallback.
const missingLabel: ManagedTerminalLaunchOptions = {};
// @ts-expect-error Managed calls require the options argument.
startManagedTerminalWindows([target]);
// @ts-expect-error Managed calls require the options argument.
launchManagedTerminalWindows([target]);
// @ts-expect-error Unsafe title-based macOS close behavior was removed.
const unsafeManagedOption: ManagedTerminalLaunchOptions = { label: 'dev', useMacTerminalCustomTitleClose: true };
// @ts-expect-error Supervisor PIDs are internal diagnostic/controller metadata.
const unsafePidOption: TerminalLaunchOptions = { supervisorPid: 123 };
// @ts-expect-error Shutdown tokens are internal controller metadata.
const unsafeTokenOption: TerminalLaunchOptions = { shutdownTokenPath: '/tmp/alive' };

void plainOptions;
void ready;
void closed;
void closeResult;
void wrapperResult;
void killOptions;
void killResult;
void missingLabel;
void unsafeManagedOption;
void unsafePidOption;
void unsafeTokenOption;
