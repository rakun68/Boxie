# The task file and the context pack

Back to the [README](../README.md).

```markdown
---
files: [lykos/providers/gitlab-duo/oauth.ts]       # what the change is about
sealed: [lykos/providers/gitlab-duo/oauth.test.ts] # worker cannot edit these
test: "npx tsx --test some.test.ts"                # optional; default: sibling tests of `files`
---
Objective, required behaviour, out of scope.
```

`lib/pack.mjs` turns that into `context.md` deterministically: no model involved, same input gives the
same pack. From the context map it adds the areas the files belong to, their governing docs and ADRs,
the rules a change there can break, glossary definitions quoted from the repo, recent commits per
file, related tests and the narrowest verification command. It points at files; it does not paste them.
The map's `requires:` lists (top level, and per area for the areas a task hits) are the docs a change
must keep current; they go at the end of the task text as its definition of done, so the fix round and
both reviewers see them too.

**Sealed files** are enforced twice: an OpenCode `edit` deny rule, and a post-run diff check that
reverts any change made through bash before the harness runs the tests, flagged as `SEALED-EDIT`.

**BLOCKED**: workers are told they may stop with `BLOCKED: <reason>` when the task cannot be done as
written; the harness records it. This exit cut test-cheating sharply in ImpossibleBench (see research).
It is also how a worker asks a question: it phrases BLOCKED as one, and the orchestrator answers with
`continue`.

`issue: N` (or `owner/repo#N`, or a list) in the frontmatter makes `lib/pack.mjs` fetch the GitHub
issue on the host with `gh` (`lib/issue.mjs`) and append it to the task: body, comments, the issue its
`Spec: #N` line names in full, and other cited issues cut to 1500 chars. Being part of the task, it
reaches the worker, every `continue` and both reviewers. No GitHub token enters the container. A failed
fetch stops the run before the container starts.
