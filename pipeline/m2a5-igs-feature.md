You are the implementer for a small M2a extension in Arc Power (Electron OC tool for Intel Arc GPUs). Read `AGENTS.md`, `plan.md` (sections 5-8), `docs/igcl-integration.md` (especially §8a), and the existing M2a code before writing anything. Baseline green: `npm test` 229/229, `npx tsc --noEmit` exit 0, `npm run smoke:mock` OK.

## Feature (user request, verified finding behind it)

The `IntelGraphicsSoftwareService` Windows service blocks OC writes (power/freq/temp) from other apps while it runs — verified experimentally both directions on this A770 (docs/igcl-integration.md §8a). Implement:

1. **Service-state detection**: the app reads whether the IGS service is running (+ its start type).
2. **Status indicator + note**: the app's status indicator shows a warning when the service is running, with a note: the service is currently running, meaning OC changes won't apply.
3. **A button to disable the IGS service** (elevated, with UAC), plus a re-enable path so the action is reversible.

## Implementation spec

**Main process — new module `src/main/igs-service.js`:**
- Pure parser `parseScQueryOutput(stdout, stderr, exitCode)` → `{ found: boolean, running: boolean, startType: 'auto'|'manual'|'disabled'|'unknown' }` handling: `STATE : 4 RUNNING` / `1 STOPPED` / pending states; `START_TYPE : 2 AUTO_START` / `3 DEMAND_START` / `4 DISABLED` (from `sc qc`); exit 1060 (service does not exist) → `found:false`. Robust against whitespace/CRLF. Unit-testable with no process calls.
- `getIgsServiceState()` → runs `sc.exe query IntelGraphicsSoftwareService` and `sc.exe qc IntelGraphicsSoftwareService` via `child_process.execFile` (C:\Windows\System32\sc.exe); returns the parsed state; never throws — network/parse failures degrade to `{ found:false, running:false, startType:'unknown' }` (the app must not go red because the probe failed).
- `disableIgsService()` / `enableIgsService()` → spawn an ELEVATED helper via `powershell.exe -NoProfile -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command','<script>' -Verb RunAs -Wait"` (UAC prompt on the user's machine). The elevated script runs `sc.exe config IntelGraphicsSoftwareService start= disabled` then `sc.exe stop IntelGraphicsSoftwareService` (disable) — and `start= demand` then best-effort `sc.exe start` (enable). Return `{ ok, error? }`; a UAC decline/timeout must be reported as `{ ok:false, error:'elevation declined or timed out' }`, not crash.

**IPC (src/main/ipc-core.js + src/main/ipc.js):** three new whitelisted channels:
- `igs-service-state` (invoke → state object)
- `igs-service-disable` (invoke → `{ ok, error? }`)
- `igs-service-enable` (invoke → `{ ok, error? }`)
Mock mode: `RID_MOCK_IGS_RUNNING` env (default `1` → running:true/startType:'auto' — matches this machine); `=0` → running:false/startType:'disabled'. In mock mode disable/enable just flip the mock state and return ok — no elevation, no service, safe for tests and `--ui-verify`. Payload validation: these channels take no payload.

**Renderer:**
- `src/renderer/ipc.ts` + `arcpower.d.ts`: `getIgsServiceState()`, `disableIgsService()`, `enableIgsService()` wrappers.
- Status mapping (shared pure helper in `src/renderer/pure/status.ts`, unit-tested): given `{ health, igs }` → `{ level: 'searching'|'ok'|'warning'|'degraded'|'error', label }`. `warning` when health is ok AND igs.running — label "IGS service running — OC changes won't apply". Keep the existing searching/ok/degraded/error semantics (header.ts currently maps health only; F9-fix made null health → 'searching').
- Header status dot: add the `warning` (amber) state + its label (extend `healthStatus`/`STATUS_LABEL`; keep the shared mapping used by dashboard).
- Dashboard: a "System status" card row for the IGS service: state text ("running (auto)" / "stopped (disabled)" / "not detected"), the warning note when running ("The Intel Graphics Software service is running — power, frequency and temperature changes won't apply. Disable it to enable full control."), and the button: "Disable IGS service" when running, "Re-enable IGS service" when disabled/stopped. On click → invoke → toast (success or error incl. the elevation-declined case) → refresh the IGS state and re-fetch health/caps so the status indicator updates.
- Store (router.ts Store): add `igsState` slot, refetch on boot and after actions.

**Tests (each behavior change pinned):**
- `test/igs-service.test.js` (or .mjs, node:test): `parseScQueryOutput` — running/stopped/pending/not-found (exit 1060)/garbage input; startType parsing (auto/manual/disabled); CRLF handling.
- `test/ipc-core.test.js`: the three channels are registered; no-payload channels reject payloads; mock mode: state reflects `RID_MOCK_IGS_RUNNING` (default running), disable→state flips to stopped+disabled and returns ok, enable flips back — all without spawning anything.
- Renderer pure `status.ts` tests (vitest/node): warning precedence over ok; degraded/error still win over warning; label text.
- `--ui-verify`: new steps — default mock (running): dashboard shows the note + "Disable IGS service" button; clicking it (mock) → toast + state becomes stopped + button becomes "Re-enable IGS service"; with `RID_MOCK_IGS_RUNNING=0`: no note, ok indicator. (The existing ui-verify flow must stay green; add the new steps where they fit.)

**Safety rules (hard):**
- The real disable/enable runs ONLY on an explicit user click (never at boot, never in tests/ui-verify — mock mode never touches the service).
- Do NOT stop/disable the real service yourself during this run. Do NOT run real `sc` config commands. Do NOT commit.
- Keep every existing test green; no scope creep beyond the feature above.

## Checkpoints — STOP, build+test, fix reds, continue
1. After `igs-service.js` + parser tests: `npm test` green (parser tests pass).
2. After IPC + mock wiring: `npm test` green.
3. After renderer (status mapping, header, dashboard card, button): `npm test` + `npx tsc --noEmit` + `npm run build:renderer` green, `--ui-verify` runs in both `RID_MOCK_IGS_RUNNING` modes and passes.

## Deliverables (report back)
- File tree of changes, one line per module.
- `npm test` counts, typecheck/build status, ui-verify results (both modes).
- Exact user-visible strings used (note + button labels).
- Any deviations from this spec (with justification).
