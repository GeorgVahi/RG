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

## Local installation

Install or link the repository as a user skill under the active Codex skill directory. Keep implicit invocation enabled in `agents/openai.yaml`. A concise global `~/.codex/AGENTS.md` rule may require `$rg` before non-trivial repository search; new sessions are required for global instruction changes.

Run the diagnostic without spending a model turn:

```text
node <rg-skill-root>/scripts/rg.mjs doctor --repo <git-root>
```
