#!/usr/bin/env python3
"""Manage tern-ui boards: create, check, open, wait for events, list and close.

A board is an app file run by `uv` in its own tern pane: the board's app.py, or
any file passed with --app (run in place, so a versioned file stays the source).
All state lives in $XDG_STATE_HOME/tern-ui/<name> (or ~/.local/state/tern-ui/<name>).
"""
from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TEMPLATES = ("mr-board", "watch", "decision")
SDK_WITH = "tern-sdk==0.1.0"
CONNECT_TIMEOUT = 15.0
SPLIT_TIMEOUT = 30.0
DEAD_EXIT = 4
BUSY_EXIT = 75


class CliError(Exception):
    pass


class BusyError(CliError):
    pass


# ---------------------------------------------------------------- small helpers


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def state_root() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return (Path(base) / "tern-ui").resolve()


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def scripts_path() -> Path:
    return skill_root() / "scripts"


def board_dir(name: str) -> Path:
    if not NAME_RE.fullmatch(name):
        raise CliError(f"invalid board name {name!r}: use [a-z0-9][a-z0-9-]{{0,63}}")
    return state_root() / name


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def emit(value: Any) -> None:
    print(json.dumps(value, indent=2))


def which(binary: str) -> str:
    found = shutil.which(binary)
    if not found:
        raise CliError(f"{binary} is not on PATH")
    return found


def pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def pythonpath() -> str:
    existing = os.environ.get("PYTHONPATH", "")
    return str(scripts_path()) + (os.pathsep + existing if existing else "")


def resolve_fixture(value: str | None) -> Path | None:
    if value is None:
        return None
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise CliError(f"fixture is not a file: {path}")
    return path


def resolve_app(directory: Path, value: str | None) -> Path:
    """The board's own app.py, or a file run in place with --app."""
    if value is None:
        app = directory / "app.py"
        if not app.is_file():
            raise CliError(f"no app.py in {directory}; run `tern-ui.py new {directory.name} --from ...` "
                           "or pass --app")
        return app
    app = Path(value).expanduser().resolve()
    if not app.is_file():
        raise CliError(f"app is not a file: {app}")
    return app


def board_state(launch: Any, status: Any) -> str:
    """live, closed, dead, unknown (launch but no status), or absent."""
    if isinstance(status, dict):
        if status.get("closed"):
            return "closed"
        if not pid_alive(status.get("pid")):
            return "dead"
        return "live"
    return "unknown" if isinstance(launch, dict) else "absent"


def block_exists(tern: str, block: Any) -> bool | None:
    try:
        result = subprocess.run(
            [tern, "process", str(block), "--json"],
            capture_output=True, text=True, timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode == 0:
        return True
    if "no block is called" in (result.stderr or "") + (result.stdout or ""):
        return False
    return None


def run_tern(tern: str, args: list[str], timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run([tern, *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise CliError(f"tern {args[0]} timed out after {timeout:.0f}s") from None
    except OSError as error:
        raise CliError(f"tern {args[0]} failed: {error}") from None


def window_scope() -> list[str]:
    key = os.environ.get("TERN_WINDOW_KEY")
    return ["--window", key] if key else []


def read_layout(tern: str, scope: list[str]) -> dict[str, Any] | None:
    try:
        result = subprocess.run([tern, "ls", *scope, "--json"],
                                capture_output=True, text=True, timeout=10)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        layout = json.loads(result.stdout)
    except ValueError:
        return None
    return layout if isinstance(layout, dict) else None


def shown_focus(layout: dict[str, Any] | None) -> dict[str, Any] | None:
    """The focused block in the shown session and shown tab."""
    if not isinstance(layout, dict):
        return None
    for session in layout.get("sessions") or []:
        if not isinstance(session, dict) or not session.get("shown"):
            continue
        for tab in session.get("tabs") or []:
            if not isinstance(tab, dict) or not tab.get("shown"):
                continue
            for block in tab.get("blocks") or []:
                if isinstance(block, dict) and block.get("focused") and isinstance(block.get("id"), int):
                    return {"session": session.get("id"), "tab": tab.get("id"), "block": block.get("id")}
    return None


def still_shown(layout: dict[str, Any] | None, before: dict[str, Any]) -> bool:
    """Whether before's block is still in the same shown session and tab."""
    if not isinstance(layout, dict):
        return False
    for session in layout.get("sessions") or []:
        if not isinstance(session, dict) or session.get("id") != before["session"] or not session.get("shown"):
            continue
        for tab in session.get("tabs") or []:
            if not isinstance(tab, dict) or tab.get("id") != before["tab"] or not tab.get("shown"):
                continue
            for block in tab.get("blocks") or []:
                if isinstance(block, dict) and block.get("id") == before["block"]:
                    return True
    return False


def focus_block(tern: str, scope: list[str], block: Any) -> bool:
    try:
        result = subprocess.run([tern, "focus", *scope, str(block)],
                                capture_output=True, text=True, timeout=10)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return result.returncode == 0


def restore_focus(tern: str, scope: list[str], before: dict[str, Any] | None,
                  layout: dict[str, Any] | None) -> bool:
    """Restore focus only when split moved it and the old block is still visible."""
    current = shown_focus(layout)
    if before is None or current is None or current["block"] == before["block"]:
        return False
    if not still_shown(layout, before):
        return False
    return focus_block(tern, scope, before["block"])


# ---------------------------------------------------------------- commands


def cmd_new(args: argparse.Namespace) -> int:
    name = args.name
    directory = board_dir(name)
    source = skill_root() / "examples" / f"{args.template}.py"
    if not source.is_file():
        raise CliError(f"template is missing: {source}")
    fixture_source = source.with_suffix(".json")
    if not fixture_source.is_file():
        raise CliError(f"template fixture is missing: {fixture_source}")
    app = directory / "app.py"
    fixture = directory / "fixture.json"
    for target in (app, fixture):
        if target.exists():
            raise CliError(f"refusing to overwrite {target}")
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, app)
    shutil.copyfile(fixture_source, fixture)
    emit({"name": name, "dir": str(directory), "app": str(app), "fixture": str(fixture)})
    return 0


def uv_command(app: Path, fixture: Path | None, once: bool) -> list[str]:
    uv = which("uv")
    command = [uv, "run", "--with", SDK_WITH, "--script", str(app)]
    if once:
        command.append("--once")
    if fixture is not None:
        command.extend(["--fixture", str(fixture)])
    return command


def cmd_check(args: argparse.Namespace) -> int:
    app = resolve_app(board_dir(args.name), args.app)
    fixture = resolve_fixture(args.fixture)
    command = uv_command(app, fixture, once=True)
    env = os.environ.copy()
    env["TERN_TSP"] = "0"
    env["PYTHONPATH"] = pythonpath()
    for key in ("TERN_UI_DIR", "TERN_UI_NAME", "TERN_TSP_RECORD"):
        env.pop(key, None)
    try:
        return subprocess.run(command, cwd=os.getcwd(), env=env,
                              stdin=subprocess.DEVNULL).returncode
    except OSError as error:
        raise CliError(f"could not run uv: {error}") from None


def env_assignments(directory: Path, name: str, record: bool) -> list[str]:
    values = {
        "TERN_UI_DIR": str(directory),
        "TERN_UI_NAME": name,
        "PYTHONPATH": pythonpath(),
    }
    session = os.environ.get("PI_SESSION_ID")
    if session:
        values["PI_SESSION_ID"] = session
    if record:
        values["TERN_TSP_RECORD"] = str(directory / "record.jsonl")
    return [f"{key}={value}" for key, value in values.items()]


def launch_argv(directory: Path, name: str, app: Path, fixture: Path | None, record: bool) -> list[str]:
    env_bin = shutil.which("env") or ("/usr/bin/env" if Path("/usr/bin/env").is_file() else None)
    if not env_bin:
        raise CliError("env is not available")
    return [env_bin, *env_assignments(directory, name, record),
            *uv_command(app, fixture, once=False)]


def reuse_output(name: str, directory: Path, app: Path, launch: Any, status: Any,
                 state: str) -> dict[str, Any]:
    launch = launch if isinstance(launch, dict) else {}
    status = status if isinstance(status, dict) else {}
    return {
        "status": "already-running",
        "name": name,
        "dir": str(directory),
        "app": launch.get("app") or str(app),
        "block": launch.get("block"),
        "session": launch.get("session"),
        "tab": launch.get("tab"),
        "pi_session_id": launch.get("pi_session_id"),
        "record": launch.get("record", False),
        "connected": status.get("connected"),
        "closed": status.get("closed"),
        "live": state == "live" or state == "unknown",
        "launch_file": str(directory / "launch.json"),
        "status_file": str(directory / "status.json"),
    }


def cmd_open(args: argparse.Namespace) -> int:
    name = args.name
    directory = board_dir(name)
    app = resolve_app(directory, args.app)
    pane = args.pane or os.environ.get("TERN_PANE", "")
    if not pane:
        raise CliError("this command works only inside a tern pane, or with --pane SPEC")
    tern = which("tern")
    try:
        probe = subprocess.run([tern, "process", pane, "--json"],
                               capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        raise CliError("tern did not answer within 10s; nothing was started") from None
    except OSError as error:
        raise CliError(f"could not run tern: {error}; nothing was started") from None
    if probe.returncode != 0:
        detail = (probe.stderr or probe.stdout or f"exit {probe.returncode}").strip()
        raise CliError(f"tern cannot read pane {pane}: {detail}")
    try:
        resolved = json.loads(probe.stdout).get("pane")
    except (ValueError, AttributeError):
        resolved = None
    if not isinstance(resolved, int) or isinstance(resolved, bool):
        raise CliError(f"tern process {pane} did not report a pane id; nothing was started")
    pane = str(resolved)
    fixture = resolve_fixture(args.fixture)
    current_session = os.environ.get("PI_SESSION_ID") or None

    launch = read_json(directory / "launch.json")
    status = read_json(directory / "status.json")
    state = board_state(launch, status)
    recorded_block = launch.get("block") if isinstance(launch, dict) else None
    recorded_owner = launch.get("pi_session_id") if isinstance(launch, dict) else None
    block_missing = False

    if state in ("live", "unknown"):
        # Agents must not share another agent's board and event cursor; a user
        # launcher (no PI session) may always reuse an open board.
        if current_session and recorded_owner and recorded_owner != current_session:
            raise CliError(
                f"board {name!r} belongs to PI session {recorded_owner} and is still open; "
                "refusing to reuse it")
        if state == "unknown" and recorded_block is not None:
            exists = block_exists(tern, recorded_block)
            if exists is False:
                state = "dead"
                block_missing = True
            elif exists is None:
                raise CliError(
                    f"cannot tell whether recorded block {recorded_block} still exists; "
                    "inspect `tern ls --json` once and do not open another board")
        if state in ("live", "unknown"):
            receipt = reuse_output(name, directory, app, launch, status, state)
            if args.focus and recorded_block is not None:
                receipt["focused"] = focus_block(tern, window_scope(), recorded_block)
            emit(receipt)
            return 0

    # state is closed/dead here (or unknown without a block)
    if recorded_block is not None and not block_missing:
        exists = block_exists(tern, recorded_block)
        if exists is None:
            raise CliError(
                f"cannot tell whether recorded block {recorded_block} still exists; "
                "inspect `tern ls --json` once and do not open another board")
        if exists:
            raise CliError(
                f"board {name!r} still has block {recorded_block} open, but its app is not running; "
                f"close it first with `tern-ui.py close {name}`")

    directory.mkdir(parents=True, exist_ok=True)
    command = launch_argv(directory, name, app, fixture, args.record)
    cwd = os.getcwd()
    scope = window_scope()
    focus_before = None if args.focus else shown_focus(read_layout(tern, scope))
    if (directory / "status.json").exists():
        try:
            (directory / "status.json").unlink()
        except OSError:
            pass
    try:
        split = subprocess.run(
            [tern, "split", pane, "right", "--cwd", cwd, "--json", "--", *command],
            capture_output=True, text=True, timeout=SPLIT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise CliError(
            "tern split did not answer; a pane may exist anyway: check `tern ls --json` once "
            "and do not run open again") from None
    except OSError as error:
        raise CliError(
            f"could not run tern split: {error}; a pane may exist anyway: check `tern ls --json` once "
            "and do not run open again") from None
    if split.returncode != 0:
        detail = (split.stderr or split.stdout or f"exit {split.returncode}").strip()
        raise CliError(
            f"tern split failed: {detail}. A pane may exist anyway: check `tern ls --json` once "
            "and do not run open again")
    try:
        created = json.loads(split.stdout)
    except ValueError:
        created = None
    block = created.get("block") if isinstance(created, dict) else None
    if not isinstance(block, int) or isinstance(block, bool):
        raise CliError(
            "tern split did not report a new block; a pane may exist anyway: check "
            "`tern ls --json` once and do not run open again")

    if focus_before is not None:
        restore_focus(tern, scope, focus_before, read_layout(tern, scope))

    launch_data = {
        "name": name,
        "app": str(app),
        "fixture": str(fixture) if fixture else None,
        "record": bool(args.record),
        "cwd": cwd,
        "pane": int(pane),
        "block": block,
        "session": created.get("session"),
        "tab": created.get("tab"),
        "pi_session_id": current_session,
        "command": command,
        "created_at": now_iso(),
    }
    try:
        write_json(directory / "launch.json", launch_data)
    except OSError as error:
        raise CliError(
            f"pane {block} was created but launch.json could not be saved: {error}; "
            "do not open another board") from None
    status = wait_for_status(directory, CONNECT_TIMEOUT)
    connected = bool(status.get("connected")) if isinstance(status, dict) else False
    closed = bool(status.get("closed")) if isinstance(status, dict) else False
    exited = isinstance(status, dict) and not closed and not pid_alive(status.get("pid"))
    if connected:
        reported = "connected"
    elif closed:
        reported = "closed"
    elif exited:
        reported = "exited"
    else:
        reported = "started"
    emit({
        "status": reported,
        "name": name,
        "dir": str(directory),
        "app": str(app),
        "fixture": str(fixture) if fixture else None,
        "record": bool(args.record),
        "cwd": cwd,
        "pane": int(pane),
        "block": block,
        "session": launch_data["session"],
        "tab": launch_data["tab"],
        "pi_session_id": current_session,
        "connected": connected,
        "closed": closed,
        "launch_file": str(directory / "launch.json"),
        "status_file": str(directory / "status.json"),
    })
    return 1 if reported in ("closed", "exited") else 0


def wait_for_status(directory: Path, timeout: float) -> Any:
    path = directory / "status.json"
    deadline = time.monotonic() + timeout
    last = None
    while True:
        status = read_json(path)
        if isinstance(status, dict):
            last = status
            if status.get("connected"):
                return status
            if status.get("closed") or not pid_alive(status.get("pid")):
                return status
        if time.monotonic() >= deadline:
            return last
        time.sleep(0.25)


# ---------------------------------------------------------------- wait


def read_cursor(path: Path, size: int) -> int:
    try:
        value = int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 0
    if value < 0 or value > size:
        return 0
    return value


def write_cursor(path: Path, offset: int) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(f"{offset}\n", encoding="utf-8")
    os.replace(tmp, path)


def drain_events(directory: Path) -> list[str]:
    """Print unread complete JSONL records; advance the cursor only past printed ones."""
    events = directory / "events.jsonl"
    cursor = directory / "cursor"
    if not events.is_file():
        return []
    with events.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        start = read_cursor(cursor, size)
        stream.seek(start)
        chunk = stream.read()
    cut = chunk.rfind(b"\n")
    if cut < 0:
        return []
    records: list[tuple[str, int]] = []
    position = start
    for raw in chunk[: cut + 1].split(b"\n")[:-1]:
        position += len(raw) + 1
        if not raw.strip():
            continue
        records.append((raw.decode("utf-8", errors="replace").rstrip("\r"), position))
    if not records:
        return []
    for text, _ in records:
        sys.stdout.write(text + "\n")
    sys.stdout.flush()
    write_cursor(cursor, records[-1][1])
    return [text for text, _ in records]


def status_record(name: str, launch: Any, status: Any, state: str, detail: str) -> dict[str, Any]:
    launch = launch if isinstance(launch, dict) else {}
    status = status if isinstance(status, dict) else {}
    return {
        "type": "status",
        "status": state,
        "board": name,
        "block": launch.get("block"),
        "session": launch.get("session"),
        "pid": status.get("pid"),
        "closed": bool(status.get("closed")),
        "at": now_iso(),
        "detail": detail,
    }


def cmd_wait(args: argparse.Namespace) -> int:
    name = args.name
    directory = board_dir(name)
    if not directory.is_dir():
        raise CliError(f"board {name!r} does not exist: {directory}")
    timeout = args.timeout
    if not math.isfinite(timeout) or timeout < 0:
        raise CliError("--timeout must be a finite, zero or positive number")
    lock_path = directory / "wait.lock"
    try:
        lock = lock_path.open("a+")
    except OSError as error:
        raise CliError(f"cannot open wait lock {lock_path}: {error}") from None
    try:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BusyError(f"another waiter is already reading {name!r}; only one wait may run") from None
        return wait_loop(name, directory, timeout)
    finally:
        lock.close()


def wait_loop(name: str, directory: Path, timeout: float) -> int:
    deadline = time.monotonic() + timeout
    while True:
        records = drain_events(directory)
        if records:
            return 0
        launch = read_json(directory / "launch.json")
        status = read_json(directory / "status.json")
        if launch is None and status is None:
            raise CliError(f"board {name!r} has no launch.json or status.json")
        state = board_state(launch, status)
        if state in ("closed", "dead"):
            detail = "board closed" if state == "closed" else f"board process {status.get('pid')} is gone"
            print(json.dumps(status_record(name, launch, status, state, detail)))
            return DEAD_EXIT
        if timeout == 0:
            return 124
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 124
        time.sleep(min(0.5, remaining))


# ---------------------------------------------------------------- list / close


def cmd_list(args: argparse.Namespace) -> int:
    root = state_root()
    boards: list[dict[str, Any]] = []
    if root.is_dir():
        for directory in sorted(root.iterdir(), key=lambda item: item.name):
            if not directory.is_dir() or not NAME_RE.fullmatch(directory.name):
                continue
            launch = read_json(directory / "launch.json")
            status = read_json(directory / "status.json")
            state = board_state(launch, status)
            launch = launch if isinstance(launch, dict) else {}
            status = status if isinstance(status, dict) else {}
            boards.append({
                "name": directory.name,
                "dir": str(directory),
                "app": launch.get("app") or str(directory / "app.py"),
                "app_exists": Path(launch.get("app") or directory / "app.py").is_file(),
                "fixture": launch.get("fixture") if launch.get("fixture")
                           else (str(directory / "fixture.json") if (directory / "fixture.json").is_file() else None),
                "block": launch.get("block"),
                "session": launch.get("session"),
                "tab": launch.get("tab"),
                "pi_session_id": launch.get("pi_session_id"),
                "record": launch.get("record", False),
                "cwd": launch.get("cwd"),
                "pid": status.get("pid"),
                "connected": status.get("connected"),
                "closed": status.get("closed"),
                "error": status.get("error"),
                "live": True if state == "live" else False if state in ("closed", "dead") else None,
            })
    emit({"boards": boards})
    return 0


def cmd_close(args: argparse.Namespace) -> int:
    directory = board_dir(args.name)
    launch = read_json(directory / "launch.json")
    if not isinstance(launch, dict):
        raise CliError(f"board {args.name!r} has no recorded launch; nothing to close")
    block = launch.get("block")
    if not isinstance(block, int) or isinstance(block, bool):
        raise CliError(f"board {args.name!r} has no recorded block id")
    tern = which("tern")
    result = run_tern(tern, ["close", str(block)])
    detail = (result.stderr or result.stdout or "").strip()
    if result.returncode != 0:
        if "no block is called" in detail:
            emit({"status": "already-closed", "name": args.name, "block": block})
            return 0
        raise CliError(f"tern close {block} failed: {detail or f'exit {result.returncode}'}")
    emit({"status": "closed", "name": args.name, "block": block, "detail": detail})
    return 0


# ---------------------------------------------------------------- entry point


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tern-ui.py",
        description="Manage tern-ui boards in tern.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    new = sub.add_parser("new", help="create a board from an example")
    new.add_argument("name")
    new.add_argument("--from", dest="template", required=True, choices=TEMPLATES, metavar="TEMPLATE")
    new.set_defaults(func=cmd_new)

    check = sub.add_parser("check", help="run a board once without tern")
    check.add_argument("name")
    check.add_argument("--app", help="run this file in place instead of the board's app.py")
    check.add_argument("--fixture")
    check.set_defaults(func=cmd_check)

    open_parser = sub.add_parser("open", help="open a board in a new tern pane")
    open_parser.add_argument("name")
    open_parser.add_argument("--app", help="run this file in place instead of the board's app.py")
    open_parser.add_argument("--fixture")
    open_parser.add_argument("--record", action="store_true", help="also keep record.jsonl")
    open_parser.add_argument("--focus", action="store_true",
                             help="for user launchers: focus the board, including one already open")
    open_parser.add_argument("--pane", metavar="SPEC",
                             help="split beside this pane (id or @focused) instead of $TERN_PANE")
    open_parser.set_defaults(func=cmd_open)

    wait = sub.add_parser("wait", help="print unread board events")
    wait.add_argument("name")
    wait.add_argument("--timeout", type=float, default=3600.0, metavar="SECONDS")
    wait.set_defaults(func=cmd_wait)

    list_parser = sub.add_parser("list", help="list boards and liveness")
    list_parser.set_defaults(func=cmd_list)

    close = sub.add_parser("close", help="close the board's recorded tern block")
    close.add_argument("name")
    close.set_defaults(func=cmd_close)
    return parser


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except BusyError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return BUSY_EXIT
    except CliError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
