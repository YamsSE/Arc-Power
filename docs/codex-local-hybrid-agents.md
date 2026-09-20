# Local hybrid Codex agents

This project keeps the cloud orchestration path as the normal default and adds an explicit local path for bounded coding work.

## Selected local profile

- Runtime: LM Studio with its Vulkan `llama.cpp` engine.
- Hardware survey: Intel Arc B580 11.83 GiB VRAM and Arc A770 7.91 GiB VRAM are visible to the runtime.
- Endpoint: `http://127.0.0.1:1234/v1`.
- Model: `qwen/qwen3.5-9b`, LM Studio's Qwen3.5 9B Q4_K_M profile.
- Working load profile: Intel Arc B580, context `16384`, and one request at a time. Keep the local load bounded so it does not compete with the application or other GPU workloads.
- The exact Qwen3.5 profile is the only permitted local model for bounded implementation, debugging, technical analysis, and first-pass review. Luna Max remains the orchestrator/planner and Luna xhigh is the final reviewer. Astra is not the default final reviewer. Never silently fall back to another Qwen model, quantization, backend, or cloud model for those local passes.

The model is not checked into this repository. On a fresh machine, download it once with:

```powershell
lms get qwen/qwen3.5-9b -y
```

Then load it and start the server:

```powershell
lms load qwen/qwen3.5-9b --gpu max --context-length 16384 --parallel 1 --identifier qwen/qwen3.5-9b -y
lms server start
```

LM Studio serves the OpenAI-compatible API at `http://localhost:1234/v1`. Validate the loaded model before using Codex:

```powershell
Invoke-RestMethod http://localhost:1234/v1/models

$body = @{
  model = "qwen/qwen3.5-9b"
  messages = @(@{ role = "user"; content = "Return only: local endpoint works" })
  temperature = 0
  max_tokens = 128
  reasoning_effort = "none"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod http://localhost:1234/v1/chat/completions -Method Post -ContentType "application/json" -Body $body
```

The endpoint must list the exact `qwen/qwen3.5-9b` model ID before a local worker is started. LM Studio may emit a harmless Codex metadata warning because its `/v1/models` response uses the OpenAI-compatible `data` shape; that warning does not mean the chat endpoint is unavailable. Use `model_reasoning_effort="none"` for Codex local runs and `reasoning_effort="none"` for direct API probes so reasoning does not consume the entire local response budget.

Run a bounded local Codex session against the loaded model with:

```powershell
codex --oss --local-provider lmstudio --model qwen/qwen3.5-9b --config 'model_reasoning_effort="none"' --sandbox workspace-write
```

When the active checkout is a sibling worktree, expose the canonical Arc Power checkout so the local worker can read the ignored project instructions, then select the sibling worktree as its working directory. Use this non-interactive form:

```powershell
codex exec --oss --local-provider lmstudio --model qwen/qwen3.5-9b --config 'model_reasoning_effort="none"' --sandbox workspace-write --add-dir "C:\Users\Yams\Documents\R.ID Arc Power" -C "C:\Users\Yams\Documents\R.ID Arc Power-bugfixes" "Perform only the bounded task described here. Read the canonical AGENTS.md, .codex/config.toml, and .codex/agents definitions first. Use the provided patch tool for edits; never construct Unix heredocs or redirect syntax in PowerShell."
```

The direct LM Studio REST probe is verified with this model. The current Codex
OSS adapter smoke test is not yet verified: Codex 0.155.0-alpha.9.2 currently
sends a message layout that causes the Qwen3.5 template to return `System
message must be at the beginning`. Do not treat that adapter error as a
successful local implementation or review run, and do not silently fall back
to another model. The next fix is to make the adapter/template put the system
message first, then rerun this smoke test.

Use the interactive `--sandbox workspace-write` form for normal manual work. Do not use a model alias when testing the setup: `qwen/qwen3.5-9b` is the exact LM Studio identifier. On PowerShell, use the provided patch shim with a here-string (`$patch = @' ... '@; $patch | apply_patch`); if it is unavailable, use only `Set-Content -LiteralPath 'C:\path with spaces\file'` for an explicitly assigned file and verify immediately with `Test-Path -LiteralPath` and `Get-Content -LiteralPath`. Never use unquoted paths, `echo`, `>`, `>>`, `&&`, or Unix heredoc syntax.

The project `.codex/config.toml` sets `oss_provider = "lmstudio"` so `codex --oss` has a deterministic provider choice. The project config deliberately leaves the cloud model and Luna Max reasoning setting intact; local invocations add `--config 'model_reasoning_effort="none"'` because the exact Qwen3.5 endpoint does not accept the cloud-only `max` enum.

Codex OSS mode selects the provider for the session. The project-local role files
are available for the local implementer and reviewer when that local session is
used; they do not silently redirect the Luna Max orchestrator or Luna xhigh
final reviewer to LM Studio. Keep local prompts compact enough for the 16,384
context on the B580 and start the local session explicitly for the bounded
implementation/review loop.

## Workflow

1. Luna Max decomposes the task and assigns a bounded file scope.
2. `local-implementer` performs the change with the local Qwen model.
3. Run the narrowest relevant test or build check.
4. `local-reviewer` reads the actual diff and performs a read-only first pass.
5. Escalate the categories listed in `AGENTS.md` to the cloud Luna roles before acceptance.

The local endpoint is not a substitute for the Luna xhigh final review, and local inference has no web search or reliable evidence for current external facts. Keep local implementation ownership narrow, run focused validation after each edit, and use the read-only Qwen3.5 local reviewer before final review. If the local worker attempts Unix shell syntax on this Windows host, stop that run and correct the invocation or prompt instead of accepting an unverified edit.
