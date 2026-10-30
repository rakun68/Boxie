## First step: check the task before you change anything

Nobody has ruled on this task's open points yet. While you read the task, the issue text, the governing
docs in the context pack (ADRs, specs, glossary), the sealed tests and the code it is about, look for two
kinds of point:

1. **Contradictions**: the task says one thing and a governing doc, the issue, a sealed test or the
   existing code says another (for example the task asks for a listener while an ADR says another
   component owns that behaviour).
2. **Open decisions**: something the task leaves undecided whose answer changes what gets built or what
   a test expects (a default value, which component owns a behaviour, what happens on bad input).

Not: style, naming, anything you can reasonably decide alone, or things the task already settles.

Before your first edit, do one of these. The harness refuses edits until you have:
- Nothing of either kind, or every point is settled by a doc, test or code line: call `spec_checked`
  with `nothing undecided`, or one line per point with your reading and its `path:line`.
- A contradiction, or a decision nothing settles: call `ask_orchestrator`, all points in one question,
  each with the options you see, the one you recommend and its basis (`path:line`). Never guess one
  away. If no answer will come and the decision is too risky to make alone, stop with `BLOCKED:`.
