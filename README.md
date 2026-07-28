# @luxmargos/terminal-windows

Open commands in native terminal windows from Node.js or a CLI. Managed mode
owns each launched process tree, replaces earlier sessions by a required logical
label, and waits for acknowledged shutdown. Window titles are display-only and
are never used to choose a process or window to terminate.

## Install

```sh
pnpm add @luxmargos/terminal-windows
```

## CLI

Run a JSON config in plain launch mode:

```sh
terminal-windows launch --config terminal-windows.json
```

Managed config mode requires `options.label` in the config:

```sh
terminal-windows managed --config terminal-windows.json
```

Inline managed mode requires `--label`:

```sh
terminal-windows managed \
  --label local-dev \
  --title api \
  --command "pnpm run dev"
```

Inline `--cwd` is optional and defaults to the current working directory. An
explicit value must be non-blank and resolve to an existing directory.

Labels are user-global by default. To isolate the same label by project, select
project scope. `--project-root` is optional in inline mode; when omitted, the
resolved `--cwd` is used, including its current-working-directory default:

```sh
terminal-windows managed \
  --label local-dev \
  --label-scope project \
  --title api \
  --command "pnpm run dev"
```

An explicit `--project-root` takes precedence over `--cwd`. It must resolve to
an existing directory.

Use `terminal-windows --help` for all inline target flags.

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

Plain config mode does not require a label.

`shutdownDelayMs` is the graceful-stop period before escalation.
`closeWaitTimeoutMs` is the following forced-stop confirmation period.
After platform backend preflight, `replaceTimeoutMs` bounds the complete locked
replacement attempt across all selected labels; reaching it without
authoritative confirmation leaves the old record in place and rejects the new
launch. Timeout values must be whole milliseconds from `0` through
`2147483647` on every platform.

## Library

```ts
import {
  launchManagedTerminalWindows,
  launchTerminalWindows,
  startManagedTerminalWindows
} from '@luxmargos/terminal-windows';

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
```

Library target `cwd` values are optional and default to the canonical current
working directory, matching inline CLI mode. An explicit value must be
non-blank and resolve to an existing directory.

`startManagedTerminalWindows()` returns a session immediately. Its `ready`
promise resolves only after every target controller reports ready; `close()` is
idempotent and resolves after shutdown is confirmed. `closed` observes the same
final result.

`launchManagedTerminalWindows(targets, options)` is the long-running convenience
wrapper used by the CLI. Its `options` argument and `options.label` are required;
invalid labels throw before any registry, filesystem, replacement, or process
operation.

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
- Windows first probes the architecture-matched native Job Object controller.
  If that helper is missing, invalid, or cannot pass its pre-launch self-test,
  runtime selection tries the bundled PowerShell Job Object controller with
  `pwsh`, then Windows PowerShell 5.1 (`powershell.exe`). Default controller
  assets must resolve inside the canonical package root; only an explicit
  absolute native-helper override may select an external file. The PowerShell
  controller deletes its secret-bearing structural payload before compiling or
  launching the target. macOS and Linux use
  distinct process groups plus a bundled Node control sidecar, with graceful
  termination followed by forced termination when necessary. On POSIX, only the live
  group-leader controller may signal its own group; after it exits, the wrapper
  only observes group emptiness and fails closed if identity is ambiguous. A
  terminal `stopped` or `failed` marker is published only after that emptiness
  check, so diagnostic controller failure cannot authorize replacement early.
- Managed shutdown owns the fallback shell when `exitAfterCommand` is explicitly
  `false`. On POSIX that fallback is a pipe-fed login shell so it cannot move
  itself into an unowned process group. It accepts commands and remains owned,
  but intentionally has no interactive prompt, line editing, or job control.
- Terminal-window cleanup is best-effort. Linux guarantees process-group cleanup,
  not emulator-window disappearance. On macOS UI cleanup verifies captured
  window/TTY identity and never falls back to title matching.
- On POSIX systems, descendants that deliberately escape their process group
  with `setsid()` are outside the portable ownership guarantee.

Windows backend fallback is allowed only before a target may have started. If a
selected controller starts but does not produce an authenticated terminal
acknowledgement, the launch fails closed and no second backend is attempted.
This prevents an uncertain native attempt and a fallback attempt from running
the same target concurrently. Failure of every pre-launch probe also rejects
the launch without using `taskkill`, window titles, or saved PIDs.

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

Version `0.2.0` intentionally removes the implicit `"terminal-windows"` managed
label. Pass `{ label: "..." }` to every managed library call, add
`options.label` to managed config files, or use `--label` for inline managed CLI
usage.

`replaceLabels` now clearly means additional labels; the current label is always
included by the manager. The unsafe title-based macOS close option and public
supervisor PID/token fields were removed. Version 0.1.x has no authenticated
process-tree acknowledgement, so every extant legacy registry entry requires
manual migration: stop the old supervisor and its targets, remove that legacy
entry, then retry. Version 0.2.0 never signals through its saved PID.

## Platform Support

- macOS: Terminal.app through `osascript`, with controller-owned process groups.
- Windows: `cmd.exe` under the preferred bundled MSVC-built x64/arm64 Job Object
  controller, with a bundled PowerShell Job Object controller as a pre-launch
  fallback (`pwsh` first, then Windows PowerShell 5.1).
- Linux: `$TERMINAL`, `gnome-terminal`, `konsole`, `xfce4-terminal`,
  `mate-terminal`, `lxterminal`, `xterm`, or `x-terminal-emulator`, with
  controller-owned process groups.

## Release Packaging

Windows helper binaries are generated artifacts and are not committed. Build
both from a Windows host with Visual Studio 2022 C++ build tools for x64 and
ARM64. The npm command prefers `pwsh` and falls back to the built-in Windows
PowerShell 5.1 (`powershell.exe`) only when `pwsh` is unavailable:

```powershell
pnpm run build:windows-helper -- -Architecture x64
pnpm run build:windows-helper -- -Architecture arm64
pnpm run verify:windows-helpers
```

That build-shell fallback is separate from runtime controller fallback: a real
MSVC build failure is reported rather than retried through another shell.

`prepack` builds TypeScript and refuses to create an official release unless
both PE helpers exist at the runtime paths under `native/win32-x64` and
`native/win32-arm64`. The published package also contains
`native/windows/terminal-windows-controller.ps1`, so an installed package can
fall back when its native helper is unavailable or fails its self-test. CI runs
tests on Ubuntu, macOS, and Windows, builds both helper architectures on
Windows, exercises the native and PowerShell self-tests, downloads the helpers
into one packaging job, and checks that the final npm archive contains both
executables and the fallback script. The Windows host test also compiles the
x64 helper directly with Windows PowerShell 5.1.

Hosted CI mocks the identity-checked Terminal.app UI close. To opt into the real
Terminal.app identity/close check on an interactive macOS host, grant Terminal
automation permission and run:

```sh
TERMINAL_WINDOWS_MANUAL_MACOS=1 pnpm exec vitest run test/macos-terminal.manual.test.ts
```

## License

MIT
