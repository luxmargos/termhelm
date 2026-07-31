# Managed-launch examples

This demo models a local-development `fresh` workflow without containers or external services.

The default `fresh` flow uses `launchDetachedManagedTerminalWindows()`:

1. The npm launcher starts or replaces four managed terminal/process trees.
2. A hidden detached supervisor retains authenticated lifecycle ownership.
3. `fresh.mjs` waits for managed readiness, opens a short-lived health-monitor terminal, and exits so a following npm script can run.

The managed targets are:

- HTTP API server
- Web server with an API dependency
- Server-sent-event heartbeat service
- Worker parent with a child worker process

All targets use a project-scoped label and `autoClose: true`. Re-running the fresh command authenticates the existing supervisor, shuts down every old process tree, closes completed tabs, and launches a replacement session without opening a separate supervisor terminal.

```sh
pnpm run demo:managed:fresh
# Run it again to exercise detached same-label replacement.
pnpm run demo:managed:fresh
pnpm run demo:managed:kill
```

Because `demo:managed:fresh` exits after readiness, it can participate in an npm chain:

```sh
pnpm run demo:managed:fresh && node ./your-next-script.mjs
```

To compare the original long-running foreground behavior, run:

```sh
pnpm run demo:managed:foreground
# In another shell:
pnpm run demo:managed:kill
```

`demo:managed:foreground` calls `launchManagedTerminalWindows()` directly and intentionally remains alive until the managed session stops.

A non-GUI daemon contract check is also available:

```sh
pnpm run demo:managed:smoke
```

Default loopback ports are `43801`, `43802`, and `43803`. Override them with `TERMHELM_DEMO_API_PORT`, `TERMHELM_DEMO_WEB_PORT`, and `TERMHELM_DEMO_EVENT_PORT`.
