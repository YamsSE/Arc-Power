# Local hybrid Codex agents

This project keeps the cloud orchestration path as the normal default and adds an explicit local path for bounded coding work.

## Selected local profile

- Runtime: LM Studio with its Vulkan `llama.cpp` engine.
- Hardware survey: Intel Arc B580 11.83 GiB VRAM and Arc A770 7.91 GiB VRAM are visible to the runtime.
- Model: `qwen/qwen2.5-coder-7b@q4_k_m` (Qwen2.5-Coder 7B Instruct GGUF Q4_K_M, 4.68 GB). It loads in about 4.36 GiB of GPU memory on the B580.
- Working load profile: one request at a time, full GPU offload, and 32768-token context. Keep the B580 selected explicitly in LM Studio because this machine has two Intel Arc adapters.
- The larger Qwen3-Coder 30B Q4 profile is about 18.6 GB and is not a reliable full-GPU choice for a 12 GB B580.

The model is not checked into this repository. On a fresh machine, download it once with:

```powershell
lms get qwen/qwen2.5-coder-7b@q4_k_m -y
```

Then load it and start the server:

```powershell
lms load qwen/qwen2.5-coder-7b --gpu max --context-length 32768 --parallel 1 --identifier arc-local-coder
lms server start
```

LM Studio serves the OpenAI-compatible API at `http://localhost:1234/v1`. Validate the loaded model before using Codex:

```powershell
Invoke-RestMethod http://localhost:1234/v1/models

$body = @{
  model = "arc-local-coder"
  messages = @(@{ role = "user"; content = "Return only: local endpoint works" })
  temperature = 0
} | ConvertTo-Json -Depth 5

Invoke-RestMethod http://localhost:1234/v1/chat/completions -Method Post -ContentType "application/json" -Body $body
```

On this machine the loaded profile used 4.36 GiB of GPU memory. A short endpoint probe returned in 5.1 seconds (7 completion tokens), and a 96-token coding probe returned in 6.7 seconds. The endpoint and Codex transport are working; the small model's generated code still needs human/cloud review for correctness.

Run a local Codex session against the loaded model with:

```powershell
codex --oss --local-provider lmstudio --model arc-local-coder -c model_reasoning_effort="none"
```

The project `.codex/config.toml` sets `oss_provider = "lmstudio"` so `codex --oss` has a deterministic provider choice. The project config deliberately leaves the cloud model as Luna; local runs are opt-in.

Codex OSS mode selects the provider for the session. The project-local role files
are available for the local implementer and reviewer when that local session is
used; a real local Codex smoke has validated endpoint routing. They do not silently redirect a cloud Luna parent or an Astra reviewer to
LM Studio. Keep the cloud path for architecture and escalation, and start the
local session explicitly for the bounded implementation/review loop.

## Workflow

1. Luna Max decomposes the task and assigns a bounded file scope.
2. `local-implementer` performs the change with the local Qwen model.
3. Run the narrowest relevant test or build check.
4. `local-reviewer` reads the actual diff and performs a read-only first pass.
5. Escalate the categories listed in `AGENTS.md` to the cloud Luna/Astra roles before acceptance.

The local endpoint is not a substitute for cloud review, and local inference has no web search or reliable evidence for current external facts. The working Qwen2.5-Coder 7B profile has answered through `/v1/chat/completions`, a real Codex OSS smoke returned `LOCAL CODEX OK`, and the local read-only reviewer smoke found no material configuration issues. The model produced a syntactically imperfect small-code sample in the quick quality probe, so the local worker remains bounded and cloud review remains required for consequential changes. LM Studio's `/v1/models` response also emits a harmless Codex metadata warning because its listing uses the OpenAI-compatible `data` shape.
