# Realistic nested managed-launch demo

This demo mirrors a local-development `fresh` workflow without containers or external services.

The outer launcher opens:

1. A plain supervisor terminal.
2. A short-lived health-monitor terminal.

The supervisor then uses TermHelm's main managed API to launch four separate terminal/process trees:

- HTTP API server
- Web server with an API dependency
- Server-sent-event heartbeat service
- Worker parent with a child worker process

All targets use a project-scoped label and `autoClose: true`. Re-running the fresh command authenticates the existing supervisor, shuts down every old process tree, closes completed tabs, and launches a replacement session.

```sh
pnpm run demo:managed:fresh
# Run it again to exercise replacement.
pnpm run demo:managed:fresh
pnpm run demo:managed:kill
```

A non-GUI daemon contract check is also available:

```sh
pnpm run demo:managed:smoke
```

Default loopback ports are `43801`, `43802`, and `43803`. Override them with `TERMHELM_DEMO_API_PORT`, `TERMHELM_DEMO_WEB_PORT`, and `TERMHELM_DEMO_EVENT_PORT`.
