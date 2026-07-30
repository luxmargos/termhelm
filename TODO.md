# TODO

- Add a non-windowed mode that works in headless, non-GUI environments.
- Design reboot-safe managed-session recovery. Persist an authenticated/durable
  boot identity with each session and reclaim prior-boot records only when the
  platform can prove that no process from that boot can remain. Keep replacement
  fail closed when boot identity is unavailable, malformed, or ambiguous.
- Compact managed launch-generation tickets without allowing generation reuse.
  Replace the intentionally immutable per-generation directories with a
  cross-process atomic high-water mechanism that survives crashes, includes a
  fail-closed migration/corruption story, and preserves contender ordering.
