# Choose a shape for the task

Apply the skill's selection rule and design method first. These are interaction
patterns, not activation triggers or a catalogue of dashboards to build.
A workspace may mix native kinds, HTML/CSS, generated images and pointer handlers.
It is a Python process, not a browser: no JavaScript or arbitrary DOM APIs.

| Pattern | Useful shape | Updates and optional interaction |
| --- | --- | --- |
| Watcher | Progress, blockers, evidence and freshness | Read changing external state; inspect details; controls only if useful |
| Workbench | Pinned comparisons, source-linked notes or a stepped explanation | Local edits, artifacts, agent results or example inputs; annotate, compare or explore |
| Queue | Stable item identities, preview/diff and disposition | New items and individual verdicts; inspect, accept, reject or defer |

For an explanatory workbench, let local navigation or example inputs reveal
relationships and consequences. Keep sources, assumptions and illustrative
scenarios distinct from observations of a real system; a simulated outcome is
not a live health check.

## Layout

- Put the working question or concept first; raw fields belong in details.
  Keep evidence attached to decisions and feedback to its candidate.
- Design for a narrow split (~50 columns). Wrap badge rows, clamp long titles,
  collapse low-value details. Don't shrink labels to cram in a desktop layout.
- Group things that share a decision or activity, not just a data source.
  The task determines the boundary; an object's existence does not justify a pane.
- Native semantic tones plus text: success, error, warning, pending, muted.
  Never use colour alone to encode state. Unknown is not success or zero.
- Main scrolls; the kit's dock pins freshness/keys; the layer carries transient
  notices and confirmation. `r` refreshes; `q` closes when no action is running.
- Table cells are display-only; use keyed cards/rows/list items for individual
  click/context-menu actions. SVG/PNG blobs can show any geometry, but pixel
  coordinates are not an arbitrary custom interaction surface.

## Data and transitions

Choose update sources deliberately. A local workbench may change only through
user input, file changes, or new agent results; do not invent a remote polling
dependency. Keep annotations and draft decisions separate from replaceable
fetched data so refreshes cannot erase the user's work.

For external state that benefits from polling:

| Situation | Typical interval |
| --- | --- |
| Active rollout or experiment within an ongoing workflow | 15 seconds |
| Review queue awaiting responses | 2–5 minutes |
| Slow provisioning or handover | 15–30 minutes |

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

## Interactions

Local selection, filtering, annotations and draft verdicts update app-owned
state. Distinguish a recorded decision from applying or publishing it.
Links and copy are local; `ask`/`pick` queue context for the agent's `wait`.
Commands affecting repositories, processes, files outside workspace state, or
external systems go through `board.command`: explicit target, exact command,
confirmation, result event, then refresh. For judgment-heavy or underspecified
actions, prefer an agent request rather than guessing a command.

Use optimistic-revision checks (for example an MR's observed SHA), not a
stale UI badge as authorization. Disable unsafe choices and label irreversible
side effects. The bundled fixture mode prevents command execution.
