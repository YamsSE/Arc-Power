# AGENTS.md — DeepSeek V4 Flash pipeline (via opencode CLI)

All planning review, implementation, code review, and fixing in this project
run on **DeepSeek V4 Flash through the opencode CLI**, delegated to subagents.
The host/orchestrator model coordinates the pipeline and writes the initial
plan; every other lane is DeepSeek.

## opencode invocation rules (apply to every DeepSeek call)

- Model: `opencode-go/deepseek-v4-flash`. There are three deepseek entries in
  the catalog — do **not** use `opencode/deepseek-v4-flash-free` (free tier)
  and do **not** use `deepseek-v4-pro`.
- **Always run at `--variant max`.** The flag accepts `high` / `max`, but
  opencode does **not** echo the level back, so it cannot be confirmed from
  the log afterwards. Take care to spell it correctly.
- Pipe the prompt via stdin from a file with a trailing `-`:
  `opencode run --auto -m opencode-go/deepseek-v4-flash --variant max - < prompt.md`
- **Keep context between subagent calls that belong to the same lane.** Start
  the lane once, note its session id, and resume it with opencode's session
  flags (`--session <id>` / `--continue`) instead of starting cold. See
  "Session policy" below for which lanes run fresh vs. continued. (Check
  `opencode run --help` for the exact session flag names in your installed
  version.)

## Background tasks (plugin)

The **opencode-background-agents** plugin is installed
(https://github.com/kdcokenny/opencode-background-agents) and **should be
used to start background tasks** — async delegation that keeps working while
research runs, with results persisted to disk.

- Tools it adds:
  - `delegate(prompt, agent)` — launch a background task (fire-and-forget; a
    notification arrives on terminal state).
  - `delegation_read(id)` — retrieve a specific result (blocks until the
    delegation is terminal or times out).
  - `delegation_list()` — list all delegations with their titles and
    summaries, to scan past research and pick what to retrieve.
- Results are persisted as markdown to
  `~/.local/share/opencode/delegations/` and survive context compaction,
  session restarts, and crashes.
- Delegations time out after **15 minutes**. (If necessary increase it in config file.)
- **Read-only sub-agents only:** only read-only sub-agents (edit/write
  denied) can use `delegate`. Any write-capable sub-agent must use the
  native `task` tool instead — background sessions are outside opencode's
  undo/branching tree, so write-capable background execution would risk
  untracked data changes.

**Host orchestration must use `delegate` for background task handling.**
Background research/async work (e.g., the M1 review gate while writing the
next milestone's implementer prompt, doc mining, fixture extraction) is
launched via the plugin's `delegate(prompt, agent)` instead of blocking
foreground sessions, then collected with `delegation_read(id)` /
`delegation_list()`; results are persisted under
`~/.local/share/opencode/delegations/`. Only foreground, write-capable
lanes (implementer/fixer runs) keep using the native `task` tool or
`opencode run` sessions.

## Milestone commits and pushes (mandatory)

After **every** milestone completes (step-5 approval + distribution build),
the host lane commits the whole milestone and pushes to `origin/main`:

- Commit message: `M<ms>: <short summary>` (e.g. `M2a: UI core`); one commit
  per milestone, no secrets, no `dist/`/`node_modules/` (gitignored).
- Push with `-u origin main`. The GitHub remote is `origin`
  (https://github.com/YamsSE/Arc-Power).
- Subagents (implementer/fixer/reviewer prompts) still **never commit** —
  opencode snapshots their work via git; only the host commits, and only at
  milestone boundaries.

## Session policy (fresh vs. continued)

Continue a session when the task iterates on prior state (the loop only
converges if the reviewer remembers its own findings). Start fresh when you
want independent judgment, uncontaminated by the session that produced the
code.

- **Step 2 plan reviewer** — one session, continued across all rounds.
- **Step 3 implementer** — one session per run; checkpoints happen inside it.
- **Step 4 reviewer** — fresh on first entry (independent of the
  implementer's session); then continued across later passes through step 4
  so it can verify its fixes were addressed.
- **Step 4 fixer** — fresh every time (never the reviewer session).
- **Step 5 final reviewer** — fresh on first entry; then continued across
  4–5 iterations so it can verify its earlier findings were addressed.
- **Step 5 fixer** — fresh every time.

**Restart-and-reseed:** long loops degrade — the context fills with stale
diffs and the reviewer starts missing or re-raising things. If that happens
(rough guide: ~8–10 rounds), kill the session and start a fresh one seeded
with the plan, the current findings file, and the latest diff — not the full
history.
- `rg` is **not** available in opencode's shell; it falls back to its own
  Grep tool. Harmless — just don't tell it to use ripgrep.
- opencode snapshots the repo with git while it works, so an
  `index.lock: File exists` warning may appear if another git command runs
  concurrently. Harmless.
- opencode has no sandbox flag; `--auto` auto-approves. Ordinary unsandboxed
  build/test commands work directly.

## Pipeline

### 1. Plan
The current selected (host) model writes the spec/plan.

### 2. Plan review loop
DeepSeek V4 Flash reviews the plan via opencode. Revise and re-review until
`VERDICT: APPROVED` **or the round's findings stop being structural**,
whichever comes first. No fixed round count. Keep the reviewer in one
opencode session across rounds so it retains context.

**End the plan review** when either:
- the reviewer emits `VERDICT: APPROVED`, or
- a round's findings are no longer structural — i.e. nothing would change
  the architecture, data model, milestone boundaries, or interfaces; what
  remains is naming, wording, ordering-within-a-milestone, or
  nice-to-haves.

Triage after stopping: fold any cheap, uncontroversial remaining findings
into the plan directly; explicitly list the rest as "deferred reviewer
notes" at the bottom of the plan so the implementer sees them; drop nothing
silently.

### 3. Implementation
DeepSeek V4 Flash via opencode, `--variant max`, per the invocation rules
above.

**Always require build+test checkpoints inside the run.** This matters more
than how the milestone is split, and it is nearly free. Name 2–4 points in
the implementation prompt where the implementer must stop, build, run the
test suite, and fix what is red before continuing — typically after the
persisted-schema work, after any self-contained parser or pure function, and
before touching UI. A cheaper model performs better when verification
frequency goes up; a compiler and a failing test are a far stronger signal
than more reasoning depth, and they are what this whole pipeline is built
around. Without checkpoints all verification lands at the end, where one
early wrong decision has already propagated.

**Split a milestone into separate implementer runs only at low-coupling
seams with a cheap oracle.** Good candidates: pure functions over text or
bytes (parsers, validators, format readers) and persisted-schema or
migration work — the first because it unit-tests in isolation, the second
because it is the highest-cost thing to get wrong late and everything else
records into it. Keep the rest as one run. Subsystems that genuinely read
each other (staleness reading the schema, a gate reading an assignment)
produce integration bugs that exist *only* because of the split — that is
how decomposition backfires, and a review round is cheaper than a seam bug.
Expect a 2-way split, not 4–5. Each extra run also re-derives the codebase
cold, which is not free.

Do not claim a past milestone's review-round count proves the granularity
was wrong unless it was actually diagnosed — round count also tracks how
fiddly the domain was and whether the work touched persisted data.

### 4. Review (findings only) → fix + test
DeepSeek V4 Flash (max) reads and reviews the resulting code against the
plan and **reports findings with fixing suggestions only — it never edits
code**. Save the findings to a file (e.g.
`pipeline/findings-<milestone>-<round>.md`). Then a **separate fresh
opencode session** (same model, `--variant max`) receives the findings
file and the latest diff, fixes everything, and runs the build and tests —
with a regression test for each fix. Then continue the step-4 reviewer
session to verify its findings were addressed. Loop until a round's
findings stop being structural (triage like the plan review).

### 5. Final code review
DeepSeek V4 Flash (max) reviews the final code against the plan.

If it finds defects:
1. Save the findings to a file.
2. Have DeepSeek V4 Flash (max) fix them — **in a separate subagent
   instance** (fresh opencode session), same model and `--variant max`, with
   regression tests for each fix.
3. Then **always** go back through step 4 (step-4 reviewer reviews the fix
   diff — findings only — separate fixer fixes, build, run tests) before
   re-submitting to the step-5 reviewer.

Repeat 4–5 until the step-5 reviewer approves. Apply the same stopping rule
as the plan review: if a round's findings stop being structural (pure
style/naming nits, no behavior change), triage them the same way instead of
looping forever.

### 6. Distribution build (every milestone)
**Always build the distribution EXE after every milestone** — never leave a
milestone without a packaged artifact. After a milestone's step-5 approval
(or immediately when the milestone is otherwise complete), run
`npm run dist` (electron-builder, portable win target) and verify the
packaged EXE, not just the dev tree:

1. `npm test` and the dev-tree smoke are green.
2. `npm run dist` produces `dist/Arc-Power-<version>.exe`.
3. The packaged EXE must pass the headless smoke
   (`dist\Arc-Power-<version>.exe --headless` → exit 0). This is the
   check that catches packaging failures — koffi's native `.node` binary
   not surviving the asar/portable extraction is a known failure mode, and
   it only shows up in the packaged app.
4. Record the artifact name + smoke result in the milestone report.

Any change that affects runtime (new native deps, new preloads, asar
config) requires re-running step 3. The `dist/` output is gitignored.
