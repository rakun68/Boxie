# Roles and review

Back to the [README](../README.md).

## Roles (`agent-box.conf`)

| role | model | use |
| --- | --- | --- |
| implement | `antigravity/gemini-3.8-flash-high` | **every coding task starts here** |
| implement-hard | `deepseek/deepseek-flash-max` | the same bug failing twice (a different family, max effort) |
| quick | `opencode/deepseek-v4.1-flash-free` (free) | trivial edits whose place is known |
| escalate (= last-resort) | `deepseek/deepseek-flash-max` | after two failed rounds, with the failure history |
| write / draft | Opus 4.6 / Gemini 3.8 Flash high | prose that ships / drafts |
| explore | Gemini 3.8 Flash high | `delegate.sh explore`: read-only research digest |
| bughunt | Gemini 3.8 Flash high | `delegate.sh hunt`: reproduces, locates and pins a reported bug. Out of the workflow (2026-10-13): it added 23-30 min on Lykos T194/T174b and changed neither; the orchestrator hunts with an Opus 5.5 subagent instead |
| tests | Gemini 3.8 Flash high | ticket mode: writes the failing tests first |
| review-spec | Opus 4.6 (`antigravity/claude-opus-4-6-thinking`) | requirements, edge cases, test strength, against the spec |
| review-spec-alt | `deepseek/deepseek-flash high` | the spec review instead when the implementer is review-spec's family (Claude); `review`, the loop and ticket mode swap it in by themselves |
| review-std | `opencode/deepseek-v4.1-flash-free` (free) | the repo's documented standards, design, smells |
| review-both | `deepseek/deepseek-flash-high` (paid) | review mode `both`: one reviewer for both axes (`lib/ticket/review-both.md`) |
| review-both-alt | Opus 4.6 | review-both when DeepSeek wrote the code |
| transcribe | `opencode/deepseek-v4.1-flash-free` (free) | copies a review's findings out of its prose into the findings block when the reviewer did not write one; adds and judges nothing |
| adjudicate | Gemini 3.8 Flash high | settles a disputed finding (read-only); Kimi K3 left: cursor quota empty (2026-10-27) |
| advise / advise-alt | Sol 6.1 high (`cx/gpt-6.1-sol-high`) / Opus 4.6 | advisors, never coders: `ask` is one pass; in `council` advise reads the repo read-only; advise-alt also picks between fresh attempts |
| merge | `deepseek/deepseek-flash-high` | `council`'s merger: one pass over the members' answers into the digest, told to weigh evidence, not the advisor. `COUNCIL_MERGE` or `council --merge` names another role or an OmniRoute model id |
| free-deepseek / free-glm | `opencode/deepseek-v4.1-flash-free` / `opencode/glm-5.3-flash-free` | free models on OpenCode's own provider, not OmniRoute: container runs only. At the free limit the run goes on with `FREE_FALLBACK` in the same session (`summary.json` `fell_back_from`). The free tier may keep prompts for training |

One worker per task; `fanout` stays available but no workflow uses it. Independent tasks run in
parallel, up to `AGENT_BOX_SLOTS`.

**Review mode** (`REVIEW_MODE` in `agent-box.conf`, per project in `projects/<repo>.env`;
`lib/reviewmode.mjs`): `split` (the default) is two reviewers in parallel, review-spec and review-std;
`both` is one review-both covering both axes. `review`, `loop`, `loop resume`, `ticket`, `feature ...
run` and `ticket-review` take `--review-mode split|both` or `--roles a,b` (one axis: `--roles
review-spec`). Precedence: `--roles`, `--review-mode`, a project's `REVIEW_ROLES`, `REVIEW_MODE`. Every
reviewer gets the spec, with the same prompts everywhere (`lib/ticket/review-*.md`).

Budget (user, 2026-10-12/13). Quota pools: Opus and Sonnet share one, all Gemini models share one;
DeepSeek and Kimi each have their own. Gemini does the bulk; DeepSeek takes escalation, the quick
lane, the standards review and review-both; Opus (~$30-40 per 5 hours) the spec review and prose;
Sol 6.1 (`cx/`, the Codex subscription) advice; Gemini disputed findings (Kimi K3 left 2026-10-27). Unused: Sonnet (spends Opus's pool) and Composer
(misreported tool results and passed an impossible task without BLOCKED, research/findings.md §6).

Antigravity Gemini 3.8 Flash comes as three ids, `-low`, `-medium`, `-high` (top); since OmniRoute
3.8.52 `gemini-3.8-flash-tiered` is only an alias of `-high`. OmniRoute drops `reasoning_effort` for
`antigravity/claude-*` and refuses their `-high` ids, so Opus runs on its base id. DeepSeek, `cx/` and
Cursor ids carry their effort in the name. Codex/GPT models are not coding workers: they fail at multi-step agent work
through this router. GPT-5.6 Sol and Grok 4.6 are not available (2026-10-12).

Measured so far (one task each, so treat as anecdotes): on a comment fix, Composer 134 s and Gemini
3.8 Flash 280 s both passed; on the dual-loopback fix, DeepSeek 326 s and Gemini 669 s both passed.
