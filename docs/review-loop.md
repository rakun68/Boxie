# The review and fix loop

Back to the [README](../README.md).

**The review and fix loop** (`delegate.sh loop <repo> <run>`, `lib/loop.mjs`, `lib/verify.mjs`).
The loop refuses a run with no sealed acceptance test (`--no-spec` overrides): without one, reviewers
become the spec. Round 1 is the only full review, by the review mode's reviewers. Every behaviour finding carries a
reproduction (a file under `/tmp` and a command); one check container per round reruns all of them on
the branch, with the existing tests next to the change (same stem, or importing a changed module; at
most `LOOP_NEIGHBOURS`). The harness's result decides, not the reviewer's CONFIRMED:

| finding | goes to |
| --- | --- |
| reproduction fails on the branch, critical/high/medium, with a `basis` (the clause it defends) | the worker, with the reproduction; blocks |
| the same without a `basis` | sent with the next fix as advice |
| category `regression`: fails on the branch and passes on the base | blocks (failing on the base too: a note) |
| reproduction fails, low | merge note; sent with the next fix as optional |
| reproduction passes on the branch | dropped, labelled `review_false_positive` |
| after round 1, in a file the fix did not touch, no failing reproduction | merge note |
| `spec_question` | stop: `next: answer_spec` |
| no reproduction, CONFIRMED critical/high logic, edge case, security or requirement | stop: `next: triage` |
| no reproduction, other medium+ | sent with the next fix; one advice-only fix round at most |
| a test next to the change fails on the branch and not on the base (names compared) | a regression; blocks |
| a proof fixed in an earlier round fails again | reopened; blocks |
| the worker disputes a finding (`disputes` in its report) that still fails | stop: `next: triage` |

Every proven reproduction joins the proof suite, rerun every round. A fix round sends everything open
at once and tells the worker to run the proof suite and the neighbour tests green before it ends.
After a fix, the round-1 reviewer sessions are resumed on it (`continue --at agent/<fix>`, at most
`LOOP_RECHECK_STEPS` steps): the spec reviewer, and the standards reviewer when one of its findings was
sent; in mode `both`, the one review-both session. Each gets every sent finding, so a session on a model matching `LOOP_RECHECK_AVOID` (default
`opus`, the scarce quota) is left out while another can recheck. There is no final full review. Beside the first review, the base's whole suite runs once per
base commit (`BASE_SUITE_CMD`, default the project's `TEST_CMD`; `LOOP_BASE_SUITE=0` turns it off) and
its failing test names are kept in `runs/<project>/.basecache/<sha>.json`: checks then run the neighbour
tests on the branch only and compare names. Without a usable suite result (a crash, a timeout, no
names) a check runs the base itself, once per test set. Each check logs its seconds per step
(`BOXIE-TIME`), shown by `loop-watch`. A stall (a reproduction still failing after `LOOP_STUCK` (2) fixes, a regression or a
re-broken proof after 1, serious items after `LOOP_SOFT_ROUNDS` (2) fix rounds, `LOOP_MAX_FIXES` (3)
fix rounds, or a fix that fails its own tests) starts `LOOP_FRESH` attempts once, in parallel from the
base, with the task, the rulings and the proof suite (no earlier diff); each passing one is checked
against the proofs and the neighbours, `LOOP_SELECTOR` picks between equals (the smaller diff when it
cannot), and the pick gets a full review. A second stall, or `LOOP_MAX_ROUNDS` (5) reviews:
`next: decide`. A round that stopped before its review or check finished runs again on `resume`.
`loop resume <repo> <loop>` takes the orchestrator's `--answer` (also given to every later reviewer),
`--drop`, `--add`, `-m` and `--max-rounds`, and goes on. At the start and on a resume the orchestrator
also picks `--review-mode`, `--roles`, `--fresh ROLES|none` (one role: a single fresh implementer;
`none`: a stall stops for it) and `--max-fixes`; new reviewers on a resume make the next review cold. State:
`runs/<project>/_loops/<name>/state.json`. Review runs are capped at `REVIEW_STEPS` (90) steps.

**A turn cut off at the output cap** (step reason `length`, Gemini thinking ~30,700 tokens of a ~32k
cap, Lykos T174b) is resumed in the same session up to twice (`CUT_RESUMES`) before the run ends;
`cut_resumes` in the summary counts them.

**What a resume re-reads.** How steps run comes from the config as it is now: `LOOP_BASE_SUITE`,
`BASE_SUITE_CMD`, `LOOP_PARK`, `LOOP_LIVE_ASK`, `FAIL_REGEX`, `NEIGHBOUR_SOURCES`, `LOOP_NEIGHBOURS`.
The caps, reviewers and fresh roles stay as the loop started, unless the resume's flags change them.

**Orchestrator text.** `--add` and `-m` text no fixer has received gets one fix round before the loop
can approve. Text still unsent when the loop stops is kept and sent by the resume.

**Flakes.** A neighbour-test regression is run once more. Only tests that fail both times count; a
flake is logged as `flaky` in `progress.jsonl`.

**Unreviewed findings in prose.** When a reviewer's findings stay in prose after it is asked for the
block, `ROLE_transcribe` (a free model) copies them into the block, adding and judging nothing. The
loop then reruns each reproduction as usual. `ROLE_transcribe=""` turns it off.

**What an approve did not check.** `next: approve` comes with `unchecked:` lines (also in `--json`):
the whole suite did not run on the branch, with the `delegate.sh check <repo> agent/<run> --test
"<cmd>"` command that runs it, and on a Windows host, that only a Linux container ran the tests. The
orchestrator decides from the change's risk whether to run them.

## open-code-review as the reviewer (`--reviewer ocr`, `LOOP_REVIEWER=ocr`)

Off by default until a pilot on real tasks. open-code-review has no shell, so its findings carry no
reproduction: the fixer proves them, and the harness checks the proof.

1. **Round 1** reviews the whole change from the run's base: one run (`LOOP_OCR_DEPTH=normal`, `--depth`)
   or `REVIEW_DEEP_RUNS` runs merged by problem (`deep`), at the first `LOOP_OCR_EFFORT` (`medium`).
   `LOOP_FULL_ROUNDS` (1) whole-change rounds run before the next step.
2. **Triage, by code** (`ocrRoute`):

   | finding | goes to |
   | --- | --- |
   | says the code does not build, with `BUILD_CMD` set | the build runs in the round's check: passing drops it (`review_false_positive`), failing makes it a proven item |
   | medium+ logic, edge case, security or requirement | the fixer: write a test that fails on the current code, then fix; or decline it |
   | other medium+ (performance, maintainability, standards) | sent with the fix as advice, no proof |
   | low | a note, optional for the fixer (`LOOP_LOW=fix`: advice) |

3. **The fixer's proof.** It lists `proofs: [{finding, test}]` in its report. The harness runs each named
   test on the code from before the fix (the red check, no neighbour tests): it must fail there. A test
   that passes there proves nothing and the finding stays open; a finding with no test stays open; both
   count toward the stall rules. A proven test joins the proof suite and reruns every round. A finding
   the fixer lists under `disputes` is declined: it leaves the loop, is never labelled false, and the
   brief lists it with the reason for the orchestrator.
4. **Later rounds** review only what changed since round 1 (`--against` the first reviewed commit), one
   run, at the second `LOOP_OCR_EFFORT` (`low`). The review is told what earlier rounds fixed (with the
   test), sent, declined and noted, so it does not raise them again. Rounds repeat until one is clean,
   within `LOOP_MAX_FIXES` and `LOOP_MAX_ROUNDS`.

The loop ends when nothing proven or pending is left: a clean first round, a clean later round, or only
declines and notes. The brief adds `cost:` (rounds, minutes, proofs, declines, drops; also `metrics` in
`state.json`) and `slow checks:` (steps over 60 s, for the project to speed up). The build runs once per
check however many claims need it.

Why this shape (54 recorded loops, 2026-11-05): the first review found 56 of the 73 blocking findings
of the review and fix rounds; a harness check took 92 s at the median against 522 s for a review and
884 s for a fix; 14 of the 74 blocking findings were requirements, so the task and every `--spec` reach
open-code-review as its background.
