# Choose a UI for the question

Do not let the example dictate the app. A task-specific UI may mix native kinds,
HTML elements with a stylesheet, generated SVG/PNG blobs and pointer handlers.
It is a Python process, not a browser: no JavaScript or arbitrary DOM APIs.

| Question | Useful shape | Action |
| --- | --- | --- |
| What blocks this work? | Ticket cards with MR rows, gate checklist, hazard banner | Open MR, explain blocker, confirmed merge |
| What is still progressing? | Resource cards, progress, transition timeline | Inspect logs, request diagnosis |
| Which option do I want? | Option cards with rationale/tradeoffs, pick buttons | Emit a choice to the agent |
| What needs review? | Selectable queue, preview/diff, disposition controls | Keep/skip/approve under task scope |
| How is the run doing? | Stage checklist, chart, current command/log excerpt | Open output, confirmed stop |
| Which leads need attention? | Stage groups, age/deadline, selected lead details | Open contact, queue reply request |

## Layout

- Put the answer and next action first; raw fields belong in details. Carry in
  context the API cannot know: runbook gates, dependencies, deadlines, hazards.
- Design for a narrow split (~50 columns). Wrap badge rows, clamp long titles,
  collapse low-value details. Don't shrink labels to cram in a desktop layout.
- Group things that share a decision, not just a data source. Several repos for
  one issue belong together. A single changing MR can still justify a board.
- Native semantic tones plus text: success, error, warning, pending, muted.
  Never use colour alone to encode state. Unknown is not success or zero.
- Main scrolls; the kit's dock pins freshness/keys; the layer carries transient
  notices and confirmation. `r` refreshes; `q` closes when no action is running.
- Table cells are display-only; use keyed cards/rows/list items for individual
  click/context-menu actions. SVG/PNG blobs can show any geometry, but pixel
  coordinates are not an arbitrary custom interaction surface.

## Data and transitions

| Situation | Typical interval |
| --- | --- |
| Running CI / short job | 15 seconds |
| Waiting on reviews / idle work | 2–5 minutes |
| Long provisioning / handover | 15–30 minutes |

Choose cadence from actual task behaviour and API limits; `every(data)` supports
adaptive intervals. The kit keeps polling while hidden because the agent may
still need a completion event; Tern coalesces drawing until visible again.

`changes(old, new)` should emit terminal transitions, new blockers, meaningful
review changes or an explicit requested signal. Do not emit on timestamps,
unchanged values or every fetch. First load establishes a baseline, not a flood
of “new” events. If polling only open items, retain tracked IDs or explicitly
query disappearance: a missing item is not proof it merged.

Keep per-item fetch failures in the data with an error badge rather than
silently dropping rows. Global fetch failure leaves the last successful view
visible with its age and error. Don't overwrite a known state with invented
zero approvals or an assumed healthy pipeline.

## Actions

Links and copy are local. `ask`/`pick` queue context for the agent's `wait`.
A mutation goes through `board.command`: explicit target, exact command,
confirmation, asynchronous execution, result event, then refresh. The app can
perform it directly; no agent turn is required. For judgment-heavy or
underspecified actions, prefer an agent request rather than guessing a command.

Use optimistic-revision checks (for example an MR's observed SHA), not a
stale UI badge as authorization. Disable unsafe choices and label irreversible
side effects. The bundled fixture mode prevents command execution.
