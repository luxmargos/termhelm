#!/usr/bin/env bash
# Linux container entrypoint: exercise the demo:managed:* scripts and the
# native Linux integration tests under Xvfb + xterm.
#
# demo:managed:fresh is interactive by design: it launches a health-monitor
# terminal with exitAfterCommand=false and then awaits that window closing.
# In a headless container we close the monitor window ourselves once the
# detached managed daemons are healthy, which lets fresh.mjs complete so the
# rest of the managed flow (replacement, kill) can run non-interactively.
set -euo pipefail

log() { printf '\n\033[1;34m[termhelm-linux]\033[0m %s\n' "$*"; }

export DISPLAY="${DISPLAY:-:99}"
export TERMHELM_LINUX_GUI_TEST=1
export TERM=xterm

API_PORT=43801
WEB_PORT=43802
EVENT_PORT=43803

# Start a virtual X server that xterm attaches to. The managed launcher spawns
# xterm windows here just like a real desktop session.
log "starting Xvfb on ${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1280x1024x24 -nolisten tcp -nolisten unix &
xvfb_pid=$!

cleanup() {
  log "stopping Xvfb (pid ${xvfb_pid})"
  pkill -TERM xterm 2>/dev/null || true
  kill -TERM "${xvfb_pid}" 2>/dev/null || true
  wait "${xvfb_pid}" 2>/dev/null || true
}
trap cleanup EXIT

# Wait until the X server is reachable before launching terminals against it.
for _ in $(seq 1 50); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  if ! kill -0 "${xvfb_pid}" 2>/dev/null; then
    echo "Xvfb exited before becoming ready" >&2
    exit 1
  fi
  sleep 0.1
done
if ! xdpyinfo >/dev/null 2>&1; then
  echo "Xvfb never became ready on ${DISPLAY}" >&2
  exit 1
fi
log "Xvfb is ready"

cd /app

log "verifying xterm adapter and required shells are on PATH"
command -v xterm
command -v bash
command -v zsh
command -v dash
command -v fish

log "building termhelm"
pnpm run build

log "running headless unit and config tests (TERMHELM_LINUX_GUI_TEST=0)"
TERMHELM_LINUX_GUI_TEST=0 pnpm exec vitest run \
  test/cli-core.test.ts \
  test/cli.test.ts \
  test/config.test.ts \
  --reporter=dot

log "running demo:managed:smoke (non-GUI daemon contract)"
pnpm run demo:managed:smoke

endpoint_healthy() {
  local port=$1 name=$2
  curl -s --max-time 2 "http://127.0.0.1:${port}/health" \
    | grep -q "\"status\":\"ok\"" || return 1
  return 0
}

all_daemons_healthy() {
  endpoint_healthy "${API_PORT}" api \
    && endpoint_healthy "${WEB_PORT}" web \
    && endpoint_healthy "${EVENT_PORT}" events
}

wait_for_daemons() {
  local deadline=$((SECONDS + ${1:-60}))
  while [ $SECONDS -lt $deadline ]; do
    if all_daemons_healthy; then return 0; fi
    sleep 0.5
  done
  echo "demo daemons did not become healthy in time" >&2
  return 1
}

# Run demo:managed:fresh in the background, wait for fresh.mjs to launch its
# health-monitor terminal, confirm the detached managed daemons are healthy,
# then close the interactive health-monitor xterm so fresh.mjs can return. The
# daemon xterm windows and the hidden supervisor keep running.
run_fresh() {
  log "running demo:managed:fresh ($1)"
  rm -f /tmp/termhelm-fresh.log
  pnpm run demo:managed:fresh > /tmp/termhelm-fresh.log 2>&1 &
  local fresh_pid=$!

  # Wait until fresh.mjs has performed the detached managed launch and opened
  # the health-monitor terminal. On a replacement run this also waits for the
  # predecessor session to be torn down, so the port health check below probes
  # the new daemons rather than the ones from the previous run.
  local launch_deadline=$((SECONDS + 90))
  while [ $SECONDS -lt $launch_deadline ]; do
    if grep -q 'launched the health monitor' /tmp/termhelm-fresh.log 2>/dev/null; then break; fi
    if ! kill -0 "${fresh_pid}" 2>/dev/null; then
      echo "demo:managed:fresh exited before launching the health monitor" >&2
      cat /tmp/termhelm-fresh.log >&2 || true
      return 1
    fi
    sleep 0.5
  done
  if ! grep -q 'launched the health monitor' /tmp/termhelm-fresh.log 2>/dev/null; then
    echo "demo:managed:fresh never launched the health monitor" >&2
    cat /tmp/termhelm-fresh.log >&2 || true
    kill -TERM "${fresh_pid}" 2>/dev/null || true
    wait "${fresh_pid}" 2>/dev/null || true
    return 1
  fi

  if ! wait_for_daemons 60; then
    echo "--- fresh.mjs output ---" >&2
    cat /tmp/termhelm-fresh.log >&2 || true
    kill -TERM "${fresh_pid}" 2>/dev/null || true
    wait "${fresh_pid}" 2>/dev/null || true
    return 1
  fi
  log "detached managed daemons are healthy; closing the health-monitor window"

  # Close only the health-monitor window (matched by its xterm title) so the
  # daemon windows and supervisor survive for the next replacement/kill step.
  pkill -TERM -f 'termhelm-demo-health-monitor' 2>/dev/null || true

  local wait_deadline=$((SECONDS + 30))
  while [ $SECONDS -lt $wait_deadline ]; do
    if ! kill -0 "${fresh_pid}" 2>/dev/null; then break; fi
    sleep 0.5
  done
  if kill -0 "${fresh_pid}" 2>/dev/null; then
    echo "demo:managed:fresh did not exit after the monitor window closed" >&2
    echo "--- fresh.mjs output ---" >&2
    cat /tmp/termhelm-fresh.log >&2 || true
    kill -TERM "${fresh_pid}" 2>/dev/null || true
    wait "${fresh_pid}" 2>/dev/null || true
    return 1
  fi

  log "demo:managed:fresh ($1) completed"
  cat /tmp/termhelm-fresh.log
  return 0
}

run_fresh "initial launch"
run_fresh "authenticated replacement"

log "running demo:managed:kill"
pnpm run demo:managed:kill
# Give the supervisor a moment to tear down, then fail if any daemon port still answers.
sleep 1
if all_daemons_healthy; then
  echo "daemons are still reachable after demo:managed:kill" >&2
  exit 1
fi
log "all managed daemons stopped after kill"

log "running native Linux xterm integration tests"
pnpm exec vitest run test/linux-terminal.integration.test.ts --reporter=verbose

log "Linux container acceptance passed"
