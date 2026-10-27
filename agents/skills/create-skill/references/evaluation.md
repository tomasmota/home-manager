# Evaluating skills

Read this when creating test cases, improving an existing skill, measuring activation, or comparing revisions. Use the smallest evaluation that answers the actual question; a bespoke harness, dashboard, benchmark, or CI integration is not a prerequisite.

## Define success and choose cases

Before expanding the instructions, identify the user-visible outcome, required inputs, permitted side effects, and a few failure modes. Ground cases in actual work, user corrections, or sanitized project artifacts rather than generic advice.

Start with 2–3 realistic prompts, including a boundary or failure case. A narrow edit can reuse existing cases and add the case that exposed it. For a small instruction-only skill, one observed consumer smoke plus a focused boundary check may be sufficient; report that limited coverage. For subjective work, compare actual outputs and request human feedback rather than forcing arbitrary numeric assertions.

Store reusable cases in `evals/evals.json` when useful. This is a convention, not a schema imposed by the Agent Skills standard:

```json
{
  "skill_name": "change-notes",
  "evals": [
    {
      "id": 1,
      "prompt": "Write release notes from the supplied changes; exclude chores.",
      "expected_output": "Features and Fixes preserve the supplied descriptions, with no chore entry or invented breaking-change claim.",
      "files": ["evals/files/changes.json"],
      "assertions": [
        "Each feature and fix is represented in its correct group.",
        "A missing breaking flag does not create a breaking-change claim."
      ]
    }
  ]
}
```

Keep fixtures synthetic or sanitized for their owner. Public evals must not contain private/team content, credentials, private URLs, customer data, or captured confidential outputs. Store traces, snapshots, generated artifacts, and feedback in a scratch workspace outside installed/discovered skill directories and outside a public checkout when the data is private. Give destructive or remote workflows harmless local fixtures or an authorized read-only/dry-run path; never exercise a live mutation merely to prove a skill works.

## Establish a fair baseline

- New skill: the same user task without the skill.
- Revised skill: snapshot the complete previous skill before editing and run that version against the same task.
- Match inputs, model, tools, permissions, and environment. The comparison should differ in the skill, not in extra hints supplied to one run.
- Use a fresh context and separate output directory for every case and variant. A subagent is suitable when it actually starts clean; a separate session is another option.
- Ensure the candidate has not leaked into the baseline through global instructions, installed discovery, or shared conversation. If isolation is unavailable, label the comparison as limited instead of claiming a controlled A/B result.

For a creator skill, keep evaluation bounded: test the generated skill on its consumer task; do not recursively create creators or spawn unbounded evaluation trees. Preserve the original owner and publication scope in every child task.

## Run and inspect the changed behavior

1. Supply the test prompt, input files, candidate path when applicable, and a dedicated output directory. Do not silently add the answer or desired procedure to the prompt.
2. Execute the actual workflow. Capture outputs and the available tool trace; inspect the result, not just the final claim of success.
3. For bundled scripts, run representative valid input and a relevant boundary/error path. Check actual values, output artifacts, exit status, and useful errors. Run through `uvx` or `uv run` for Python tools and scripts.
4. For relative-path or packaging changes, run from another working directory. Extract an archive into a fresh workspace and verify its own resources, not the still-installed source.
5. For client controls, verify behavior on the named client. A YAML parser cannot prove a host honors an invocation or permission setting.
6. Record failures and unavailable checks explicitly. If credentials, a target client, or safe runtime access are unavailable, complete the safe reachable checks and report exactly which behavior remains unverified.

A scripted simulation can verify a deterministic helper, but it does not prove that an agent selected or followed the skill. Likewise, force-loading a skill is useful for output quality, not evidence of implicit discovery.

## Grade outcomes with evidence

Start with expected outputs; refine concrete assertions after seeing an initial run. Assertions should describe consumer-visible behavior or safety boundaries, not require source wording or incidental tool sequences.

Useful checks include correct totals, preserved records, precedence rules, missing-input handling, unchanged sources during an audit, or absence of an unauthorized side effect. Avoid checks that merely count files, demand an exact phrase, confirm a helper was forwarded an argument, or always pass regardless of the output's correctness.

Use code for mechanically checkable properties. Review qualitative outputs with a human; a model judge can assist, but its confidence is not evidence. A PASS needs an artifact, trace event, observed state, or specific output supporting it. Mark unexecuted checks as not run, not passed.

For each case, record:

- Variant and the actual candidate/model/environment used.
- PASS/FAIL/not-run per assertion and concrete evidence.
- Actual output locations and relevant trace excerpts.
- Duration and tokens only if exposed by the runtime; do not estimate them as measurements.
- Qualitative feedback and the cause of a failure when established.

For a small sample, show raw outcomes and deltas. Repeated runs are needed before drawing reliability conclusions or reporting meaningful variance. Do not hide a consequential failure behind an aggregate pass rate. Check whether both variants pass because the task is already handled without a skill; retain important safety invariants, but do not inflate claimed improvement with trivial checks.

## Test activation separately

A good workflow is useless if the agent never loads it, and harmful if it activates on unrelated tasks. Build a labeled query set; `evals/trigger-queries.json` is a useful convention:

```json
[
  {"query": "turn these changes into release notes", "should_trigger": true},
  {"query": "explain semantic versioning", "should_trigger": false}
]
```

Use several positive phrasings: explicit requests, indirect intent, terse or typo-filled prompts, and realistic tasks with context. Negative cases should be near-misses sharing terms but needing a different workflow, not unrelated trivia. State important exclusions in the description rather than keyword-stuffing or making every request a match.

Run each query in a fresh session with the candidate registered and discoverable through the target client's real mechanism. Observe whether its `SKILL.md` was loaded in the trace. A classifier predicting activation, mentioning a skill's name in output, or explicitly instructing the agent to load it does not measure implicit activation. If a higher-priority rule forces skill loading, report that selection was policy-forced rather than attributing it to the description.

When actively optimizing a description:

1. Start with a small, balanced set; expand toward roughly 20 queries, including hard near-misses.
2. Keep a fixed, balanced training/validation split. Use only training failures to guide edits; reserve held-out queries for selecting/checking generalization.
3. Repeat runs when reliability matters; three runs per query is a practical starting point. Report false positives and false negatives, not just an overall score.
4. Front-load the user goal and strongest trigger terms, preserve the 1024-character limit, and add exclusions where false positives show a real scope boundary.
5. Choose the revision that generalizes, not automatically the last revision. Finish with fresh queries not used during optimization.

For ordinary creation, a few genuine positive/negative probes can be enough. Do not force a large optimization campaign on a trivial skill or invent activation rates when the host cannot expose them.

## Iterate without growing a rule pile

Use failed outputs, execution traces, and user feedback together. Fix the general cause, not the individual test wording. Remove instructions that cause wasted work; explain why non-obvious constraints matter. Bundle a tested helper only when runs repeatedly recreate the same deterministic logic.

Rerun affected cases against the baseline, then the remaining relevant cases. Test each intended client/model when cross-client or cross-model compatibility is claimed; otherwise name the tested environment. Stop when the task's success criteria are met. Do not claim statistical reliability from a handful of runs.

## Replaying this skill's cases

The bundled `evals/evals.json` covers private scratch creation, in-place revision with ZIP delivery, and a findings-only audit. Its `setup` property is a local fixture convention: a mapping from workspace-relative filenames to synthetic text contents, not shell commands.

1. Create a fresh workspace outside installed skill directories for each case and variant. Reject absolute paths and `..` path components in fixture names, then write the `setup` files beneath that workspace. Replace `$WORKSPACE` in the prompt with its absolute path.
2. Give a fresh agent the candidate skill, the expanded prompt, and its input files. Do not supply the expected output, assertions, or another variant's results as hints. Constrain writes to that workspace; staging is not permission to install or publish.
3. Grade the actual artifacts against `assertions`. For an audit, compare input hashes and the input inventory before/after. For a bundle, inspect ZIP contents, preserve excluded source fixtures, extract elsewhere, and exercise the extracted workflow.
4. Use distinct workspaces and the frozen previous candidate for revision comparisons. Treat these few cases as regression smokes, not a reliability benchmark.

`evals/trigger-queries.json` is a separate balanced activation set, not evidence of measured trigger rates. Use the target-client procedure above if activation is the question being investigated.

## Authoritative sources

- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
- [Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills/)
- [Anthropic skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Anthropic skill-creator evaluation and refinement workflow](https://claude.com/resources/articles/improving-skill-creator-test-measure-and-refine-agent-skills)
