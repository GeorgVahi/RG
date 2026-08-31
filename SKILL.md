---
name: rg
description: Route non-trivial repository code search, broad rg, file/symbol/owner/test discovery, dependency tracing, and cross-file evidence gathering through a read-only Luna-first scout with evidence-gated Terra escalation. Use automatically before doing substantial codebase search; do not use for explicit path reads, Git metadata, web search, or edits.
metadata:
  short-description: Exact-model repository search with Luna and Terra
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

1. `gpt-5.6-luna` with low reasoning performs the first read-only search.
2. `gpt-5.6-terra` with medium reasoning runs only when the Luna result is valid and reports one of the configured semantic evidence gaps.
3. Authentication, CLI, model availability, timeout, malformed output, fingerprint drift, or another transport failure never switches models.

Use `--mode fast` only when the request explicitly prefers the cheapest single Luna pass. Use `--mode deep` when the user explicitly requests Terra or the task is already known to require a deep read-heavy scan. Do not choose `deep` merely because a repository is large.

Keep the request bounded and outcome-oriented. Include the symbols, behavior, suspected area, or evidence needed, but do not paste unrelated chat history.

The route may outlive the shell tool's initial wait window. If the invocation returns a live `session_id` or `cell_id` without a terminal `exit_code`, the runner is still working: continue the same process with the tool's `write_stdin` or `wait` mechanism until it exits. Lines such as `RG: starting ...` and `RG: completed ...` are progress messages, not the structured result and not a failure. Never start fallback recovery while that process is live.

## Consume the result

Accept the result only when the runner returns `schema: "rg.run.v1"` and `status` is `completed` or `completed_with_gaps`. The nested `result` has the strict `rg.discovery.v1` evidence contract.

Classify the runner as failed only after the process has exited or otherwise reached a terminal state without a valid result. Parse the accumulated output through the final `rg.run.v1` object; do not judge an in-progress output chunk in isolation.

- Use its owners, tests, couplings, flows, constraints, and uncertainties as a map.
- Verify material conclusions with targeted reads of returned `path:line` ranges.
- Do not repeat broad root searches already covered by valid evidence.
- If `status` is `completed_with_gaps`, perform only the minimum targeted root recovery needed for the current task and disclose that recovery.
- If the runner fails, do not create a replacement agent or silently change models. Report the failure briefly and use only minimum targeted root recovery when the parent task can safely continue.

Run `node <rg-skill-root>/scripts/rg.mjs doctor --repo <git-root>` when configuration or authentication needs diagnosis. Read [configuration](references/configuration.md) only when changing RG profiles, model maps, or installation behavior.
