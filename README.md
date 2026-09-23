# RG

RG is a Codex skill for delegating non-trivial repository search to explicit, cheaper model tiers while keeping the parent agent focused on implementation and decisions.

Its default route is deterministic:

1. `gpt-6-luna` with low reasoning performs a bounded, read-only search.
2. `gpt-6-sol` with medium reasoning runs only after a valid Luna result reports a configured semantic evidence gap.
3. Authentication, availability, quota, timeout, malformed output, and model fingerprint mismatches stop the route. A validated external worktree drift may restart the entire route once from its configured first profile; it never silently switches models.

The implementation adapts OpenBuild's exact-model worker pattern: explicit `codex exec -m`, pinned reasoning effort, ChatGPT subscription authentication, provider/env hardening, read-only sandboxing, multi-agent disabling, child-local RG skill suppression to prevent recursive routing, strict JSON evidence with safe line-range bounding, worktree fingerprints, bounded artifacts, and terminal receipts.

Line ranges that begin inside a repository file are bounded to that file and to 200 lines in the returned result. The raw model artifact is retained unchanged in the run directory for auditability.

Rejected model output returns machine-readable `validation_errors` in the failed `rg.run.v1` response and its terminal receipt. Each entry has a stable `category`, `field`, and safe message; a rejected value is included only when it is a bounded repository-relative path. Validation aggregates defects across all evidence groups before failing and never partially normalizes the result. Contract and transport failures still stop the route without Sol escalation.

Before each scout run, RG derives a small owner-controlled path preflight from the fingerprint inventory and exact filename/stem mentions in the request. The scout is instructed to copy those hints or exact `git`/`rg --files` output, never inferred directory spellings. If a safe path is still outside the inventory, diagnostics may include up to five deterministic same-basename candidates with confidence and `owner-fingerprint-inventory` provenance. Candidates are evidence for a later repair decision; RG does not silently substitute them.

For a parsed result whose only defects are explicitly repairable contract errors (`path-outside-inventory`, invalid/nonoverlapping line ranges, or invalid fields), RG permits exactly one repair turn with the same profile, model, reasoning effort, fingerprint, and strict validator. The repair is capped at 20 diagnostics, a 192 KiB prompt, and five minutes. Original and repair artifacts are kept separately; any non-empty artifact written before a runner/parse failure is recorded as `unvalidated`, never as `missing`. Unsafe, ignored, linked, fingerprint-mismatch, malformed, oversized, mixed, and transport failures are never repaired; a failed repair is terminal and never selects Sol by itself.

When owner recomputation proves that the repository changed during a read-only route, RG reports a typed `rg.fingerprint-drift.v1` diagnostic with the phase, before/after fingerprints, change counts, and at most 20 changed repository paths. It discards that route attempt and restarts the whole configured route exactly once from Luna in `auto`/`fast` (or Sol in explicitly requested `deep`) against a fresh fingerprint. The first attempt and receipt remain disclosed under `restart.discarded_steps`. A second drift, an unstructured drift claim, a model-returned fingerprint mismatch, or any transport/contract failure is terminal; none can consume the restart as a hidden model fallback.

Each active run holds a contract-bound heartbeat lease and emits machine-readable `rg.progress.v1` status immediately and every 30 seconds. Every in-process exception is terminalized into its receipt. The read-only `status` command resolves an exact run ID or receipt and returns `rg.status.v1`; polling-window counts never affect state, and `fallback_allowed` is true only for a validated terminal failed receipt. Before search, run-store maintenance marks a `running` receipt older than two hours as failed only when no recent/live lease with the same run ID exists; a future-dated heartbeat is not considered recent without a valid live-owner contract. Receipt lifecycle timestamps from the future are invalid and fail closed. It removes only validated terminal RG run directories: older than 14 days, or beyond the newest 200 after a 24-hour grace period. The home, `rg`, and `runs` directory chain must be real and nonlinked; run creation and every later artifact mutation revalidate that same boundary and the run-directory identity. Per-run atomic maintenance claims serialize reconciliation and deletion so concurrent maintenance counts an object only once. Unknown, malformed, linked, active, and recent entries are never deleted. `doctor` reports the same counters in read-only mode; completed search output includes the maintenance summary.

## Requirements

- Node.js 20 or newer
- Git
- Codex CLI authenticated with ChatGPT (`codex login status`)
- access to the configured Luna and Sol models

No npm dependencies are required.

Version 0.4.0 moves the default scout to GPT-6 Luna and the balanced tier from GPT-5.6 Terra to GPT-6 Sol. Existing repo/user model overrides remain in force; see [configuration](references/configuration.md) before upgrading a pinned installation.

## Install as a user skill

Clone the repository and link it into the active Codex skills directory. In the current Codex setup that directory is `$CODEX_HOME/skills`, normally `~/.codex/skills`.

Windows PowerShell:

```powershell
git clone https://github.com/GeorgVahi/RG C:\PROJECTS\RG
New-Item -ItemType Junction -Path "$env:USERPROFILE\.codex\skills\rg" -Target "C:\PROJECTS\RG"
```

macOS/Linux:

```sh
git clone https://github.com/GeorgVahi/RG ~/src/RG
ln -s ~/src/RG ~/.codex/skills/rg
```

Start a new Codex session after installation so the skill catalog is reloaded. The skill permits implicit invocation. To make it the persistent default for broad repository search, add this to the active global `AGENTS.md`:

```md
## Default repository search

- Before non-trivial repository grep, file/symbol/owner/test discovery, dependency tracing, or cross-file evidence gathering, use the installed $rg skill. Direct reads remain appropriate for an explicit or already-known path and for Git metadata. A live RG `session_id`/`cell_id` is still running regardless of how many polling windows elapse; keep waiting on the same process, and permit targeted fallback only after a terminal failure or `rg.status.v1` with `terminal: true` and `fallback_allowed: true`.
```

## Use

Implicitly, ask Codex to locate or trace code. Explicitly, say `Use $rg to find ...`.

The runner can also be invoked directly:

```text
node scripts/rg.mjs search --repo <git-root> --mode auto --query <bounded request>
node scripts/rg.mjs search --repo <git-root> --mode fast --query <bounded request>
node scripts/rg.mjs search --repo <git-root> --mode deep --query <bounded request>
node scripts/rg.mjs status --run-id <run-id>
node scripts/rg.mjs status --receipt <absolute-receipt-path>
node scripts/rg.mjs doctor --repo <git-root>
```

- `auto`: Luna first, evidence-gated Sol second.
- `fast`: one Luna pass.
- `deep`: one explicitly requested Sol pass.

An `auto` search can take longer than any number of shell-tool wait windows. A returned live `session_id` is an in-progress command, not a failed search: keep polling that same session until the process exits and emits the final `rg.run.v1` JSON. `RG_PROGRESS` heartbeats expose the current `run_id`. If the session handle is lost, use `status`; only its terminal `failed` state permits targeted fallback. The progress lines are not final results.

Configuration precedence and the immutable routing constraints are documented in [references/configuration.md](references/configuration.md).

## Verify

```text
npm run check
npm run doctor
```

`npm run check` is the release gate: skill validation, unit tests, fake-transport integration tests, a deterministic end-to-end canary, and `git diff --check`. The canary creates isolated temporary Git/Codex homes, exercises the real runner and receipt path through the bundled fake Codex executable, and removes its temporary data; it needs no model access or credentials. GitHub Actions runs the same gate on Node.js 20 and 22 on both Windows and Linux. `npm run doctor` remains the local environment/auth/config diagnostic and is intentionally separate from hermetic CI.

Run artifacts and receipts are written outside the target repository under `$CODEX_HOME/rg/runs`.

## License and attribution

RG is MIT-licensed. Its runner architecture is adapted from [OpenBuild](https://github.com/GeorgVahi/OpenBuild); see [NOTICE](NOTICE).
