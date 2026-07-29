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
   its required logical label, and waits for acknowledged shutdown. Window
   titles remain display-only and are never used as process identity.

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

A config without `options.label` launches in plain mode. `autoClose` and
`exitAfterCommand` work in both plain and managed modes. Managed-only options
such as `labelScope`, `replaceLabels`, and managed timeouts require a label so a
missing label can never silently downgrade a managed launch to plain behavior.

When `autoClose` is `true`, TermHelm requests terminal UI closure only after
authoritative completion of the owned process tree. On macOS it waits for the
exact captured window-ID/TTY window to become idle and closes it only while it
still contains the one owned tab; a window containing additional tabs is left
open to avoid collateral closure. It never selects by title. Plain-launch
macOS auto-close is delegated to a detached controller watcher, so it still
works after the process that called `launchTerminalWindows()` exits. On Linux
and Windows, final window disappearance remains subject to the terminal host's
native completed-command behavior.

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

const managedSession = startManagedTerminalWindows(targets, {
  label: '<SESSION_LABEL>',
  autoClose: true
});

await managedSession.ready;
const closeResult = await managedSession.close();
console.log(closeResult.reason, closeResult.forcedTargetIds, closeResult.warnings);
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

`startManagedTerminalWindows()` returns a session immediately. Its `ready`
promise resolves only after every target controller reports ready; `close()` is
idempotent and resolves after shutdown is confirmed. `closed` observes the same
final result.

`launchManagedTerminalWindows(targets, options)` is the long-running convenience
wrapper used by managed CLI launches. Its `options` argument and `options.label`
are required; invalid labels throw before any registry, filesystem, replacement,
or process operation.

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
- Automatic terminal-window closure is opt-in through `autoClose`; completed UI
  remains open by default for inspection. Linux guarantees process-group cleanup,
  not disappearance for every emulator implementation. Descendants that leave
  the owned POSIX process group are outside the portable ownership guarantee.

Plain launches use the same target validation and partial-launch rollback, but
only managed launches publish authenticated label ownership and support
label-based replacement or shutdown.

## Realistic nested demo

The tracked demo mirrors a local `fresh` workflow without containers: a plain
terminal launches a managed supervisor, which launches HTTP, web, event-stream,
and parent/child worker daemons in separate terminals. A second plain terminal
performs health checks.

```sh
pnpm run demo:managed:fresh
# Run it again to exercise authenticated replacement and auto-close.
pnpm run demo:managed:fresh
pnpm run demo:managed:kill
```

Use `pnpm run demo:managed:smoke` for the non-GUI daemon contract check. See
`examples/managed-launch/README.md` for details.

## Platform Support

- macOS: Terminal.app through `osascript`, with controller-owned process groups.
- Windows: `cmd.exe` under the bundled PowerShell Job Object controller (`pwsh`
  first, then Windows PowerShell 5.1).
- Linux: `$TERMINAL`, `gnome-terminal`, `konsole`, `xfce4-terminal`,
  `mate-terminal`, `lxterminal`, `xterm`, or `x-terminal-emulator`, with
  controller-owned process groups.

## License

MIT
