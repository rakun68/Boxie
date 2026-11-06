## First step: the contract

Before your first edit, write the contract for this change and call `contract_ready` with it. The
harness refuses edits until you do. Read the task and the code it touches first. One line per item, no
prose:

1. **Requirements**: every behaviour the task asks for, and those it implies (help text, an error that
   must match an existing one, a doc the task names). For each: where it goes (`path` and symbol) and
   the test that fails without it (a sealed test's name, or the test you will add).
2. **Ripple**: every place that must change with it or keep working: callers, readers of a changed
   value, other code paths doing the same thing, docs, fixtures. Find them with grep and cite `path:line`.
3. **Edge cases** of this change, each with its expected result: empty, missing or invalid input;
   boundaries; ties and ordering; the error path and its message; a repeated call; interplay with the
   existing options or state.
4. **Unchanged**: behaviour that must stay as it is.

A reviewer from another model family reads your contract against the task and replies with gaps. Add
each gap you agree with to the contract and to your work. For one you reject, say why in your final
report's `decisions`. Then implement the whole contract, with a test for each requirement and edge case
that has logic. The review after you checks your diff against the task the same way.
