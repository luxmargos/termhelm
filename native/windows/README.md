# Windows PowerShell controller

`termhelm-controller.ps1` launches each command in a Windows Job Object
configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. It retains process and Job
handles, so process IDs are never reused as termination authority.

The command is created suspended and assigned to the Job Object before it can
run. The controller then attaches to that command's dedicated console, sends a
console-wide Ctrl+Break for graceful shutdown, and escalates through the
retained Job handle only when the Job does not become empty.

Before any target starts, termhelm resolves this script from the canonical
package root and runs its `-SelfTest` mode with `pwsh`, then Windows PowerShell
5.1 (`powershell.exe`). Duplicate and empty host entries are skipped. The first
healthy host is selected for the launch; if no host passes, launch fails closed.

Launch data is written to a private JSON payload. The controller validates the
payload identity against its filename and deletes the secret-bearing file before
compiling the embedded C# or launching the target. Target environment variables
are applied only after compilation succeeds and immediately before the owned
child is created.

Host selection is never retried after the selected controller may have started
a target. If it does not publish an authenticated terminal acknowledgement,
launch fails closed rather than risking a duplicate target. The package never
substitutes `taskkill`, title matching, or a saved PID.

Release packaging is checked with:

```sh
pnpm run verify:windows-helpers
```

The verifier requires `native/windows/termhelm-controller.ps1` to be a regular,
non-symlink file with the expected payload security and Job Object fragments,
and confirms that `package.json` includes it in the npm package.
