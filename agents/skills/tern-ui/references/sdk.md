# SDK and kit reference

The CLI pins `tern-sdk==0.2.0` in an isolated uv environment and adds this skill's
`scripts/` to `PYTHONPATH`. No global package install. App scripts use PEP 723
`requires-python = ">=3.11"`; declare additional dependencies there when needed.

Authoritative sources: [Python SDK](https://github.com/stencil-hq/tern-sdk/tree/main/python),
[TSP](https://docs.stencil.so/tern/protocol/index.md),
[elements](https://docs.stencil.so/tern/elements/index.md),
[Designing Views](https://docs.stencil.so/tern/guides/design.md),
[styling](https://docs.stencil.so/tern/styles/index.md).
The SDK is bundled functionality, not a separate skill to discover.

## Kit API

```python
from tern_sdk import ui
from ternui import Board, command_json

board = Board(
    "My work",
    fetch=lambda: {"state": "running"},  # replace with actual read-only source
    view=lambda b: ui.card(ui.text(b.data["state"]), head="Current state"),
    every=120,                          # or lambda data: interval_seconds
    changes=lambda old, new: [],         # iterable of {"text": ..., **payload}
)
raise SystemExit(board.run())
```

`fetch()` runs single-flight off the UI thread. Return JSON-compatible data so
you can supply an explicit fixture. Errors retain last-good data. `view(board)`
is called on the UI thread only after a successful fetch; return a native Node.
Build `view` without I/O. `changes` runs on the UI thread after refresh, not on
the first successful fetch. Return only meaningful transitions; don't mutate
old data before comparing it.

| API | Behaviour |
| --- | --- |
| `b.data`, `b.error`, `b.checked_at`, `b.busy`, `b.fixture` | Last-good data, fetch error, successful epoch timestamp, in-flight fetch, fixture flag |
| `b.agent_session` | PI session that opened the board, else `None`; user-opened boards have no listener, so hide ask/pick actions |
| `b.notify(text, sub=None, tone="info")` | Toast, removed after five seconds |
| `b.emit(type, text, **data)` | Append structured event for `wait` |
| `b.ask(text, **data)` / `b.pick(text, **data)` | Queue agent request/choice and show delivery limitation |
| `b.copy(text)` | macOS clipboard, with feedback |
| `b.command(label, argv, cwd=None, timeout=60)` | Confirmation with exact argv/directory; background command; result event and refresh; disabled for fixtures |
| `b.refresh()` | Request another fetch, without overlapping an existing one |
| `b.blob(bytes, mime)` | SDK blob ID live, `None` in plain mode; supply image alt text |
| `b.run()` | Parse `--once`/`--fixture PATH`, then run live or plain fallback |
| `command_json(argv, cwd=None, timeout=60)` | Capture a read-only command's output and parse JSON; errors raise |

Optional arguments above are keyword-only. Mutating command stdout/stderr tails
(up to 8,000 characters each) enter the `ran` event: use only commands whose
output is safe to persist. All subprocess I/O is captured, and commands receive
no tty input. Additional Python prints in live mode go to `app.log`.

Events are JSONL objects with `id`, `at`, `board`, originating agent `session`,
`type`, `text`, and `data`. The CLI's `cursor` is a byte offset; one locked
consumer reads complete lines. A queued request is not automatic agent input.
The kit writes `status.json` with pid, connected/visible/closed, last fetch
error and Tern render errors. CLI launch metadata is separate in `launch.json`.

## Native vocabulary

All builders accept `key=`, `tone=`, `title=` (tooltip), `href=`, layout bounds,
`on_click=`, `on_menu={"action-name": handler}`, and other applicable handlers.
A handler receives a typed event. Stable **sibling** keys determine reconciled
node IDs; don't put a duplicate key among siblings.

| Builders | Useful shape |
| --- | --- |
| `ui.col(*children, gap="sm")`, `ui.row(*children, wrap=True)` | Native layout; `grow=1`, `truncate="end"` on long text |
| `ui.split(left, right, sizes=[0.6, 0.4], variant="hairline")` | Resizable related panes; handle `on_change` to retain the shares |
| `ui.scroll(*children, max={"h":"20ch"}, stick="end")` | Bounded growing logs; only follow the end when useful |
| `ui.card(*children, head=..., icon=..., meta=..., end=...)` | One object's detail and head controls; `status` is pending/running/done/error/cancelled |
| `ui.section(*children, head=..., collapsible=True)` | Lighter disclosure group |
| `ui.text(text)`, `ui.md(markdown)`, `ui.code(text, "sh")` | Text, Markdown, code |
| `ui.diff(text, path=..., mode="auto")` | Unified or split diff |
| `ui.kv([("name", "value")])` | Aligned properties |
| `ui.stats([{"label":"Blocked", "value":"3", "tone":"warning"}])` | Up to four known headline values, outside cards |
| `ui.badge(text, tone="warning")` | Labelled state |
| `ui.list(ui.item(label, key="a"), on_select=fn)` | Select event `item` is the full item node id, not `"a"` |
| `ui.tabs([{"id":"a", "label":"A"}], active="a", on_select=fn)` | Tab selection owned by app |
| `ui.checklist([{"id":"g", "title":"Gates", "items":[{"id":"ci", "text":"CI", "status":"active"}]}])` | Gates: pending/active/done/dropped/blocked |
| `ui.progress(0.5, "Uploading")`, `ui.spinner("Running")` | Progress or indeterminate activity |
| `ui.trace(lines, variant="rail")` | Observed work log, not a plan; summary/card variants for settled reasoning |
| `ui.empty(title="No matches", text="Change the filter")`, `ui.skeleton("rows", rows=5)` | Empty and first-load states; keep last-good content on refresh failure |
| `ui.elapsed(age_ms, format="short")` | Native live timer; negative age counts down |
| `ui.chart("line", series=[{"label":"p95", "values":[80,95,82]}])` | Bars, spark, heatmap, line, area and donut |
| `ui.meter(0.7, "Capacity", style="ring")` | Bar/ring/blocks |
| `ui.image(blob, alt=..., w=400)` | SVG/PNG or another supported image blob |
| `ui.button("Choose", variant="primary", on_click=fn)` | Native button with `size`, `keys`, `busy`, `disabled` and `on` states |
| `ui.select(["eu", "us"], value="eu", on_change=fn)` | A choice; `field` in forms, `quiet` in a toolbar |
| `ui.switch("Failures only", on=False, on_change=fn)` | Boolean setting, not an HTML checkbox |
| `ui.field(control, label="Region", hint="Local filter", error=...)` | Native label, help and validation around a control |

For source excerpts, `ui.code(text, "py", nums=[41, 42, 57], numbers=True)`
keeps the file's actual line numbers; `folds` and `overview` suit longer
evidence. Do not renumber non-contiguous excerpts as if they were contiguous.

For tables, `ui.table(cols=[{"id":"name","head":"Name"}], rows=[{"id":"a","cells":{"name":"A"}}])`.
Use `selectable=True` and `on_select` for selection; row `menu` entries and cell
buttons send actions with the row id in `event.item`. Sortable headers send
`event.act == "sort"` with `event.value == {"col": ..., "dir": ...}`; the app
orders rows and returns `sort` in its next view. Editors/input still own
text/caret state in the app; they are not browser-managed text fields.

For a list select event, `event.id` is the list's node id and `event.item` is
the item's full node id. Map back to the data identity before persisting it:
when item keys are your data ids, strip the exact `event.id + "."` prefix.
Do not store the wire id as a domain id or split away dots within a data id.

### Value and navigation events

| Control | Event and app responsibility |
| --- | --- |
| `select`, `switch`, `slider`, `date`/`calendar` | `on_change`: `event.value` holds the pick, boolean, number/range or date. Store it in draft state and redraw. `switch` uses `on=`, not `checked=`. |
| `split` | `on_change`: `event.value` is the list of pane shares; retain it if resizing should survive redraw/refresh. |
| `pager` | `on_change`: `event.value` is a **1-based** page. Bound it against the current filtered data and retain the selection by data id. |
| `tabs`, `nav`, `breadcrumb` | `on_select`: `event.item` is the declared item id. Render the selected view; don't strip a node-path prefix from these ids. |
| `menu` | `on_action={"id": handler}` handles command ids; check/radio picks also carry `event.checked`. Right-click `actions.menu` uses `on_menu` instead. |

For example, a local view can own choices independently of fetched data:

```python
CHOICES = {"region": "eu", "failures": False}

def view(b):
    def change(name, event):
        CHOICES[name] = event.value
        b.refresh()

    return ui.col(
        ui.field(
            ui.select(["eu", "us"], value=CHOICES["region"], key="region",
                      on_change=lambda e: change("region", e)),
            label="Region",
        ),
        ui.switch("Failures only", on=CHOICES["failures"], key="failures",
                  on_change=lambda e: change("failures", e)),
    )
```

Picks are pointer-driven; keyboard shortcuts require app handling. `keys=`
only draws hints: the kit binds `q`/`r`, not every displayed shortcut. Keep
drafts separate from fetched data, persist them only when promised, and use
`board.command` for consequential Apply actions rather than running them in
`on_change`.

### Editable field focus

An `on_edit` handler alone does not make a field usable. Answer `on_focus` with
`b.surface.focus(event.id)`; view diffs never send focus automatically. Give
fields stable keys.

The kit's default loop handles `q`/`r`, not text entry, and does not negotiate
native `edit`/`undo`. Editable apps need app-owned key handling or a verified SDK
edit setup; native editing also depends on Tern's settings and version.
Focus capture is not editing: insert `key.text` into the focused buffer,
handle deletion/caret movement, render its new text/cursor, and persist changes.
Do not just suppress board shortcuts while waiting for `on_edit`.

While a field owns input, `q`/`r` must be text, not board shortcuts. Cursor/edit
offsets are UTF-16 code units. Verify by clicking, typing and reading the saved
value, not by calling an edit handler. See the [input contract](https://docs.stencil.so/tern/elements/input.html).

## Actions, images and custom layout

```python
ui.row(
    ui.text("example!7", href="https://gitlab.example.com/team/app/-/merge_requests/7"),
    key="mr-7", href="https://gitlab.example.com/team/app/-/merge_requests/7",
    actions={"menu": ["open"]},
    on_menu={"copy-branch": lambda e: board.copy("feature"),
             "ask-agent": lambda e: board.ask("Explain this MR", ref="example!7")},
)
```

Tern handles built-in `open`, `copy`, `zoom` itself. Custom menu names become
labels (`ask-agent` → Ask agent). Do not use a built-in name for a Python
callback: built-ins do not send action events. With href, modifier-click can
open instead of running a custom click. `Session.poll` dispatches node handlers
itself; apps must not route those events again.
A span with `href` draws as a link only without a tone/`muted` style. Node `href`
alone opens on ⌘-click; add `actions={"click": "open"}` to open on a plain click.

`b.session` exposes the connected SDK Session for advanced use, for example
`b.surface.stylesheet("layout", css)` after the surface exists. The kit opens
screen surfaces with `font="sans"`; machine strings use `mono`, `path` or `code`
spans. Prefer native `button`, `field`, `select`, `switch`, `stats`, `empty`,
`trace` and `split` kinds before CSS. Use a sheet only for custom layout; Tern
supports an allowed subset of HTML tags/CSS, not arbitrary browser DOM or JS.

For custom geometry, generate SVG/PNG in Python and use
`ui.image(b.blob(image_bytes, "image/svg+xml"), alt="...")`. Give plain output
useful alt text. Blobs render pictures; attach interaction to supported nodes,
not invented coordinate events. Do not send private data to external renderers.

## SDK gotchas

- Regions: main scrolls, dock sticks to the bottom, layer floats above both.
  The kit owns these wrappers. In raw SDK code use lists for region content:
  `surface.render(main=[node], layer=[overlay])`. A bare region root's own kind
  and props are ignored, only its children draw.
- `ui.seg(text, *children)` takes text first; don't pass a Node as its first
  positional argument. `elapsed` uses **milliseconds**, not seconds.
- Tern animates `elapsed`/spinner locally. Plain elapsed prints its starting age.
- SDK `surface.render` diffs and coalesces the latest view while credits are
  exhausted. `ack` is cumulative and means applied **and drawn**. A hidden tab
  can withhold acks; this is not proof of a crash. Keep fetching if the agent is
  waiting for completion, without forcing that tab into view.
- For isolated native checks, use a dedicated `tern serve --control EP --out DIR`
  with scratch home/config/state/log directories, and name that endpoint on
  every `tern ctl` call. Never inspect or drive the user's other panes.
- A visible native table's `empty` message may not satisfy `plugins expect`.
  Verify control-generated content in the rendered tree or a task-owned
  headless capture instead of treating that timeout as a missing view.
- `VisibleEvent` and `ResizeEvent.visible` exist. Repeated visibility events
  can be frequent; the kit writes status only when visibility changes.
- Toast TTL does not remove its node from the program's tree. Kit owns expiry.
- Keep the app running for callbacks to work; a closed kept surface is static.
