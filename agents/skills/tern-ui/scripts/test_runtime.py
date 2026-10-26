"""Local protocol-peer checks; no GUI automation, credentials or remote mutations."""
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest

from tern_sdk import wire

SCRIPTS = Path(__file__).resolve().parent


class Peer:
    """Speak the host side of TSP to a real app process in a private pty."""
    def __init__(self, app, env):
        self.master, slave = pty.openpty()
        self.process = subprocess.Popen([sys.executable, str(app)], stdin=slave,
                                        stdout=slave, stderr=slave, env=env)
        os.close(slave)
        self.buffer = b""
        self.nodes = {}
        self.frames = 0

    def send(self, verb, body):
        os.write(self.master, wire.encode(verb, wire.dumps(body).encode()))

    def step(self):
        if not select.select([self.master], [], [], 0.05)[0]:
            return
        try:
            self.buffer += os.read(self.master, 65536)
        except OSError:
            return
        prefix, stop = b"\x1b_tsp;", b"\x1b\\"
        while prefix in self.buffer:
            start = self.buffer.index(prefix)
            end = self.buffer.find(stop, start)
            if end < 0:
                break
            inner = self.buffer[start + len(prefix):end]
            self.buffer = self.buffer[end + len(stop):]
            message = wire.split(inner)
            body = json.loads(message.body)
            if message.verb == "q" and body.get("q") == "hello":
                self.send("r", dict(r="hello", v=1, term="test-peer", credits=2,
                                    cols=50, features=["styles", "dock", "blobs"]))
            elif message.verb == "f":
                self.frames += 1
                for op in body["ops"]:
                    if op[0] == "add":
                        self.add(op[-1])
                    elif op[0] == "set" and op[1] in self.nodes:
                        self.nodes[op[1]].setdefault("p", {}).update(op[2])
                    elif op[0] == "text" and op[1] in self.nodes:
                        self.nodes[op[1]].setdefault("p", {})["text"] = op[2]
                    elif op[0] == "del":
                        self.nodes = {k: n for k, n in self.nodes.items()
                                      if k != op[1] and not k.startswith(op[1] + ".")}
                self.send("e", dict(ev="ack", sf=body["sf"], s=body["s"]))

    def add(self, node):
        self.nodes[node["id"]] = node
        for child in node.get("c", []):
            self.add(child)

    def until(self, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while not predicate():
            if self.process.poll() is not None:
                raise AssertionError(f"App exited {self.process.returncode}: {self.buffer!r}")
            if time.monotonic() > deadline:
                raise AssertionError(f"Protocol condition timed out; nodes={self.nodes}")
            self.step()

    def click(self, key):
        found = [n for n in self.nodes.values() if n.get("p", {}).get("key") == key]
        if len(found) != 1:
            raise AssertionError(f"Expected one {key!r} node, got {found}")
        node = found[0]
        self.send("e", dict(ev="action", sf="s1", id=node["id"],
                            act=node["p"]["actions"]["click"]))

    def text(self):
        return "\n".join(str(n.get("p", {}).get("text", "")) for n in self.nodes.values())

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.terminate()
                deadline = time.monotonic() + 5
                # Drain tty output during teardown; assertions concern live frames,
                # not a signal interrupting a partially written final frame.
                while self.process.poll() is None and time.monotonic() < deadline:
                    if select.select([self.master], [], [], 0.05)[0]:
                        try:
                            os.read(self.master, 65536)
                        except OSError:
                            break
                if self.process.poll() is None:
                    self.process.kill()
                self.process.wait(timeout=5)
        finally:
            os.close(self.master)


class RuntimeTests(unittest.TestCase):
    def test_click_delivery_confirmation_and_stale_recovery(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            directory = root / "tern-ui" / "demo"
            directory.mkdir(parents=True)
            source, marker = directory / "source.json", directory / "action-result"
            source.write_text('{"state":"running"}')
            app = directory / "app.py"
            app.write_text('''from pathlib import Path
import json, sys
from ternui import Board
from tern_sdk import ui
source = Path(SOURCE)
marker = MARKER

def changes(old, new):
    if old["state"] != new["state"]:
        yield {"text": new["state"]}

def view(b):
    return ui.col(
        ui.text(b.data["state"], key="state"),
        ui.html.button("Ask", key="ask", on_click=lambda e: b.ask("Explain this state")),
        ui.html.button("Run", key="command", on_click=lambda e: b.command(
            "Write local result", [sys.executable, "-c",
            "from pathlib import Path; Path(%r).write_text('done'); print('done')" % marker])),
        key="app")

b = Board("Regression board", fetch=lambda: json.loads(source.read_text()),
          view=view, every=0.15, changes=changes)
raise SystemExit(b.run())
'''.replace("SOURCE", repr(str(source))).replace("MARKER", repr(str(marker))))
            env = dict(os.environ, PYTHONPATH=str(SCRIPTS), TERN_UI_DIR=str(directory),
                       TERN_UI_NAME="demo", PI_SESSION_ID="test-session", XDG_STATE_HOME=str(root))
            env.pop("TERN_TSP", None)
            env.pop("TERN_TSP_RECORD", None)
            peer = Peer(app, env)
            try:
                peer.until(lambda: "running" in peer.text())
                peer.click("ask")
                peer.until(lambda: (directory / "events.jsonl").exists())
                result = self.drain(env)
                events = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([(e["type"], e["text"], e["session"]) for e in events],
                                 [("ask", "Explain this state", "test-session")])
                self.assertEqual(self.drain(env).returncode, 124)

                peer.click("command")
                peer.until(lambda: any(n.get("p", {}).get("key") == "run" for n in peer.nodes.values()))
                self.assertFalse(marker.exists(), "Command ran before confirmation")
                peer.click("cancel")
                peer.until(lambda: not any(n.get("p", {}).get("key") == "run" for n in peer.nodes.values()))
                self.assertFalse(marker.exists(), "Cancelled command ran")
                peer.click("command")
                peer.until(lambda: any(n.get("p", {}).get("key") == "run" for n in peer.nodes.values()))
                peer.click("run")
                peer.until(lambda: marker.exists() and '"type": "ran"' in (directory / "events.jsonl").read_text())
                events = [json.loads(line) for line in self.drain(env).stdout.splitlines()]
                self.assertEqual([e["type"] for e in events], ["action-started", "ran"])
                self.assertEqual(events[1]["data"]["returncode"], 0)
                self.assertEqual(events[1]["data"]["stdout"], "done\n")
                self.assertEqual(marker.read_text(), "done")

                source.write_text("invalid json")
                peer.until(lambda: any(n.get("p", {}).get("status") == "error"
                                       for n in peer.nodes.values()))
                self.assertIn("running", peer.text(), "Fetch error discarded last-good state")
                source.write_text('{"state":"complete"}')
                peer.until(lambda: "complete" in peer.text() and not any(
                    n.get("p", {}).get("status") == "error" for n in peer.nodes.values()))
                events = [json.loads(line) for line in self.drain(env).stdout.splitlines()]
                self.assertEqual([(e["type"], e["text"]) for e in events], [("change", "complete")])
                os.write(peer.master, b"q")
                peer.process.wait(timeout=5)
                self.assertEqual(peer.process.returncode, 0)
                self.assertTrue(json.loads((directory / "status.json").read_text())["closed"])
            finally:
                peer.close()

    def drain(self, env):
        return subprocess.run([sys.executable, str(SCRIPTS / "tern-ui.py"), "wait", "demo", "--timeout", "0"],
                              env=env, capture_output=True, text=True, timeout=5)

    def test_wait_preserves_partial_records_and_delivers_once(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "tern-ui" / "demo"
            directory.mkdir(parents=True)
            (directory / "status.json").write_text(json.dumps(dict(pid=os.getpid(), closed=False)))
            events = directory / "events.jsonl"
            events.write_bytes(b'{"type":"pick","text":"A"}')
            env = dict(os.environ, XDG_STATE_HOME=root)
            self.assertEqual(self.drain(env).returncode, 124)
            with events.open("ab") as out:
                out.write(b"\n")
            result = self.drain(env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["text"], "A")
            self.assertEqual(self.drain(env).returncode, 124)


if __name__ == "__main__":
    unittest.main()
