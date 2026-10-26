# SDK and kit reference

The CLI pins `tern-sdk==0.1.0` in an isolated uv environment and adds this skill's
`scripts/` to `PYTHONPATH`. No global package install. App scripts use PEP 723
`requires-python = ">=3.11"`; declare additional dependencies there when needed.

Authoritative sources: [Python SDK](https://github.com/stencil-hq/tern-sdk/tree/main/python),
[TSP](https://docs.stencil.so/tern/protocol/index.html),
[elements](https://docs.stencil.so/tern/elements/index.html),
[styling](https://docs.stencil.so/tern/styles/index.html).
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
| `ui.card(*children, head=..., status="running")` | Group with header; status is pending/running/done/error/cancelled |
| `ui.section(*children, head=..., collapsible=True)` | Lighter disclosure group |
| `ui.text(text)`, `ui.md(markdown)`, `ui.code(text, "sh")` | Text, Markdown, code |
| `ui.diff(text, path=..., mode="auto")` | Unified or split diff |
| `ui.kv([("name", "value")])` | Aligned properties |
| `ui.badge(text, tone="warning")` | Labelled state |
| `ui.list(ui.item(label, key="a"), on_select=fn)` | Selectable items; select event has `item` |
| `ui.tabs([{"id":"a", "label":"A"}], active="a", on_select=fn)` | Tab selection owned by app |
| `ui.checklist([{"id":"g", "title":"Gates", "items":[{"id":"ci", "text":"CI", "status":"active"}]}])` | Gates: pending/active/done/dropped/blocked |
| `ui.progress(0.5, "Uploading")`, `ui.spinner("Running")` | Progress or indeterminate activity |
| `ui.elapsed(age_ms, format="short")` | Native live timer; negative age counts down |
| `ui.chart("bars", series=[{"label":"A", "value":3}])` | Bars, spark, heatmap |
| `ui.meter(0.7, "Capacity", style="ring")` | Bar/ring/blocks |
| `ui.image(blob, alt=..., w=400)` | SVG/PNG or another supported image blob |
| `ui.html.button("Choose", on_click=fn)` | Custom styled HTML-kind control |
| `ui.html.input(type="checkbox", checked=False, on_change=fn)` | Native checkbox/radio, event.checked |

For tables, `ui.table(cols=[{"id":"name","head":"Name"}], rows=[{"id":"a","cells":{"name":"A"}}])`.
Rows do not have their own click/menu events. Use cards/list items when rows
need actions. Tree/picker/prefs/editor kinds exist too; consult SDK signatures
and docs before using them. Editors/input own text/caret state in the app;
they are not a browser's automatically managed text fields.

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
`b.surface.stylesheet("layout", css)` after the surface exists. A convenient
pattern is installing your sheet once on the first `view` call when
`b.surface` is not None. The kit reserves only its own `tern-ui` stylesheet.
Tern supports an allowed subset of HTML tags/CSS; unknown tags can produce an
error and are not an arbitrary browser canvas. No JS execution.

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
- `VisibleEvent` and `ResizeEvent.visible` exist. Repeated visibility events
  can be frequent; the kit writes status only when visibility changes.
- Toast TTL does not remove its node from the program's tree. Kit owns expiry.
- Keep the app running for callbacks to work; a closed kept surface is static.
