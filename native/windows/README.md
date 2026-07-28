# Windows controller helper

This helper launches each command in a Windows Job Object configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. It retains process and supervisor handles,
so process IDs are never reused as termination authority.

The command is created suspended and assigned to the Job Object before it can
run. The controller then attaches to that command's dedicated console, sends a
console-wide Ctrl+Break for graceful shutdown, and escalates through the retained
Job handle only when the Job does not become empty.

At runtime the architecture-matched native executable is preferred after it
passes `--self-test`. If it is absent, invalid, or fails that pre-launch probe,
termhelm probes `termhelm-controller.ps1 -SelfTest` with
`pwsh`, then with Windows PowerShell 5.1 (`powershell.exe`). The first healthy
PowerShell host runs the bundled fallback controller, which preserves the same
Job Object ownership boundary. Default native and PowerShell assets are accepted
only from the canonical package root, and the fallback deletes its transient
environment/control payload before compiling or launching a target.

Fallback is never a retry after ownership becomes uncertain. If a controller
may already have started the target but does not publish an authenticated
terminal acknowledgement, launch fails closed. The package never substitutes
`taskkill`, title matching, or a saved PID.

Build release executables on Windows with the MSVC C++ toolchain. The npm build
command prefers PowerShell Core (`pwsh`) and automatically falls back to the
legacy Windows PowerShell (`powershell.exe`) when `pwsh` is not installed:

```powershell
pnpm run build:windows-helper -- -Architecture x64
pnpm run build:windows-helper -- -Architecture arm64
```

The script itself is Windows PowerShell 5.1 compatible and can also be invoked
directly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File native/windows/build.ps1 -Architecture x64
```

The outputs are:

- `native/win32-x64/termhelm-controller.exe`
- `native/win32-arm64/termhelm-controller.exe`

Both platform directories must be copied into the published package. Runtime
resolution can be overridden with `TERMHELM_CONTROLLER_HELPER`; an
override must be an absolute PE executable matching the current architecture.
The published package must also include
`native/windows/termhelm-controller.ps1`. Official packaging continues
to require both native executables even though installed-package runtime
selection can fall back to the PowerShell controller.
