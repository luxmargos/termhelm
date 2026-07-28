# @luxmargos/termhelm

**TermHelm** launches commands in visible windows of the user's native
terminal application on macOS, Windows, and Linux. Use it from Node.js or its
CLI when a command should run in a real desktop terminal instead of a hidden
child process.

## What the name means

**TermHelm** combines “terminal” with “helm”: it opens graphical terminal
windows and gives the caller a reliable way to steer their lifecycle. The name
is platform-neutral; macOS, Windows, and Linux are all first-class targets.

This package is not a terminal emulator, shell, or pseudoterminal. It delegates
to an installed terminal application, so Linux requires a supported graphical
terminal emulator and an active desktop/display session. It is not intended for
headless servers or CI jobs that have no graphical terminal available.

## How it works

1. The CLI or library receives one or more commands, with an optional working
   directory and environment variables.
2. The package selects the native platform backend: Terminal.app on macOS,
   `cmd.exe` with a Job Object controller on Windows, or an installed graphical
   terminal emulator on Linux.
3. Each command opens in a visible terminal window or tab. An omitted `cwd`
   defaults to the current working directory.
4. Plain mode launches the targets and returns a closeable session. Managed mode
   additionally owns each launched process tree, replaces an earlier session by
   its required logical label, and waits for acknowledged shutdown. Window
   titles remain display-only and are never used as process identity.

## Install

```sh
pnpm add @luxmargos/termhelm
```

## CLI

`launch` is the only launch command. Without a label it performs a plain launch:

```sh
termhelm launch --title api --command "pnpm run dev"
```

Adding `--label` selects managed launch behavior:

```sh
termhelm launch \
  --label local-dev \
  --title api \
  --command "pnpm run dev"
```

The same rule applies to config files. `options.label` selects managed behavior;
omitting it selects a plain launch:

```sh
termhelm launch --config termhelm.json
```

Stop an active managed session by its label, either inline or with the same
config file used to launch it:

```sh
termhelm kill --label local-dev
termhelm kill --config termhelm.json
```

`kill` stops the complete managed session for `options.label`; it does not act
on `replaceLabels`. A session can own more than one target process tree, so use
one label per target when independent stop control is required. Plain launches
cannot be killed by label.

Inline `--cwd` is optional and defaults to the current working directory. An
explicit value must be non-blank and resolve to an existing directory.

Labels are user-global by default. To isolate the same label by project, select
project scope. `--project-root` is optional in inline mode; when omitted, the
resolved `--cwd` is used, including its current-working-directory default:

```sh
termhelm launch \
  --label local-dev \
  --label-scope project \
  --title api \
  --command "pnpm run dev"
```

Use the same scope to kill that session:

```sh
termhelm kill --label local-dev --label-scope project
```

An explicit `--project-root` takes precedence over `--cwd`. It must resolve to
an existing directory.

Use `termhelm --help` for all inline target flags.

## Config

```json
{
  "targets": [
    {
      "title": "api",
      "cwd": ".",
      "command": "pnpm run dev",
      "env": {
        "NODE_ENV": "development"
      },
      "exitMessage": "The api process exited."
    }
  ],
  "options": {
    "label": "local-dev",
    "labelScope": {
      "type": "project",
      "root": "."
    },
    "replaceLabels": ["legacy-local-dev"],
    "shutdownDelayMs": 2500,
    "closeWaitTimeoutMs": 6000,
    "replaceTimeoutMs": 11500,
    "exitAfterCommand": true
  }
}
```

Project-scope roots remain required in config files and library options. A
config root is resolved relative to the config file; a library root and an
explicit inline `--project-root` are resolved relative to `process.cwd()`. Every
root is canonicalized and must already exist.

`replaceLabels` contains only additional labels. The session's own `label` is
always replaced automatically, so do not repeat it. Labels are normalized to
Unicode NFC, remain case-sensitive, and cannot be blank or contain surrounding
whitespace.

Managed defaults are:

- `labelScope`: `{ "type": "user" }`
- `replaceLabels`: `[]`
- `shutdownDelayMs`: `2500`
- `closeWaitTimeoutMs`: `6000`
- `replaceTimeoutMs`: `shutdownDelayMs + closeWaitTimeoutMs + 3000`
- `exitAfterCommand`: `true`

A config without `options.label` launches in plain mode. Managed-only options
such as `labelScope`, `replaceLabels`, and managed timeouts require a label so a
missing label can never silently downgrade a managed launch to plain behavior.

`shutdownDelayMs` is the graceful-stop period before escalation.
`closeWaitTimeoutMs` is the following forced-stop confirmation period.
After platform backend preflight, `replaceTimeoutMs` bounds the complete locked
replacement attempt across all selected labels; reaching it without
authoritative confirmation leaves the old record in place and rejects the new
launch. `kill --config` also uses `replaceTimeoutMs` as its stop deadline. Timeout
values must be whole milliseconds from `0` through `2147483647` on every
platform. When `replaceTimeoutMs` is omitted, the derived default must also fit
within that range.

## Library

```ts
import {
  killManagedTerminalWindows,
  launchManagedTerminalWindows,
  launchTerminalWindows,
  startManagedTerminalWindows
} from '@luxmargos/termhelm';

launchTerminalWindows([
  {
    title: 'api',
    command: 'pnpm run dev'
  }
]);

const session = startManagedTerminalWindows(
  [
    {
      title: 'api',
      command: 'pnpm run dev'
    }
  ],
  { label: 'local-dev' }
);

await session.ready;
const result = await session.close();
console.log(result.reason, result.forcedTargetIds, result.warnings);

const killResult = await killManagedTerminalWindows('another-session');
console.log(killResult.status);
```

Library target `cwd` values are optional and default to the canonical current
working directory, matching inline CLI mode. An explicit value must be
non-blank and resolve to an existing directory.

`startManagedTerminalWindows()` returns a session immediately. Its `ready`
promise resolves only after every target controller reports ready; `close()` is
idempotent and resolves after shutdown is confirmed. `closed` observes the same
final result.

`launchManagedTerminalWindows(targets, options)` is the long-running convenience
wrapper used by managed CLI launches. Its `options` argument and `options.label`
are required; invalid labels throw before any registry, filesystem, replacement,
or process operation.

`killManagedTerminalWindows(label, options)` stops the authenticated managed
session currently owned by that label and returns `killed` or `not-found`.
`options.timeoutMs` defaults to 11,500 ms. The operation participates in the
same generation ordering as launch, so it supersedes older
queued launches without using a saved PID, terminal title, or generic OS kill
command.

## Managed Process Guarantees

- Replacement is fail-closed: a new same-label session does not launch until
  the previous owned process trees acknowledge shutdown.
- Labels select authenticated session records. Titles and saved PIDs are not
  termination authority.
- Per-user records, recovery markers, and sorted per-label locks are written
  atomically. Controllers authenticate over a private Unix socket on macOS and
  Linux or a named pipe on Windows; losing that supervisor connection requests
  controller cleanup.
- On Windows the runtime root is created with, or revalidated against, a
  protected current-user-and-SYSTEM-only DACL before any record or secret is
  written. A pre-existing root with weaker or ambiguous permissions is rejected
  rather than repaired. Named-pipe requests still require the per-session
  authentication token; pipe names and saved PIDs never grant authority.
- Each contender allocates an immutable, runtime-global filesystem ticket and
  publishes that generation in its per-label intents before waiting for locks.
  Older delayed contenders self-cancel, so concurrent launches settle on the
  newest registered request without overlapping process trees.
- Windows probes the bundled PowerShell Job Object controller with `pwsh`, then
  Windows PowerShell 5.1 (`powershell.exe`), before any target starts. The first
  host to pass the ownership self-test is the only host used for that launch.
  The controller script must resolve inside the canonical package root and
  deletes its secret-bearing structural payload before compiling or launching
  the target. macOS and Linux use distinct process groups plus a bundled Node
  control sidecar, with graceful termination followed by forced termination
  when necessary. On POSIX, only the live group-leader controller may signal
  its own group; after it exits, the wrapper only observes group emptiness and
  fails closed if identity is ambiguous. A terminal `stopped` or `failed`
  marker is published only after that emptiness check, so diagnostic controller
  failure cannot authorize replacement early.
- Managed shutdown owns the fallback shell when `exitAfterCommand` is explicitly
  `false`. On POSIX that fallback is a pipe-fed login shell so it cannot move
  itself into an unowned process group. It accepts commands and remains owned,
  but intentionally has no interactive prompt, line editing, or job control.
- Terminal-window cleanup is best-effort. Linux guarantees process-group cleanup,
  not emulator-window disappearance. On macOS UI cleanup verifies captured
  window/TTY identity and never falls back to title matching.
- On POSIX systems, descendants that deliberately escape their process group
  with `setsid()` are outside the portable ownership guarantee.

PowerShell host selection is allowed only before a target may have started. If
an already selected host starts the controller but does not produce an
authenticated terminal acknowledgement, the launch fails closed and no second
host is attempted. This prevents an uncertain launch from running the same
target twice. Failure of every pre-launch probe also rejects the launch without
using `taskkill`, window titles, or saved PIDs.

If launch of one target in a multi-target session fails, already-started targets
are rolled back and their shutdown is confirmed before the launch rejects.
Plain launch mode shares validation and partial rollback hardening, but only
managed mode publishes authenticated, acknowledged process-tree ownership.

Lock ownership is never reclaimed from a saved PID. If a process crashes while
holding a launch lock, the next launch fails closed with manual-cleanup guidance
instead of risking an ABA race. Crashed-session recovery directories may also be
retained conservatively after their exact record is removed. Generation ticket
directories are intentionally permanent and must not be pruned or reused. The
latest per-label launch intent is also retained as a durable high-water fence;
only a newer locked contender may prune it.

## Migrating from 0.1.x

The package is now named `@luxmargos/termhelm`. Replace the previous dependency
and import path with this name, and invoke the CLI as `termhelm`.

Version `0.2.0` intentionally removes the implicit `"terminal-windows"` managed
label. Pass `{ label: "..." }` to every managed library call, add
`options.label` to managed config files, or pass `--label` to `termhelm launch`.

`replaceLabels` now clearly means additional labels; the current label is always
included by the manager. The unsafe title-based macOS close option and public
supervisor PID/token fields were removed. Version 0.1.x has no authenticated
process-tree acknowledgement, so every extant legacy registry entry requires
manual migration: stop the old supervisor and its targets, remove that legacy
entry, then retry. Version 0.2.0 never signals through its saved PID.

## Platform Support

- macOS: Terminal.app through `osascript`, with controller-owned process groups.
- Windows: `cmd.exe` under the bundled PowerShell Job Object controller (`pwsh`
  first, then Windows PowerShell 5.1).
- Linux: `$TERMINAL`, `gnome-terminal`, `konsole`, `xfce4-terminal`,
  `mate-terminal`, `lxterminal`, `xterm`, or `x-terminal-emulator`, with
  controller-owned process groups.

## Release Packaging

The published package contains
`native/windows/termhelm-controller.ps1`. `prepack` builds TypeScript and
strictly verifies that this controller exists, is a regular non-symlink file,
contains the required payload-deletion and Job Object implementation fragments,
and is included by `package.json`.

CI runs tests on Ubuntu, macOS, and Windows. Windows CI exercises the controller
self-test with both PowerShell Core and Windows PowerShell 5.1, and the package
job checks that the final npm archive contains the controller script.

Hosted CI mocks the identity-checked Terminal.app UI close. To opt into the real
Terminal.app identity/close check on an interactive macOS host, grant Terminal
automation permission and run:

```sh
TERMHELM_MANUAL_MACOS=1 pnpm exec vitest run test/macos-terminal.manual.test.ts
```

## License

MIT
