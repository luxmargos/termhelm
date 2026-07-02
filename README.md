# @luxmargos/terminal-windows

Open commands in native terminal windows from Node.js or a CLI.

## Install

```sh
pnpm add @luxmargos/terminal-windows
```

## CLI

Run a JSON config in plain launch mode:

```sh
terminal-windows launch --config terminal-windows.json
```

Run a JSON config in managed mode. Managed mode keeps child terminal commands tied to the supervisor process and replaces previous supervisors with the same label.

```sh
terminal-windows managed --config terminal-windows.json
```

Run a single command without a config file:

```sh
terminal-windows launch --title api --cwd . --command "pnpm run dev"
```

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
      "exitMessage": "The api process exited. Type exit to close this terminal."
    }
  ],
  "options": {
    "label": "local-dev",
    "replaceLabels": ["local-dev"],
    "shutdownDelayMs": 2500,
    "closeWaitTimeoutMs": 6000,
    "exitAfterCommand": true
  }
}
```

## Library

```ts
import { launchManagedTerminalWindows, launchTerminalWindows } from '@luxmargos/terminal-windows';

launchTerminalWindows([
  {
    title: 'api',
    cwd: process.cwd(),
    command: 'pnpm run dev'
  }
]);

await launchManagedTerminalWindows(
  [
    {
      title: 'api',
      cwd: process.cwd(),
      command: 'pnpm run dev'
    }
  ],
  { label: 'local-dev' }
);
```

## Platform Support

- macOS: Terminal.app through `osascript`.
- Windows: `cmd.exe`, PowerShell, and `taskkill` for cleanup.
- Linux: `$TERMINAL`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `mate-terminal`, `lxterminal`, `xterm`, or `x-terminal-emulator`.

## License

MIT
