---
name: rg
description: Route non-trivial repository code search, broad rg, file/symbol/owner/test discovery, dependency tracing, and cross-file evidence gathering through a read-only Luna-first scout with evidence-gated Sol escalation. Use automatically before doing substantial codebase search; do not use for explicit path reads, Git metadata, web search, or edits.
metadata:
  short-description: Exact-model repository search with Luna and Sol
---

# RG

Keep repository exploration out of the main model context and route it through the packaged exact-model runner.

## Use RG first

Use RG before broad `rg`, `rg --files`, file or symbol discovery, owner mapping, dependency tracing, test lookup, route tracing, or cross-file evidence gathering.

Direct root work is still appropriate for:

- an explicit path supplied by the user;
- a returned `path:line` target from a validated RG result;
- a trivial lookup whose exact path is already known;
- Git metadata such as status, branch, diff metadata, or `HEAD` inspection;
- non-repository and web search.

RG is read-only. It never authorizes edits, commits, pushes, external writes, or a broader task.

## Run the route

Resolve the selected skill directory and invoke its runner from the target Git repository:

```text
node <rg-skill-root>/scripts/rg.mjs search --repo <git-root> --mode auto --query <bounded-search-request>
```

`auto` is the default route:

1. `gpt-6-luna` with low reasoning performs the first read-only search.
2. `gpt-6-sol` with medium reasoning runs only when the Luna result is valid and reports one of the configured semantic evidence gaps.
3. Authentication, CLI, model availability, timeout, malformed output, fingerprint drift, or another transport failure never switches models.

Use `--mode fast` only when the request explicitly prefers the cheapest single Luna pass. Use `--mode deep` when the user explicitly requests the balanced tier or the task is already known to require a deep read-heavy scan. Do not choose `deep` merely because a repository is large.

Keep the request bounded and outcome-oriented. Include the symbols, behavior, suspected area, or evidence needed, but do not paste unrelated chat history.

### NAS and sandbox access

The default `--access native` checks actual sandbox reads before starting a model. `doctor` reports configuration, parent reads, and sandbox reads separately; configuration-only success is not proof of repository access. Treat `sandbox-read-denied`, `cwd-mismatch`, probe failures, and `git-unsafe-repository` as infrastructure failures, never semantic gaps or reasons to change models.

For an already-authorized NAS/UNC repository that the parent can read but the native sandbox cannot, explicitly select the bounded read-only broker:

```text
node <rg-skill-root>/scripts/rg.mjs doctor --repo <git-root> --access broker
node <rg-skill-root>/scripts/rg.mjs search --repo <git-root> --mode auto --access broker --query <bounded-search-request>
```

The broker supplies only file listing, literal text search, and bounded line reads from the same repository. It checks inventory, paths, links, and file fingerprints. The scout keeps its read-only sandbox and has shell and unrelated tools disabled. No repository copy, network drive mapping, global configuration change, or NAS credential transfer is needed. Select the transport explicitly; never disable the sandbox or switch access mechanisms while a run is still live. Broker access does not authorize another repository or override an administrator's restriction. Read [configuration](references/configuration.md#repository-access-and-nas) for limits and diagnostics.

Version 0.7 broker access supports concurrent builds and edits. It obtains a Git path catalog without hashing the whole worktree, reads content on demand, and rechecks every successfully observed text file before accepting evidence. Changes to unobserved files do not invalidate the run. A changed observed file permits one fresh route attempt; a second change fails explicitly. Do not stop other chats, restore deleted files, or increase timeouts to hide drift. Native access retains whole-worktree snapshots.

The broker's `git-path-catalog-v1` fingerprint identifies paths at catalog creation, not a content snapshot; `bytes: 0` means no content was prehashed. Listings are candidate paths and may include a file deleted afterward. Read every cited path and `related_path` through the broker in the current run. The owner rejects unobserved evidence. Final `consistency` records verified file/byte counts and a read-set digest. Manifests and observation journals contain metadata only, outside the repository; no local checkout or content cache is created.

Untracked enumeration has a five-second budget. If it times out, tracked discovery continues with `inventory.untracked: incomplete-timeout` and `complete: false`; new/untracked paths may be absent. The catalog is fixed for the run and is not an atomic view of a changing repository. Never claim repository-wide absence from this mode, and disclose relevant coverage limits. Keep searches bounded to the requested files or owners so unrelated files do not enter the read set.

For `fingerprint-*`, `catalog-*`, `preparation-*`, or broker failures, inspect the reported stage, safe path, I/O code and counters. `doctor` reports runner/installed/Node/CLI versions and separate catalog or fingerprint/native/broker checks. Broker doctor verifies catalog/probe access, not all file contents. `--fingerprint-timeout <seconds>` bounds each catalog, read-set verification or native snapshot (default 120, range 1–600); `--timeout` is the shared route budget, including preparation, repair and restart. Do not multiply retries or change models to hide an infrastructure failure. See the configuration reference for coverage exclusions and compatibility.

Broker cursors are opaque and bound to their query/path/range, snapshot and server instance. Reuse `next_cursor` with unchanged parameters; search resumes inside the same file, and long line reads may require several pages. Counts describe each page. Preserve unreadable counts from previous pages and distinguish policy exclusions from unexamined files; a truncated or unreadable search does not prove absence. A bounded owner map can still be complete once its directly verified evidence answers the request; unrelated remaining inventory is not an escalation trigger.

The route may outlive any number of shell-tool wait windows. If the invocation returns a live `session_id` or `cell_id` without a terminal `exit_code`, the runner is still working: continue the same process with the tool's `write_stdin` or `wait` mechanism until it exits. A polling-window count or caller-side wall-clock window never changes `RUNNING` into failure. In particular, never conclude that the scout failed merely because two or more waits returned no final packet.

Before fingerprinting, each route step writes its receipt/lease and immediately emits an `RG_PROGRESS` object with schema `rg.progress.v1` and refreshes it every 30 seconds while the worker is live. It includes `run_id`, `terminal: false`, `fallback_allowed: false`, and `polling_windows_affect_state: false`. Lines such as `RG: starting ...`, `RG_PROGRESS ...`, and `RG: completed ...` are progress messages, not the structured result and not a failure.

If the original shell session handle is unavailable, inspect the receipt without starting another scout:

```text
node <rg-skill-root>/scripts/rg.mjs status --run-id <run_id>
node <rg-skill-root>/scripts/rg.mjs status --receipt <absolute-receipt-path>
```

The machine-readable `rg.status.v1` result is authoritative for receipt-backed recovery. `running_active`, `running_unowned`, and `running_stale` are nonterminal and forbid fallback. `completed` means consume the original result. Only `failed` with both `terminal: true` and `fallback_allowed: true` permits minimum targeted recovery. `invalid` and `not_found` fail closed: report the lifecycle/status problem instead of reclassifying a polling delay as scout failure.

## Consume the result

Accept the result only when the runner returns `schema: "rg.run.v1"` and `status` is `completed` or `completed_with_gaps`. The nested `result` has the strict `rg.discovery.v1` evidence contract.

Classify the runner as failed only after the process has exited or otherwise reached a terminal state without a valid result, or after `rg.status.v1` explicitly reports terminal `failed` with fallback allowed. Parse the accumulated output through the final `rg.run.v1` object; do not judge an in-progress output chunk in isolation. Never start fallback recovery while the original process or receipt state is nonterminal.

- Use its owners, tests, couplings, flows, constraints, and uncertainties as a map.
- Verify material conclusions with targeted reads of returned `path:line` ranges.
- Do not repeat broad root searches already covered by valid evidence.
- If `status` is `completed_with_gaps`, perform only the minimum targeted root recovery needed for the current task and disclose that recovery.
- If the runner fails, do not create a replacement agent or silently change models. Report the failure briefly and use only minimum targeted root recovery when the parent task can safely continue.

Run `node <rg-skill-root>/scripts/rg.mjs doctor --repo <git-root>` when configuration, authentication, or filesystem access needs diagnosis. Read [configuration](references/configuration.md) when changing profiles, installation, or repository access.
