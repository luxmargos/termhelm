# @luxmargos/termhelm

**TermHelm** launches commands in visible windows of the user's native
terminal application on macOS, Windows, and Linux. Use it from Node.js or its
CLI when a command should run in a real desktop terminal instead of a hidden
child process.

TermHelm is not a terminal emulator, shell, or pseudoterminal. It delegates to
an installed terminal application, so Linux requires a supported graphical
terminal emulator and an active desktop/display session. It is not intended for
headless servers or CI jobs without a graphical terminal.

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
   its required logical label, and waits for acknowledged shutdown. Detached
   managed mode keeps that ownership in a hidden supervisor while the invoking
   npm/CLI process returns after readiness. Window titles remain display-only
   and are never used as process identity.

## Install

TermHelm is intended primarily for development and testing workflows. Installing
it as a project development dependency is therefore the recommended default. A
regular dependency is fully supported when application code imports TermHelm at
runtime. Choose the installation pattern that matches your project.

### Project development dependency

| Package manager | Command |
| --- | --- |
| npm | `npm install --save-dev @luxmargos/termhelm` |
| pnpm | `pnpm add --save-dev @luxmargos/termhelm` |
| Yarn | `yarn add --dev @luxmargos/termhelm` |
| Bun | `bun add --dev @luxmargos/termhelm` |

### Project dependency

| Package manager | Command |
| --- | --- |
| npm | `npm install @luxmargos/termhelm` |
| pnpm | `pnpm add @luxmargos/termhelm` |
| Yarn | `yarn add @luxmargos/termhelm` |
| Bun | `bun add @luxmargos/termhelm` |

### Global CLI

Use a global installation when the `termhelm` command should be available
outside a specific project.

| Package manager | Command |
| --- | --- |
| npm | `npm install --global @luxmargos/termhelm` |
| pnpm | `pnpm add --global @luxmargos/termhelm` |
| Yarn Classic | `yarn global add @luxmargos/termhelm` |
| Bun | `bun add --global @luxmargos/termhelm` |

## CLI

Display the complete command and option reference with:

```sh
termhelm --help
```

Print the installed package version with:

```sh
termhelm --version
termhelm -V
```

`--version`/`-V` is accepted before or alongside a command (`termhelm launch
--version`) and takes precedence over the command payload. The version is read
from the packaged `package.json` next to the compiled CLI.

The examples below use descriptive placeholders:

- `<TERMINAL_WINDOW_TITLE>`: the visible terminal window or tab title.
- `<LONG_RUNNING_COMMAND>`: the development or test command to run.
- `<SESSION_LABEL>`: the stable identity of a managed session.
- `<ADDITIONAL_SESSION_LABEL>`: another managed session replaced by a launch.
- `<WORKING_DIRECTORY>`: an existing directory for the command.
- `<PROJECT_ROOT>`: an existing root used to scope a label to one project.
- `<CONFIG_FILE>`: the path to a TermHelm JSON configuration file.
- `<ENVIRONMENT_VARIABLE>` and `<VALUE>`: an environment entry for the command.
- `<EXIT_MESSAGE>`: text displayed after the command exits.

Replace every placeholder, including its angle brackets, with a real value.

### Plain launch

A launch without a label starts commands without publishing a managed label:

```sh
termhelm launch \
  --title "<TERMINAL_WINDOW_TITLE>" \
  --cwd "<WORKING_DIRECTORY>" \
  --command "<LONG_RUNNING_COMMAND>"
```

`--cwd` is optional and defaults to the current working directory.

### Managed launch

Adding a label enables managed replacement and label-based shutdown:

```sh
termhelm launch \
  --label "<SESSION_LABEL>" \
  --title "<TERMINAL_WINDOW_TITLE>" \
  --cwd "<WORKING_DIRECTORY>" \
  --command "<LONG_RUNNING_COMMAND>"
```

For example:

```sh
termhelm launch \
  --label "local-api" \
  --title "API development server" \
  --command "pnpm run dev"
```

The default managed launch is foreground and remains alive as the process-tree
supervisor. Add `--detach` when an npm script must continue after replacement
and target readiness succeed:

```sh
termhelm launch \
  --detach \
  --label "local-api" \
  --title "API development server" \
  --command "pnpm run dev"
```

The supervisor is hidden; only the requested target terminal windows are shown.
`--detach` requires a managed label and is invalid for plain launch and `kill`.
For a config launch, either use `termhelm launch --detach --config <path>` or set
its top-level `detached` field.

An npm sequence can therefore advance without abandoning singleton replacement:

```json
{
  "scripts": {
    "terminals": "termhelm launch --detach --config termhelm.json",
    "after-terminals": "node ./scripts/after-terminals.mjs",
    "dev": "npm run terminals && npm run after-terminals"
  }
}
```

### Config file

`options.label` selects managed behavior in a config file. Omitting it selects
plain behavior.

```sh
termhelm launch --config "<CONFIG_FILE>"
```

### Stop a managed session

Stop a managed session with its label or the config file used to launch it:

```sh
termhelm kill --label "<SESSION_LABEL>"
termhelm kill --config "<CONFIG_FILE>"
```

`kill` stops the complete session identified by `options.label`; it does not act
on `replaceLabels`. Use one label per target when targets require independent
stop control. Plain launches cannot be killed by label.

### Project-scoped labels

Labels are user-global by default. Project scope allows the same label to be
used independently by different projects:

```sh
termhelm launch \
  --label "<SESSION_LABEL>" \
  --label-scope project \
  --project-root "<PROJECT_ROOT>" \
  --title "<TERMINAL_WINDOW_TITLE>" \
  --command "<LONG_RUNNING_COMMAND>"
```

Use the same scope and root when stopping the session:

```sh
termhelm kill \
  --label "<SESSION_LABEL>" \
  --label-scope project \
  --project-root "<PROJECT_ROOT>"
```

For `launch`, an omitted `--project-root` uses the resolved `--cwd`, which itself
defaults to the current working directory. For `kill`, an omitted project root
uses the current working directory. An explicit project root takes precedence
and must already exist.

## Config

```json
{
  "detached": true,
  "targets": [
    {
      "title": "<TERMINAL_WINDOW_TITLE>",
      "cwd": "<WORKING_DIRECTORY>",
      "command": "<LONG_RUNNING_COMMAND>",
      "env": {
        "<ENVIRONMENT_VARIABLE>": "<VALUE>"
      },
      "exitMessage": "<EXIT_MESSAGE>"
    }
  ],
  "options": {
    "label": "<SESSION_LABEL>",
    "labelScope": {
      "type": "project",
      "root": "<PROJECT_ROOT>"
    },
    "replaceLabels": ["<ADDITIONAL_SESSION_LABEL>"],
    "autoClose": false,
    "shutdownDelayMs": 2500,
    "closeWaitTimeoutMs": 6000,
    "replaceTimeoutMs": 11500,
    "exitAfterCommand": true
  }
}
```

Replace the placeholder strings with values appropriate for your project.

Project-scope roots remain required in config files and library options. A
config root is resolved relative to the config file; a library root and an
explicit inline `--project-root` are resolved relative to `process.cwd()`. Every
root is canonicalized and must already exist.

`replaceLabels` contains only additional labels. The session's own `label` is
always replaced automatically, so do not repeat it. Labels are normalized to
Unicode NFC, remain case-sensitive, and cannot be blank or contain surrounding
whitespace.

Shared launch defaults are:

- `autoClose`: `false`

Managed defaults are:

- `labelScope`: `{ "type": "user" }`
- `replaceLabels`: `[]`
- `shutdownDelayMs`: `2500`
- `closeWaitTimeoutMs`: `6000`
- `replaceTimeoutMs`: `shutdownDelayMs + closeWaitTimeoutMs + 3000`
- `exitAfterCommand`: `true`

A config without `options.label` launches in plain mode. Top-level `detached`
defaults to `false`, must be a boolean, and can be `true` only when
`options.label` is present. It controls CLI orchestration rather than managed
launch options; the library selects the same behavior by calling the detached
function. `autoClose` and `exitAfterCommand` work in both plain and managed
modes. Managed-only options such as `labelScope`, `replaceLabels`, and managed
timeouts require a label so a missing label can never silently downgrade a
managed launch to plain behavior.

`autoClose` controls terminal UI separately from process-tree termination.
When it is `true`, TermHelm requests closure only after authoritative completion;
when it is `false`, TermHelm never actively closes UI and asks capable Linux
hosts to hold the completed window open. It never selects UI by title.

UI results are reported per target as `closed`, `preserved`, `host-managed`,
`refused-shared`, `cancelled`, or `unsupported`. macOS uses the exact captured
window-ID/TTY and refuses a window containing additional tabs. Exact-process
Linux adapters can report closure, while daemonized/multiplexed terminals and
Windows console-host policy may report `host-managed`. Plain macOS also retains
a detached watcher so requested closure can continue if the original caller
exits.

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
  launchDetachedManagedTerminalWindows,
  launchTerminalWindows,
  startManagedTerminalWindows
} from '@luxmargos/termhelm';

const targets = [
  {
    title: '<TERMINAL_WINDOW_TITLE>',
    cwd: '<WORKING_DIRECTORY>',
    command: '<LONG_RUNNING_COMMAND>'
  }
];

const plainSession = launchTerminalWindows(targets, {
  autoClose: false
});

// Later, when the plain session is no longer needed:
plainSession.close();
const plainResult = await plainSession.closed;
console.log(plainResult.uiCloseResults, plainResult.warnings);

const managedSession = startManagedTerminalWindows(targets, {
  label: '<SESSION_LABEL>',
  autoClose: true
});

await managedSession.ready;
const closeResult = await managedSession.close();
console.log(
  closeResult.reason,
  closeResult.forcedTargetIds,
  closeResult.uiCloseResults,
  closeResult.warnings
);

// For a short-lived npm/Node launcher, transfer supervision to a hidden child.
const detached = await launchDetachedManagedTerminalWindows(targets, {
  label: '<SESSION_LABEL>',
  autoClose: true
});
console.log(detached.label, detached.sessionId);
// This process may now exit; use killManagedTerminalWindows(detached.label)
// from this or another process when the session should stop.
```

To stop an active managed session from another process:

```ts
import { killManagedTerminalWindows } from '@luxmargos/termhelm';

const killResult = await killManagedTerminalWindows('<SESSION_LABEL>');
console.log(killResult.status);
```

Library target `cwd` values are optional and default to the canonical current
working directory, matching inline CLI mode. An explicit value must be
non-blank and resolve to an existing directory.

`launchTerminalWindows()` returns a plain session whose `closed` promise settles
after every target reaches authoritative terminal completion. Its result contains
per-target UI outcomes and warnings; callers can still use the backward-compatible
synchronous `close()` request.

`startManagedTerminalWindows()` returns a session immediately. Its `ready`
promise resolves only after every target controller reports ready; `close()` is
idempotent and resolves after shutdown is confirmed. `closed` observes the same
final result, including forced target IDs and per-target UI outcomes.

`launchManagedTerminalWindows(targets, options)` is the long-running foreground
convenience wrapper. Its `options` argument and `options.label` are required;
invalid labels throw before any registry, filesystem, replacement, or process
operation.

`launchDetachedManagedTerminalWindows(targets, options)` starts a hidden,
stdio-isolated supervisor and resolves with `{ label, sessionId }` only after the
existing same-label session has stopped and every new target has acknowledged
readiness. Inputs are validated before spawning and again in the child; commands
and target environment values travel over a short-lived versioned IPC channel,
not argv. The result is a point-in-time readiness acknowledgement rather than an
in-process session handle. Stop it by authenticated label with
`killManagedTerminalWindows()` or `termhelm kill`.

After the child accepts a valid launch payload, closing or force-ending the
invoking npm terminal does not cancel supervision. Closing target terminals is
observed through the normal managed lifecycle. If the hidden supervisor exits
normally or abruptly, controller-channel/token loss fails closed by stopping
its owned process trees; a later same-label operation uses the existing stale
state recovery rules. OS logout, reboot, and power loss remain subject to native
platform process-session behavior.

A POSIX process terminated by a signal propagates the conventional shell status
`128 + signal number` (`143` for `SIGTERM`). Package managers may still format
their own lifecycle output differently: pnpm can print either a generic
`ELIFECYCLE Command failed.` when pnpm itself is signalled, or include status 143
when it remains alive to observe a child exit. TermHelm preserves the numeric
process status without rewriting third-party output.

`killManagedTerminalWindows(label, options)` stops the authenticated managed
session currently owned by that label and returns `killed` or `not-found`.
`options.timeoutMs` defaults to 11,500 ms. The operation participates in the
same generation ordering as launch, so it supersedes older
queued launches without using a saved PID, terminal title, or generic OS kill
command.

## Managed Process Guarantees

- A managed launch does not replace a same-label session until the previous
  process trees confirm shutdown.
- Labels identify authenticated session records. Window titles and saved process
  IDs are display and diagnostic data, never termination authority.
- Each platform owns the launched workload and attempts graceful shutdown before
  forced termination: Job Objects on Windows and process groups on macOS and
  Linux.
- On Windows, controller selection and its ownership self-test complete before
  targets start. On every platform, an unconfirmed launch fails closed instead
  of relying on window titles or saved process IDs.
- If one target in a multi-target launch fails, TermHelm rolls back targets that
  already started before rejecting the launch.
- Managed fallback shells remain part of the owned process tree. On POSIX they
  accept commands without an interactive prompt, line editing, or job control.
- Automatic terminal-window closure is opt-in through `autoClose`. With it
  disabled, TermHelm never initiates UI closure, but terminals that own their
  native completed-command policy may still report `host-managed`. Linux
  guarantees process-group cleanup, not identical visibility behavior across
  every emulator. Descendants that leave the owned POSIX process group are
  outside the portable ownership guarantee.

Plain launches use the same target validation and partial-launch rollback, but
only managed launches publish authenticated label ownership and support
label-based replacement or shutdown.

### Recovering state left by affected POSIX builds

The 0.2.4 POSIX wrapper can lose its sanitized finalizer payload when a Terminal
window is closed with `SIGHUP`. The owned process group may already be gone while
its session lacks the authoritative `stopped` or `failed` marker, so a later
same-label launch correctly remains fail closed. Updated builds hand sanitized
finalizer state to a detached watcher before target readiness, so finalization
survives Terminal wrapper loss and can reclaim the record, socket, and session
directory after authoritative process-group absence is confirmed.

Existing state created by an affected build cannot be reclaimed automatically
from a stale socket, saved PID, or `runner-complete` file alone: none proves that
every owned descendant has terminated. First stop all TermHelm managed sessions
for the current user and verify that no managed supervisor, POSIX sidecar, or
owned workload remains. Only then may a macOS/Linux operator reset that user's
version-2 runtime state:

```sh
runtime_directory="/tmp/termhelm-$(id -u)-v2"
rm -rf -- "$runtime_directory"
```

Do not run this command while any managed label for the user is active. Prefer
`termhelm kill --label "<SESSION_LABEL>"` when authenticated shutdown still
works; manual removal is only recovery for already-unconfirmable affected state.
A stale endpoint by itself never authorizes automatic replacement.

## Managed launch examples

The tracked demo mirrors a local `fresh` workflow without containers. Its
default flow uses `launchDetachedManagedTerminalWindows()` to launch HTTP, web,
event-stream, and parent/child worker daemons in separate terminals while a
hidden supervisor retains ownership. After readiness, `fresh` opens a health
monitor terminal and exits, so it can be followed by another npm script.

```sh
pnpm run demo:managed:fresh
# Run it again to exercise detached replacement and auto-close.
pnpm run demo:managed:fresh
pnpm run demo:managed:kill
```

Use `pnpm run demo:managed:foreground` to compare the intentionally blocking
`launchManagedTerminalWindows()` flow. Use `pnpm run demo:managed:smoke` for the
non-GUI daemon contract check. See `examples/managed-launch/README.md` for details.

## Platform Support

| Platform | Supported host | Notes |
| --- | --- | --- |
| macOS | Terminal.app | Exact window-ID/TTY identity; single-tab auto-close only. |
| Windows | Dedicated `cmd.exe` console under PowerShell Job Object control | Requires `pwsh` or Windows PowerShell 5.1 to pass the bundled self-test. Default plain and managed state live below the current user's `LOCALAPPDATA` and use owner/SYSTEM-only inheritable DACLs. UTF-8 commands and literal `%` paths are supported. |
| Linux | GNOME Terminal, Konsole, XFCE Terminal, xterm | Requires `bash` or `zsh` on `PATH` for the private controller wrapper; the target command still uses the user's login shell. |

On Linux, `x-terminal-emulator` is accepted only when its resolved executable is
one of the verified adapters above. An explicit unknown `$TERMINAL` fails closed
instead of receiving guessed `-e` flags. MATE Terminal and LXTerminal are
provisional pending native acceptance, and KGX remains experimental. Controller
payloads are private files rather than command-line data, and `ps` is resolved
through `PATH` for non-FHS systems.

## Test and verification matrix

| Check | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Controller self-test (`-SelfTest`) | N/A | ✅ pwsh 7.6 + powershell.exe 5.1 both exit 0 | N/A |
| `demo:managed:fresh` (end-to-end with visible terminal windows) | ✅ Terminal.app | ✅ pwsh 7 (default) + powershell.exe 5.1 (forced) both produce 4 daemon windows + health monitor; detached supervisor survives launcher exit; health endpoints respond | ✅ xterm/GNOME Terminal/Konsole |
| `npx tsc -p tsconfig.json` (build) | ✅ | ✅ | ✅ |
| `npx vitest run test/platform-controller.test.ts` | ✅ | ✅ | ✅ |
| `npx vitest run test/managed.test.ts` | ✅ | ✅ | ✅ |
| `npx vitest run test/cli.test.ts test/cli-core.test.ts` | ✅ | ✅ | ✅ |
| `npx vitest run test/manager.test.ts` | ✅ | ✅ (some ACL tests skip on non-Win32) | ✅ |
| `pnpm run demo:managed:smoke` (daemon health contract, no GUI) | ✅ | ✅ | ✅ |
| `pnpm run demo:managed:fresh` (4 daemon terminal windows + health monitor) | ✅ Terminal.app tabs | ✅ `cmd.exe` console windows via Job Object controller | ✅ GUI terminal emulator windows |
| `pnpm run demo:managed:fresh` (2nd run, replacement) | ✅ Authenticated replacement | ✅ 500 ms port-release delay + 30 s `replaceTimeoutMs` | ✅ |
| `pnpm run demo:managed:kill` | ✅ `killed` | ✅ `killed` | ✅ `killed` |
| `termhelm reset --label <label> [--force]` (stale session recovery) | ✅ | ✅ Windows `\\.\\pipe` probe + PID liveness | ✅ Unix socket probe + PID liveness |
| `pnpm run verify:release` (full release gate) | ✅ `TERMHELM_MANUAL_MACOS=1` | ✅ PowerShell 5.1 + 7 | ✅ `TERMHELM_LINUX_GUI_TEST=1` + Xvfb |
| `pnpm run test:linux:container` (Docker: build + `demo:managed:*` + native xterm tests under Xvfb) | N/A | N/A | ✅ Debian container with Xvfb + xterm |
| Visible terminal windows persist after launcher exits | ✅ Terminal.app tabs independent | ✅ `AllocConsole` + `CREATE_NEW_CONSOLE` + `SW_SHOWNORMAL`; controller hidden | ✅ `--wait` flag on terminal emulator |
| Graceful shutdown via token removal / Ctrl+Break | ✅ SIGTERM via `osascript` | ✅ `AttachManagedConsole` + `GenerateConsoleCtrlEvent` on demand | ✅ POSIX process-group `SIGTERM`/`SIGKILL` |
| Private directory ACL / permissions | ✅ 0700 dirs, 0600 files | ✅ Owner/SYSTEM-only inheritable DACLs | ✅ 0700 dirs, 0600 files |

### Platform-specific notes

**macOS**: Terminal.app tabs are independent of the Node process, so the
launcher can exit immediately and tabs persist. Window identity uses exact
window ID + TTY, never titles. Single-tab auto-close is supported.

**Windows**: On Windows 11 with ConPTY-backed terminals (VS Code, Windows
Terminal), the controller calls `FreeConsole()` + `AllocConsole()` to detach
from the inherited pseudo-console and allocate a real `conhost`-backed console
before creating each child with `CREATE_NEW_CONSOLE` + `STARTF_USESHOWWINDOW` +
`SW_SHOWNORMAL`. The controller's own console is hidden after the child's window
is created. Managed controllers are held alive by a detached supervisor process;
plain-launched controllers are held alive by the launching process (the
launcher must stay alive, e.g. `await session.closed`).

**Linux**: Requires `bash` or `zsh` on `PATH` for the private controller
wrapper. The target command still uses the user's login shell. `x-terminal-
emulator` is accepted only when its resolved executable is a verified adapter.

## Release verification

No hosted CI is configured. Run the same repository gate natively on each release
OS:

```sh
pnpm run verify:release
```

The gate requires native GUI prerequisites (`TERMHELM_MANUAL_MACOS=1` on macOS;
Xvfb/desktop + xterm + `TERMHELM_LINUX_GUI_TEST=1` on Linux; Windows PowerShell
5.1 and PowerShell 7 on Windows). It performs frozen install, build, public type
checks, the full tracked test inventory, native helper checks, package creation,
manifest validation, installation, import smoke testing, and executable-mode
checks. `pnpm run verify:release:headless` is useful during development but is
not release evidence.

### Linux container acceptance

`pnpm run test:linux:container` builds a Debian-based Docker image
(`docker/linux/Dockerfile`) with Xvfb and xterm, then runs the `demo:managed:*`
scripts and the native Linux xterm integration tests inside it under a virtual
display. It is the fastest way to exercise the Linux managed lifecycle
(detached launch, authenticated replacement, kill) without a host desktop. The
`demo:managed:fresh` flow is interactive by design (it awaits the user closing
the health-monitor terminal), so the container entrypoint
(`docker/linux/test-managed.sh`) closes that monitor window itself once the
managed daemons are healthy.

Manual release sign-off must additionally cover Windows Terminal and legacy
Console Host plus GNOME Wayland/Xorg, KDE Konsole, and XFCE Terminal. Record UI
outcomes and confirm no title-based selection, collateral shared-window closure,
owned descendants, or authenticated state remain after failure.

## License

MIT
