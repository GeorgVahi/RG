# RG configuration

Read this reference only when configuring models, routes, installation, or troubleshooting exact-model dispatch.

## Resolution order

RG resolves a complete model map from the first existing location:

1. `<repo>/.codex/rg/model-map.json`
2. `<codex-home>/rg/model-map.json`
3. packaged `profiles/model-map.json`

Each named profile resolves independently in this order:

1. `<repo>/.codex/rg/profiles/<profile>.json`
2. `<codex-home>/rg/profiles/<profile>.json`
3. packaged `profiles/<profile>.json`

Higher-priority files must validate completely. RG never merges an incomplete override with a lower scope.

Profile overrides may change only the exact model, reasoning effort, and user-facing description. The profile name, `read-only` sandbox, and `rg-scout-v1` instruction contract remain fixed.

Version 0.4.0 defaults to `gpt-6-luna`/`low` and `gpt-6-sol`/`medium`. Sol fills the balanced tier previously assigned to GPT-5.6 Terra; see the [GPT-6 model catalog](https://developers.openai.com/api/docs/models). Existing repo and user overrides remain authoritative, including GPT-5.6 pins. Update or remove those overrides deliberately to adopt the new defaults. RG never rewrites them or substitutes models after a failed call.

## Route invariants

- `auto` is Luna/low followed by Sol/medium only after valid semantic evidence reports a configured trigger.
- `fast` is one Luna/low step.
- `deep` is one Sol/medium step.
- Transport failure is always `block`; it never selects another model.
- The only fallback is disclosed minimum targeted root search by the parent agent after a terminal RG failure. Poll counts and caller-side wait windows are never failure signals.
- Every Codex child is subscription-authenticated, read-only, ephemeral, and launched with explicit model and reasoning arguments.
- Every Codex child disables the RG skill only in its own process configuration so global `$rg` routing cannot recurse inside the already-delegated scout.

## Repository access and NAS

Repository access is independent of the model route. Both `search` and `doctor` accept `--access native|broker`; the default is `native`. There is no automatic change of transport or sandbox privileges. Access failures happen before a model turn, contract repair, or model escalation.

`native` launches a fixed Node probe through `codex sandbox --include-managed-config --permission-profile :read-only`. The installed CLI must support these flags. The probe compares the actual child working directory and a nonce-bound digest of at most 4096 bytes with the parent read. It never emits file contents. Unsupported CLI/sandbox combinations fail explicitly instead of falling back to unsandboxed execution. `doctor` now returns a nonzero exit code when the selected access transport fails; scripts that previously treated configuration-only `ok` as readiness must inspect `repository_access` and `checks`.

For a NAS/UNC root that the parent can read but the native sandbox cannot:

```text
node scripts/rg.mjs doctor --repo <git-root> --access broker
node scripts/rg.mjs search --repo <git-root> --access broker --mode auto --query <request>
```

`broker` is an explicitly selected local stdio MCP process under the invoking user's existing filesystem identity. It is a separate trust boundary from the shell sandbox. It exposes only `list_files`, literal `search`, and `read_lines`, with no arbitrary command execution, writes, or network listener. It reads the canonical repository in place; only bounded results and ordinary run artifacts are retained, not a local checkout. The child still uses `--sandbox read-only` and `approval_policy=never`. Its user config is excluded to prevent inherited MCP transport merging; the parent still resolves and validates model overrides and subscription configuration. Managed Codex requirements remain applicable. Shell, plugins, apps, hooks, browser/computer tools, and unrelated configured MCP servers are disabled for this child. These overrides are process-local and do not edit global configuration.

The broker fixes its root and inventory to the owner's fingerprint. Snapshot and broker reads share the same canonical-root and file-descriptor checks: safe path components, root/file identity, regular-file type, single-link count, bounded size and metadata before/after reading. Broker text also requires valid UTF-8 and a matching content digest before returning bytes. Traversal, alternate data streams, symlinks/junctions, hardlinks, Git-ignored content (including tracked ignored files), generated/dependency directories, and common secret-file paths are refused. This denylist is not a general detector of secrets embedded in source files.

Limits: 2 MiB per readable file; 200 lines per read; 48 KiB per result; 100 list/search results; a search scans at most 1000 files, 16 MiB, or five seconds before reporting truncation. Search is literal, not regex. Use the opaque `next_cursor` with unchanged query/path/range parameters. Search resumes at the next unreturned matching line inside the same file. A cursor is bound to its tool, parameters, snapshot and server instance; stale, edited or cross-query cursors fail with `broker-invalid-cursor`. `read_lines` returns at most 6000 UTF-16 units per page and exposes its continuation line/column; continue until `next_cursor` is null. MCP requests are bounded to 64 KiB, 512 requests per process, and a 20-second tool deadline. The normal whole-worktree drift check and single restart still apply after a search.

`repository_access` in the result and receipt records the selected transport and native probe. A broker `doctor` can correctly report overall `ok`, `sandbox_read: failed`, and `broker_read: ok`: only the selected broker transport is ready. A native failure never appears as `invalid-result` just because the scout could not inspect files.

`git-unsafe-repository` is independent of NAS sandbox access. Trust only the exact user-approved repository through Git's `safe.directory` mechanism; do not use a wildcard. RG does not modify global Git trust. Once the parent has resolved the repository, its broker consumes the bound owner manifest without rescanning Git. The scout config retains a child-local trust entry for that same root. Preserve existing scoped Git configuration when invoking the parent runner.

On Windows CLI 0.144.3, the tested unelevated sandbox denied direct UNC reads and rejected a restricted read profile requiring elevated setup; MXC was unsupported. The broker completed a real model search on the NAS without changing Windows setup, enabling unrestricted network access, or copying the repository. Newer native backends may differ; rely on the probe rather than a version assumption.

## Snapshot v2, budgets and coverage

Version 0.6 writes `git-worktree-state-v2` fingerprints and metadata-only `rg.snapshot-manifest.v2` files. A normal successful broker step performs exactly two full hashes, before and after model execution; broker preflight/startup reuse the owner's manifest. Same-model repair adds its own before/after checks. Manifests bind the run ID, canonical root/identity, schema, creation time, public digest and entry hashes; startup verifies the manifest digest and rejects tampering, wrong roots, wrong runs or age over 30 minutes. No file contents or reusable local project cache are stored in the manifest.

The snapshot distinguishes tracked deletion, sparse omission, conflict index stages, staged/untracked rename or replacement, files replaced by directories, links and initialized/uninitialized gitlinks. Missing untracked files and changes while reading are concurrent-change failures. Permission and root/I/O failures remain explicit errors; they are never treated as deleted tracked files. Ignored untracked files are outside the inventory. Tracked files remain fingerprinted even when ignored or excluded from broker evidence. Linked/hardlinked paths are metadata states and cannot supply evidence. Submodules contribute their index identity, HEAD and dirty-status metadata, **not recursive source hashes**; run RG separately at the submodule root for source evidence. Fingerprints detect observed drift; they are not an atomic filesystem snapshot and cannot prove that a transient edit reverted between checks never happened.

Limits are 100,000 inventory entries, 2 GiB aggregate hashed file bytes and 64 MiB serialized manifest/worker output. At most eight file readers run concurrently. `--fingerprint-timeout <seconds>` defaults to 120 and accepts 1–600. `--timeout <seconds>` defaults to 900 for search (30–1800 allowed) and 180 for doctor; one absolute deadline is shared by preparation, model execution, repair, postchecks and route restarts. Configuration/root/auth preparation has a 60-second phase cap; Git metadata calls, broker probes and tools also have smaller caps. Snapshot and preparation work run in owned child processes so blocked filesystem calls can be terminated, including their Git children. Cancellation/timeout cleanup has a bounded three-second grace. There is no infrastructure-triggered model escalation or hidden retry loop.

`search` pages report `total_files`, `scanned_files`, `bytes_read`, `excluded_files` with policy reasons, `unreadable_files` with reasons, `remaining_files`, `complete`, `truncated` and `stop_reason`. These are **per-page** counts over the selected eligible-file scope; earlier unreadable counts must be retained. Binary/invalid-UTF-8 or private-key content is reported as unreadable; large, ignored, linked and policy-denied paths are excluded from the eligible scope. `complete` never asserts that excluded content was searched. Search returns one match per matching line; snippets disclose `text_truncated`. Listing files does not assert their text is readable. An empty eligible corpus fails preflight explicitly. A bounded evidence map does not require an exhaustive repository scan: unrelated remaining pages alone never justify model escalation.

Before the first fingerprint, `receipt.json` and the active lease already exist. Additive `rg.preparation.v1` metadata records phase, dispatch status and progress counters; `measurements` reports full-snapshot counts and durations. A pre-model failure is terminal with `dispatch_method: not-dispatched`, a run ID and receipt path. Configuration/root errors that precede route creation return structured diagnostics without claiming a dispatched run. If receipt finalization fails, stderr emits a bounded `RG_DIAGNOSTIC` record. No file contents or raw environment values are logged.

`doctor` reports executing/installed skill roots and versions, Node and available Codex CLI version, snapshot states/counters, and separate configuration, fingerprint, native and broker checks. An unknown version is null, not evidence of compatibility. `fingerprint-timeout`, `fingerprint-access-denied`, `fingerprint-root-unavailable`, `fingerprint-concurrent-change` and `preparation-timeout` stop before any semantic escalation. Inspect the stage and metrics before adjusting a budget.

Old `rg.receipt.v1` lifecycle records remain readable. The additive preparation fields do not change terminal/status semantics. New results must exactly match the owner's v2 fingerprint; do not compare v1/v2 digest values or resume old broker cursors. Install the runner, all helper scripts and schema together; existing model/profile overrides are preserved.

## Invalid-result diagnostics

Failed result validation emits a bounded, machine-readable `validation_errors` array in both the CLI `rg.run.v1` failure and `receipt.json`. Entries contain `category`, `field`, and `message`; `rejected_value` is present only for a safe repository-relative path. `validation_error_count` records the total and `validation_errors_truncated` reports whether the 128-entry output limit was reached. Current categories are `unsafe-path`, `path-outside-inventory`, `ignored-content`, `linked-path`, `invalid-line-range`, `line-range-no-overlap`, `invalid-fields`, `fingerprint-mismatch`, and `malformed-result`.

The validator checks every evidence group before rejecting the artifact. It applies line-range normalization only after the complete result passes, and it never rewrites the raw `result.json`. An `invalid-result` remains a contract/transport-class stop and cannot trigger Sol.

## Path provenance and preflight

RG derives at most 20 path hints from exact path, filename, or bounded stem mentions in the request. Every hint is copied from the owner fingerprint inventory, excludes ignored/generated/dependency content and linked entries, and is bound to the fingerprint digest in the prompt. The hint list is deliberately marked incomplete; the child must obtain any other evidence path from exact Git or `rg --files` output in that run.

For a safe path outside the inventory, RG can report up to five same-basename candidates. Each candidate contains only a safe repository-relative `path`, a deterministic numeric `confidence`, and `source: owner-fingerprint-inventory`. Candidate reporting never changes the raw or returned result and does not itself retry or escalate.

## Same-model contract repair

RG permits at most one repair attempt per route step, using the exact same configured profile, model, reasoning effort, subscription provider, read-only sandbox, owner fingerprint, and strict result validator. Repair is eligible only when every diagnostic is one of `path-outside-inventory`, `invalid-line-range`, `line-range-no-overlap`, or `invalid-fields`. It is skipped for more than 20 diagnostics, truncated diagnostics, a repair prompt over 192 KiB, or any unsafe/ignored/linked/fingerprint/malformed/mixed failure. The repair timeout is capped at five minutes.

The original `result.json` remains untouched; repair uses separate `repair-prompt.txt`, `repair-events.jsonl`, `repair-stderr.log`, and `repair-result.json` artifacts. Receipt and CLI output disclose whether repair was attempted and its outcome. Evidence state is derived from the artifact: a non-empty result that could not reach strict validation is `unvalidated`, a contract-rejected result is `invalid`, and only an absent/empty result is `missing`. A second invalid result or repair transport failure is terminal. Repair never changes model tier and cannot act as a Sol fallback; only a subsequently valid semantic trigger can continue an `auto` route.

## Worktree drift restart

RG distinguishes an owner-observed repository change (`fingerprint-drift`) from a model-returned fingerprint mismatch (`invalid-result` / `fingerprint-mismatch`). Only the former is restartable, and only when it carries an internally validated `rg.fingerprint-drift.v1` diagnostic from an allowed phase: inventory recheck, before a later route step, during search, or immediately before/during same-model repair.

The diagnostic contains public before/after fingerprint metadata plus added, removed, modified, and type-changed counts. Its path sample contains at most 20 safe repository-relative paths and reports truncation; it never includes file contents. RG discards the full in-progress route attempt and restarts once from the route's first configured profile with a fresh owner snapshot. Completed and failed receipts from the discarded attempt remain available in `restart.discarded_steps`. The successful response reports `restart.outcome: completed`; another drift reports `exhausted`. Any other failure on the restarted attempt reports `failed` and is terminal. The attempt limit is immutable at one, and a restart cannot select Sol unless a fresh valid Luna result independently emits a configured semantic trigger.

## Run-store lifecycle

An active route step writes a schema- and run-ID-bound `active.json` next to its `running` receipt and refreshes the lease every 30 seconds. The CLI also emits `rg.progress.v1` immediately and at each heartbeat with the run ID, elapsed time, `terminal: false`, `fallback_allowed: false`, and `polling_windows_affect_state: false`. Normal completion or failure removes the lease. A future filesystem mtime never establishes freshness by itself: only a fully valid lease for the same run with a live PID can still prove that the owner is active. Malformed or mismatched leases cannot borrow a live PID to mask another stale run. A finalizer converts any otherwise-unhandled in-process error into a terminal failed receipt; if a result artifact already exists it is recorded as `unvalidated` rather than silently lost.

Before a search, maintenance requires the resolved `$CODEX_HOME`, its `rg` child, and `rg/runs` to be real, nonlinked directories, then inspects only child directories whose name and `receipt.json` match RG's run-id, receipt, and non-future lifecycle contracts. A linked/junctioned component fails closed without scanning or deleting its target. Each route step independently rechecks this boundary, creates its run directory without recursive parent creation, and revalidates both the boundary and run identity before artifact mutations. A `running` receipt older than two hours is reconciled to `failed/stale-run-reconciled` only when there is neither a recent valid heartbeat nor a live valid owner. Cleanup recursively removes only revalidated terminal run directories inside the exact runs root, after rechecking the full boundary and child filesystem identities. Per-run maintenance claims are an append-only succession of exclusively created generations, so concurrent reconcilers/deleters have one owner and counters reflect completed claims; a dead owner's claim is succeeded rather than moved or removed, and an unreadable claim is treated as mid-write for two minutes. Cleanup detaches a claimed run directory with an atomic rename before removing it, so concurrent maintenance never observes a partially deleted run. Terminal runs older than 14 days are eligible; after a 24-hour grace period, terminal runs beyond the newest 200 are also eligible. Symlinks/junctions, unknown names, malformed receipts, active runs, and recent runs are preserved.

`search` performs maintenance and includes `run_store_maintenance` in `rg.run.v1`. `doctor` is non-mutating and exposes the same inventory as `run_store`, including scanned/status counts, active leases, actionable stale receipts, cleanup eligibility, reconciliations, deletions, and invalid entries.

`status --run-id <id>` and `status --receipt <path>` are read-only, exact-target lifecycle queries. They return `rg.status.v1` with one of `running_active`, `running_unowned`, `running_stale`, `completed`, `failed`, `invalid`, or `not_found`. All running states are nonterminal. `invalid` and `not_found` fail closed. Only `failed` returns both `terminal: true` and `fallback_allowed: true`; `completed` is terminal but directs the caller to consume the original result instead of falling back.

## Reliability gate and canary

`npm run check` is the hermetic release/CI gate. It validates required skill, profile, schema, test, canary, and workflow assets; runs unit and fake-Codex integration suites separately; executes the deterministic `rg.canary.v1` end-to-end probe; and finishes with `git diff --check`. The canary uses isolated temporary repository and Codex-home directories, the production `performSearch()` orchestration path, a real Git fingerprint, strict result validation, and a terminal receipt. It never calls a hosted model and always validates its temporary deletion boundary before cleanup.

The checked-in GitHub Actions workflow runs that same command on Node.js 20 and 22 across `ubuntu-latest` and `windows-latest`. `npm run doctor` is deliberately excluded from hermetic CI because it verifies the operator's real Codex login, configuration, and model route; run it locally before a real-model canary or release.

## Local installation

Install or link the repository as a user skill under the active Codex skill directory. Keep implicit invocation enabled in `agents/openai.yaml`. A concise global `~/.codex/AGENTS.md` rule may require `$rg` before non-trivial repository search; new sessions are required for global instruction changes.

`doctor` checks configuration, ChatGPT login, and the selected repository access transport without a model turn. It does not prove hosted model availability; verify that with a bounded search for each configured tier. For `fingerprint-drift`, finish or pause concurrent edits in the target repository before rerunning the search.

```text
node <rg-skill-root>/scripts/rg.mjs doctor --repo <git-root>
```
