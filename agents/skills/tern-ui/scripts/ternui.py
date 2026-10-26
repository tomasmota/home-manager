"""Small Tern board runtime. Apps own their data, layout and domain decisions."""
from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import queue
import shlex
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from uuid import uuid4

import tern_sdk
from tern_sdk import ui


def command_json(argv, *, cwd=None, timeout=60):
    """Run a read-only JSON-producing command without sharing the board's tty."""
    result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip() or
                           f"{argv[0]} exited {result.returncode}")
    return json.loads(result.stdout)


def _atomic(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False) + "\n")
    temp.replace(path)


class Board:
    def __init__(self, title, *, fetch, view, every=120, changes=None):
        self.title, self.fetch, self.view = title, fetch, view
        self.every, self.changes = every, changes
        self.data = None
        self.error = None
        self.checked_at = None
        self.busy = False
        self.fixture = False
        self.visible = None
        self.render_errors = []
        self.directory = Path(os.environ.get("TERN_UI_DIR", "."))
        self.name = os.environ.get("TERN_UI_NAME", Path(sys.argv[0]).stem)
        self.session = None
        self.surface = None
        self._results = queue.Queue()
        self._next = 0
        self._dirty = True
        self._quit = False
        self._toasts = []
        self._confirm = None
        self._action = None
        self._seen = False

    def emit(self, type, text, **data):
        """Queue a structured event for the single CLI wait consumer."""
        event = dict(id=uuid4().hex, at=datetime.now(timezone.utc).isoformat(),
                     board=self.name, session=os.environ.get("PI_SESSION_ID"),
                     type=type, text=text, data=data)
        line = (json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n").encode()
        with (self.directory / "events.jsonl").open("ab") as out:
            out.write(line)
        return event

    def notify(self, text, *, sub=None, tone="info"):
        self._toasts.append((uuid4().hex, text, sub, tone, time.monotonic() + 5))
        self._toasts = self._toasts[-3:]
        self._dirty = True

    def ask(self, text, **data):
        self.emit("ask", text, **data)
        self.notify("Queued for the agent", sub="Delivered when the agent runs wait.")

    def pick(self, text, **data):
        self.emit("pick", text, **data)
        self.notify("Choice queued for the agent", sub=text)

    def copy(self, text):
        result = subprocess.run(["pbcopy"], input=text, capture_output=True, text=True,
                                timeout=5)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "pbcopy failed")
        self.notify("Copied")

    def refresh(self):
        self._next = 0
        self._dirty = True

    def blob(self, data, mime):
        return self.session.blob(data, mime) if self.session else None

    def command(self, label, argv, *, cwd=None, timeout=60):
        """Show exact argv for user confirmation, then execute without an agent hop."""
        if self.fixture:
            self.notify("Commands disabled for fixture data", tone="warning")
        elif self._action:
            self.notify("An action is already running", sub=self._action, tone="warning")
        else:
            if not argv or isinstance(argv, str):
                raise ValueError("command expects a nonempty argv list, never shell text")
            self._confirm = (label, list(argv), cwd, timeout)
            self._dirty = True

    def _execute(self):
        if not self._confirm:
            return
        label, argv, cwd, timeout = self._confirm
        self._confirm = None
        self._action = label
        self.emit("action-started", label, argv=argv, cwd=str(cwd or Path.cwd()))
        self._dirty = True

        def worker():
            try:
                result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True, timeout=timeout)
                payload = dict(argv=argv, returncode=result.returncode,
                               stdout=result.stdout[-8000:], stderr=result.stderr[-8000:])
            except (OSError, subprocess.TimeoutExpired) as exc:
                payload = dict(argv=argv, returncode=None, stdout="", stderr=str(exc))
            self._results.put(("action", (label, payload)))
        threading.Thread(target=worker, daemon=True).start()

    def _fetch(self):
        self.busy = self._dirty = True

        def worker():
            try:
                self._results.put(("fetch", (self.fetch(), None)))
            except Exception as exc:
                self._results.put(("fetch", (None, str(exc))))
        threading.Thread(target=worker, daemon=True).start()

    def _accept(self, data, error):
        self.busy = False
        self.error = error
        if error is None:
            if self._seen and self.changes:
                for change in self.changes(self.data, data):
                    change = dict(change)
                    text = change.pop("text")
                    self.emit("change", text, **change)
                    self.notify(text)
            self.data, self.checked_at, self._seen = data, time.time(), True
        interval = self.every(self.data) if callable(self.every) and self._seen else self.every
        self._next = time.monotonic() + (float(interval) if not callable(interval) else 120)
        self._dirty = True

    def _status(self, *, closed=False):
        _atomic(self.directory / "status.json", dict(
            pid=os.getpid(), title=self.title, connected=self.session is not None,
            visible=self.visible, error=self.error, render_errors=self.render_errors,
            closed=closed, checked_at=self.checked_at, action=self._action))

    def _compose(self):
        if self._seen:
            content = self.view(self)
        elif self.error:
            content = ui.text("No data yet. Refresh to try again.", tone="muted")
        else:
            content = ui.spinner("Loading")
        warnings = []
        if self.fixture:
            warnings.append(ui.badge("FIXTURE · not live data", tone="warning", key="fixture"))
        if self.error:
            warnings.append(ui.card(ui.text(self.error), head="Refresh failed · showing last good data"
                                    if self._seen else "Fetch failed", status="error", key="error"))
        status = [ui.seg(self.title, priority=10, key="title")]
        if self.busy:
            status.append(ui.seg("", ui.spinner("refreshing"), key="busy"))
        elif self.checked_at:
            status.append(ui.seg("checked", ui.elapsed((time.time() - self.checked_at) * 1000),
                                 ui.text("ago"), priority=5, key="age"))
        if self._action:
            status.append(ui.seg("", ui.spinner(self._action), key="action"))
        if self.render_errors:
            status.append(ui.seg("Tern rejected UI", tone="error", key="render-error"))
        status.append(ui.seg("r refresh · q close", side="right", priority=0, key="keys"))
        layers = [ui.toast(text, sub=sub, tone=tone, ttl=5, key=key)
                  for key, text, sub, tone, until in self._toasts]
        if self._confirm:
            label, argv, cwd, timeout = self._confirm
            layers.append(ui.overlay(
                ui.text(f"Directory: {cwd or Path.cwd()}"),
                ui.code(shlex.join(argv), "sh"),
                ui.row(
                    ui.html.button("Run action", class_="tu-button", key="run",
                                   on_click=lambda e: self._execute()),
                    ui.html.button("Cancel", class_="tu-button", key="cancel",
                                   on_click=lambda e: self._cancel()), gap="sm"),
                ui.text("y run · Esc cancel", tone="muted"),
                head=label, anchor="center", size="md", modal=True, key="confirm"))
        return dict(main=[ui.col(*warnings, content, gap="sm", key="body")],
                    dock=[ui.status(*status, key="status")], layer=layers)

    def _cancel(self):
        self._confirm = None
        self._dirty = True

    def _key(self, key):
        if self._confirm:
            if key.name == "y" and not (key.ctrl or key.meta or key.alt):
                self._execute()
            elif key.name == "escape":
                self._cancel()
            return
        if key.name == "q" or (key.ctrl and key.name == "c"):
            if self._action:
                self.notify("Wait for the running action before closing", tone="warning")
            else:
                self._quit = True
        elif key.name == "r":
            self.refresh()

    def _once(self):
        try:
            self._accept(self.fetch(), None)
        except Exception as exc:
            self._accept(None, str(exc))
        view = self._compose()
        tern_sdk.View.build(view)  # Catch duplicate keys and malformed regions without a tty.
        print(tern_sdk.plain(view))
        return 1 if self.error else 0

    def run(self):
        args = argparse.ArgumentParser(description=self.title)
        args.add_argument("--once", action="store_true")
        args.add_argument("--fixture", type=Path)
        options = args.parse_args()
        if options.fixture:
            path = options.fixture.resolve()
            self.fixture = True
            self.fetch = lambda: json.loads(path.read_text())
        if options.once:
            return self._once()
        # A signal must unwind the SDK context before marking the board closed.
        def stop(signum, frame):
            raise SystemExit(0)
        for name in ("SIGTERM", "SIGHUP"):
            signal.signal(getattr(signal, name), stop)
        self.session = tern_sdk.connect(app="tern-ui", timeout=3)
        if self.session is None:
            return self._once()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.umask(0o077)
        try:
            with self.session, (self.directory / "app.log").open("a") as log:
                # SDK writes to captured tty fds; stray prints must not paint over the UI.
                with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                    self.surface = self.session.open(mode="screen", title=self.title)
                    self.surface.stylesheet("tern-ui", ".tu-button { padding: 5px 12px; border-radius: 6px; background: var(--accent-fill); color: var(--fg); }")
                    self._status()
                    while not self._quit and not self.surface.closed and not self.session.closed:
                        while not self._results.empty():
                            kind, payload = self._results.get_nowait()
                            if kind == "fetch":
                                self._accept(*payload)
                            else:
                                label, result = payload
                                self.emit("ran", label, **result)
                                ok = result["returncode"] == 0
                                self.notify(label, sub="Completed" if ok else result["stderr"][-500:],
                                            tone="success" if ok else "error")
                                self._action = None
                                self.refresh()
                            self._status()
                        now = time.monotonic()
                        remaining = [t for t in self._toasts if t[4] > now]
                        if len(remaining) != len(self._toasts):
                            self._toasts = remaining
                            self._dirty = True
                        if not self.busy and now >= self._next:
                            self._fetch()
                        if self._dirty:
                            self.surface.render(self._compose())
                            self._dirty = False
                        event = self.session.poll(0.1)
                        if isinstance(event, tern_sdk.Key):
                            self._key(event)
                        elif isinstance(event, (tern_sdk.VisibleEvent, tern_sdk.ResizeEvent)):
                            if event.visible is not None and event.visible != self.visible:
                                self.visible = event.visible
                                self._status()
                        elif isinstance(event, tern_sdk.ErrorEvent):
                            self.render_errors = (self.render_errors + [event.msg or str(event.raw)])[-5:]
                            self._dirty = True
                            self._status()
        finally:
            self.emit("closed", f"{self.title} closed")
            self._status(closed=True)
        return 0
