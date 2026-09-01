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

## Route invariants

- `auto` is Luna/low followed by Terra/medium only after valid semantic evidence reports a configured trigger.
- `fast` is one Luna/low step.
- `deep` is one Terra/medium step.
- Transport failure is always `block`; it never selects another model.
- The only fallback is disclosed minimum targeted root search by the parent agent.
- Every Codex child is subscription-authenticated, read-only, ephemeral, and launched with explicit model and reasoning arguments.
- Every Codex child disables the RG skill only in its own process configuration so global `$rg` routing cannot recurse inside the already-delegated scout.

## Invalid-result diagnostics

Failed result validation emits a bounded, machine-readable `validation_errors` array in both the CLI `rg.run.v1` failure and `receipt.json`. Entries contain `category`, `field`, and `message`; `rejected_value` is present only for a safe repository-relative path. `validation_error_count` records the total and `validation_errors_truncated` reports whether the 128-entry output limit was reached. Current categories are `unsafe-path`, `path-outside-inventory`, `ignored-content`, `linked-path`, `invalid-line-range`, `line-range-no-overlap`, `invalid-fields`, `fingerprint-mismatch`, and `malformed-result`.

The validator checks every evidence group before rejecting the artifact. It applies line-range normalization only after the complete result passes, and it never rewrites the raw `result.json`. An `invalid-result` remains a contract/transport-class stop and cannot trigger Terra.

## Path provenance and preflight

RG derives at most 20 path hints from exact path, filename, or bounded stem mentions in the request. Every hint is copied from the owner fingerprint inventory, excludes ignored/generated/dependency content and linked entries, and is bound to the fingerprint digest in the prompt. The hint list is deliberately marked incomplete; the child must obtain any other evidence path from exact Git or `rg --files` output in that run.

For a safe path outside the inventory, RG can report up to five same-basename candidates. Each candidate contains only a safe repository-relative `path`, a deterministic numeric `confidence`, and `source: owner-fingerprint-inventory`. Candidate reporting never changes the raw or returned result and does not itself retry or escalate.

## Same-model contract repair

RG permits at most one repair attempt per route step, using the exact same configured profile, model, reasoning effort, subscription provider, read-only sandbox, owner fingerprint, and strict result validator. Repair is eligible only when every diagnostic is one of `path-outside-inventory`, `invalid-line-range`, `line-range-no-overlap`, or `invalid-fields`. It is skipped for more than 20 diagnostics, truncated diagnostics, a repair prompt over 192 KiB, or any unsafe/ignored/linked/fingerprint/malformed/mixed failure. The repair timeout is capped at five minutes.

The original `result.json` remains untouched; repair uses separate `repair-prompt.txt`, `repair-events.jsonl`, `repair-stderr.log`, and `repair-result.json` artifacts. Receipt and CLI output disclose whether repair was attempted and its outcome. Evidence state is derived from the artifact: a non-empty result that could not reach strict validation is `unvalidated`, a contract-rejected result is `invalid`, and only an absent/empty result is `missing`. A second invalid result or repair transport failure is terminal. Repair never changes model tier and cannot act as a Terra fallback; only a subsequently valid semantic trigger can continue an `auto` route.

## Worktree drift restart

RG distinguishes an owner-observed repository change (`fingerprint-drift`) from a model-returned fingerprint mismatch (`invalid-result` / `fingerprint-mismatch`). Only the former is restartable, and only when it carries an internally validated `rg.fingerprint-drift.v1` diagnostic from an allowed phase: inventory recheck, before a later route step, during search, or immediately before/during same-model repair.

The diagnostic contains public before/after fingerprint metadata plus added, removed, modified, and type-changed counts. Its path sample contains at most 20 safe repository-relative paths and reports truncation; it never includes file contents. RG discards the full in-progress route attempt and restarts once from the route's first configured profile with a fresh owner snapshot. Completed and failed receipts from the discarded attempt remain available in `restart.discarded_steps`. The successful response reports `restart.outcome: completed`; another drift reports `exhausted`. Any other failure on the restarted attempt reports `failed` and is terminal. The attempt limit is immutable at one, and a restart cannot select Terra unless a fresh valid Luna result independently emits a configured semantic trigger.

## Run-store lifecycle

An active route step writes a schema- and run-ID-bound `active.json` next to its `running` receipt and refreshes the lease every 30 seconds. Normal completion or failure removes the lease. A future filesystem mtime never establishes freshness by itself: only a fully valid lease for the same run with a live PID can still prove that the owner is active. Malformed or mismatched leases cannot borrow a live PID to mask another stale run. A finalizer converts any otherwise-unhandled in-process error into a terminal failed receipt; if a result artifact already exists it is recorded as `unvalidated` rather than silently lost.

Before a search, maintenance requires the resolved `$CODEX_HOME`, its `rg` child, and `rg/runs` to be real, nonlinked directories, then inspects only child directories whose name and `receipt.json` match RG's run-id, receipt, and non-future lifecycle contracts. A linked/junctioned component fails closed without scanning or deleting its target. Each route step independently rechecks this boundary, creates its run directory without recursive parent creation, and revalidates both the boundary and run identity before artifact mutations. A `running` receipt older than two hours is reconciled to `failed/stale-run-reconciled` only when there is neither a recent valid heartbeat nor a live valid owner. Cleanup recursively removes only revalidated terminal run directories inside the exact runs root, after rechecking the full boundary and child filesystem identities. Per-run atomic maintenance claims ensure concurrent reconcilers/deleters have one owner and deletion counters reflect completed claims, while dead owners can be recovered. Terminal runs older than 14 days are eligible; after a 24-hour grace period, terminal runs beyond the newest 200 are also eligible. Symlinks/junctions, unknown names, malformed receipts, active runs, and recent runs are preserved.

`search` performs maintenance and includes `run_store_maintenance` in `rg.run.v1`. `doctor` is non-mutating and exposes the same inventory as `run_store`, including scanned/status counts, active leases, actionable stale receipts, cleanup eligibility, reconciliations, deletions, and invalid entries.

## Reliability gate and canary

`npm run check` is the hermetic release/CI gate. It validates required skill, profile, schema, test, canary, and workflow assets; runs unit and fake-Codex integration suites separately; executes the deterministic `rg.canary.v1` end-to-end probe; and finishes with `git diff --check`. The canary uses isolated temporary repository and Codex-home directories, the production `performSearch()` orchestration path, a real Git fingerprint, strict result validation, and a terminal receipt. It never calls a hosted model and always validates its temporary deletion boundary before cleanup.

The checked-in GitHub Actions workflow runs that same command on Node.js 20 and 22 across `ubuntu-latest` and `windows-latest`. `npm run doctor` is deliberately excluded from hermetic CI because it verifies the operator's real Codex login, configuration, and model route; run it locally before a real-model canary or release.

## Local installation

Install or link the repository as a user skill under the active Codex skill directory. Keep implicit invocation enabled in `agents/openai.yaml`. A concise global `~/.codex/AGENTS.md` rule may require `$rg` before non-trivial repository search; new sessions are required for global instruction changes.

Run the diagnostic without spending a model turn:

```text
node <rg-skill-root>/scripts/rg.mjs doctor --repo <git-root>
```
