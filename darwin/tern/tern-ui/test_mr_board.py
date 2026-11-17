"""Read-only MR board cases. Run with the tern-ui runtime on PYTHONPATH."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mr_board", Path(__file__).with_name("mr-board.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def row(iid):
    return {"project_id": 1, "iid": iid, "references": {"full": f"team/app!{iid}"},
            "title": f"Improve service {iid}", "source_branch": f"fix-{iid}",
            "state": "opened", "author": {"name": "Ada Example"}}


class BoardCases(unittest.TestCase):
    def test_only_week_old_updates_are_stale(self):
        now = app.datetime.fromisoformat("2026-11-17T12:00:00+00:00").timestamp()
        cases = [
            ("2026-11-16T12:00:00Z", None),
            ("2026-11-10T12:00:01Z", None),
            ("2026-11-10T12:00:00Z", 7),
            ("2026-11-08T12:00:00Z", 9),
            ("2026-11-18T12:00:00Z", None),
            ("", None),
            ("invalid", None),
        ]
        with patch.object(app.time, "time", return_value=now):
            for updated, expected in cases:
                with self.subTest(updated=updated):
                    self.assertEqual(app._stale_days(updated), expected)

    def test_pagination_keeps_every_open_mr(self):
        batches = [[row(iid) for iid in range(1, app.PER_PAGE + 1)], [row(99)]]
        with patch.object(app, "glab", side_effect=batches):
            result = app.list_rows()
        self.assertEqual([item["iid"] for item in result], list(range(1, app.PER_PAGE + 1)) + [99])

    def test_failed_detail_remains_visible_with_author_and_blocks_merge(self):
        with patch.object(app, "glab", side_effect=RuntimeError("detail unavailable")):
            item = app._item(row(7))
        self.assertEqual(item["ref"], "team/app!7")
        self.assertEqual(item["author"], "Ada Example")
        self.assertEqual(item["title"], "Improve service 7")
        self.assertIn("detail unavailable", app.blockers(item))
        self.assertEqual(app._state(item)[0], "unknown")

    def test_overlapping_lists_keep_all_rows_without_duplicate_detail_fetches(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "tern-ui"
            config.mkdir()
            (config / "mr-board.json").write_text(json.dumps({"group": "team", "label": "Team"}))
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": directory}), \
                    patch.object(app, "list_rows", side_effect=[[row(1)], [row(1), row(2)]]), \
                    patch.object(app, "_item", side_effect=app._blank) as details, \
                    patch.object(app, "_ticket_titles", return_value=({}, None)):
                data = app.fetch()
        self.assertEqual([item["iid"] for item in data["mrs"]], [1])
        self.assertEqual([item["iid"] for item in data["group_mrs"]], [1, 2])
        self.assertEqual(details.call_count, 2)
        self.assertEqual(app.every({"group_mrs": [{"pipeline": "running"}]}), app.ACTIVE_POLL)


if __name__ == "__main__":
    unittest.main()
