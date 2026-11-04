# Choose a shape for the task

Apply the skill's selection rule and design method first. These are interaction
patterns, not activation triggers or a catalogue of dashboards to build.
Default to native kinds; use HTML/CSS or generated images only for gaps in the
native vocabulary. It is a Python process, not a browser: no JavaScript or
arbitrary DOM APIs. Follow Tern's [Designing Views](https://docs.stencil.so/tern/guides/design.md)
for the native look, not a custom stylesheet.

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
- Native tables support row selection, right-click menus and button cells;
  the app owns sorting and the selected data id. Keep cards for items grouped by
  one decision. SVG/PNG blobs show geometry, not arbitrary coordinate events.

## Native views

Target Tern 0.9.9+ and the kit's pinned SDK. Start with a title row, the working
view and the kit's freshness/key dock; add navigation or summary tiles only
when the task needs them. Sans is already enabled; keep refs, paths, commands
and numeric columns monospaced. Use semantic tones, not custom status colours.

| Need | Native choice and constraint |
| --- | --- |
| Actions and local modes | `button`/`buttons`; one primary action, quiet secondary actions, `sm` inside rows/details. Mark selected modes with `on`/`active`, not `primary`. `busy` and a disabled reason express real state. |
| Choices and settings | `select`, `switch`, `slider` or `date` inside `field` rows. Store picks in draft state; choosing a value is not applying it. Free text still needs working focus/key/edit handling. |
| A queue and its selection | A full-width selectable `table`, optionally beside the selected object's `card` in a resizable `split`. No card around a table or another card. Stack or show one panel when narrow. |
| Navigation and overflow | Segmented `tabs` for local filters, `nav`/`breadcrumb` for places, `pager` for bounded pages, `menu` for secondary commands; render only the active view. |
| Headline values and trends | At most four `stats` directly on the page; `chart` line/area for observed series, donut for a real whole. Keep unknown distinct from zero; never invent history to fill a chart. |
| Evidence and work history | `code`/`diff` with source line numbers and useful folds; source citations for claims; `trace` for observed steps, `checklist` for a plan. Do not portray a planned tool call as completed work. |
| Details and transient states | Card `icon`/`meta`/`end`, scroll areas for bounded logs, sheets/drawers for temporary detail. `skeleton` names the expected shape; `empty` explains what is missing and a useful next action. |
| Conversation and questions | `message`, `attachment`, `suggestions` or `questions` only when they serve the task. Wire requests to `ask`/`pick` and the relay; the widget itself cannot wake an agent. |

Value controls are not browser-managed forms: handle their events, update
app-owned state and render the accepted values again. Sorting, filtering and
paging must preserve the selected data identity, not its row position.
See the [event contracts](sdk.md#value-and-navigation-events) before wiring them.

Keep confirmation in `board.command`; a native tool-approval widget or an
“Always” option does not grant new scope or authorize later commands. Do not
replace the kit's exact-command confirmation with an unguarded callback.

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
