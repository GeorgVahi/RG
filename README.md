# RG

RG is a Codex skill for delegating non-trivial repository search to explicit, cheaper model tiers while keeping the parent agent focused on implementation and decisions.

Its default route is deterministic:

1. `gpt-5.6-luna` with low reasoning performs a bounded, read-only search.
2. `gpt-5.6-terra` with medium reasoning runs only after a valid Luna result reports a configured semantic evidence gap.
3. Authentication, availability, quota, timeout, malformed output, and fingerprint failures stop the route. They never silently switch models.

The implementation adapts OpenBuild's exact-model worker pattern: explicit `codex exec -m`, pinned reasoning effort, ChatGPT subscription authentication, provider/env hardening, read-only sandboxing, multi-agent disabling, strict JSON evidence with safe line-range bounding, worktree fingerprints, bounded artifacts, and terminal receipts.

Line ranges that begin inside a repository file are bounded to that file and to 200 lines in the returned result. The raw model artifact is retained unchanged in the run directory for auditability.

## Requirements

- Node.js 20 or newer
- Git
- Codex CLI authenticated with ChatGPT (`codex login status`)
- access to the configured Luna and Terra models

No npm dependencies are required.

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

- Before non-trivial repository grep, file/symbol/owner/test discovery, dependency tracing, or cross-file evidence gathering, use the installed $rg skill. Direct reads remain appropriate for an explicit or already-known path and for Git metadata.
```

## Use

Implicitly, ask Codex to locate or trace code. Explicitly, say `Use $rg to find ...`.

The runner can also be invoked directly:

```text
node scripts/rg.mjs search --repo <git-root> --mode auto --query <bounded request>
node scripts/rg.mjs search --repo <git-root> --mode fast --query <bounded request>
node scripts/rg.mjs search --repo <git-root> --mode deep --query <bounded request>
node scripts/rg.mjs doctor --repo <git-root>
```

- `auto`: Luna first, evidence-gated Terra second.
- `fast`: one Luna pass.
- `deep`: one explicitly requested Terra pass.

An `auto` search can take longer than a shell tool's initial wait window. A returned live `session_id` is an in-progress command, not a failed search: keep polling that same session until the process exits and emits the final `rg.run.v1` JSON. The `RG: starting ...` and `RG: completed ...` lines are progress only.

Configuration precedence and the immutable routing constraints are documented in [references/configuration.md](references/configuration.md).

## Verify

```text
npm test
npm run validate
npm run doctor
```

Run artifacts and receipts are written outside the target repository under `$CODEX_HOME/rg/runs`.

## License and attribution

RG is MIT-licensed. Its runner architecture is adapted from [OpenBuild](https://github.com/GeorgVahi/OpenBuild); see [NOTICE](NOTICE).
