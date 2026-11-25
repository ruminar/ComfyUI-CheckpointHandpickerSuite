import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]


class _FakeRoutes:
    def get(self, _path):
        return lambda function: function

    def post(self, _path):
        return lambda function: function


def _load_suite_nodes():
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.filename_list_cache = {}
    folder_paths.supported_pt_extensions = {".safetensors"}
    folder_paths.get_output_directory = lambda: tempfile.gettempdir()
    folder_paths.get_filename_list = lambda _kind: ["a.safetensors"]
    folder_paths.get_folder_paths = lambda _kind: []

    numpy = types.ModuleType("numpy")
    numpy.ndarray = type("ndarray", (), {})
    numpy.uint8 = int

    pil = types.ModuleType("PIL")
    pil_image = types.ModuleType("PIL.Image")
    pil_image.Image = type("Image", (), {})
    pil_image.Resampling = types.SimpleNamespace(LANCZOS=1)
    pil_image_ops = types.ModuleType("PIL.ImageOps")
    pil.Image = pil_image
    pil.ImageOps = pil_image_ops

    aiohttp = types.ModuleType("aiohttp")
    web = types.ModuleType("aiohttp.web")
    web.json_response = lambda payload, status=200: {"payload": payload, "status": status}
    aiohttp.web = web

    server = types.ModuleType("server")

    class PromptServer:
        instance = types.SimpleNamespace(
            routes=_FakeRoutes(),
            client_id=None,
            send_sync=lambda *_args, **_kwargs: None,
        )

    server.PromptServer = PromptServer

    stubs = {
        "folder_paths": folder_paths,
        "numpy": numpy,
        "PIL": pil,
        "PIL.Image": pil_image,
        "PIL.ImageOps": pil_image_ops,
        "aiohttp": aiohttp,
        "aiohttp.web": web,
        "server": server,
    }
    module_name = "checkpoint_handpicker_suite_nodes_under_test"
    spec = importlib.util.spec_from_file_location(module_name, REPO_ROOT / "suite_nodes.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, stubs):
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop(module_name, None)
    return module


class CyclerModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.suite = _load_suite_nodes()

    def setUp(self):
        self.checkpoints = ["a.safetensors", "b.safetensors", "c.safetensors"]
        self.statuses = {
            "a.safetensors": "god",
            "b.safetensors": "none",
            "c.safetensors": "favorite",
        }
        self.suite._CYCLER_STATES.clear()
        self.suite._TAB_EXECUTION_STATES.clear()
        self.suite._get_checkpoint_list = lambda: list(self.checkpoints)
        self.suite._get_status = lambda relpath: self.statuses.get(relpath, "none")

    def cycle(self, *, start="a.safetensors", mode="increment", statuses=None, use_local_list=False):
        return self.suite.CheckpointNameCycler().cycle(
            start,
            mode=mode,
            change_every=1,
            hps_tab_id="test-tab",
            hps_filter_statuses=json.dumps(statuses or []),
            hps_use_local_list="true" if use_local_list else "false",
            hps_settings_revision="1",
            unique_id=1,
        )[0]

    def cycler_state(self):
        return self.suite._get_cycler_state(self.suite._state_key("test-tab", 1))

    def test_fixed_ignores_status_filter(self):
        selected = self.cycle(start="b.safetensors", mode="fixed", statuses=["god"])
        self.assertEqual("b.safetensors", selected)

    def test_increment_uses_status_filter_as_pass_condition(self):
        selected = self.cycle(start="a.safetensors", mode="increment", statuses=["favorite"])
        self.assertEqual("c.safetensors", selected)

    def test_randomize_selects_from_filtered_candidates(self):
        selected = self.cycle(start="a.safetensors", mode="randomize", statuses=["favorite"])
        self.assertEqual("c.safetensors", selected)

    def test_shuffle_once_consumes_nonmatching_deck_items(self):
        self.cycler_state()["shuffle_deck"] = ["b.safetensors", "c.safetensors", "a.safetensors"]
        selected = self.cycle(start="a.safetensors", mode="shuffle_once", statuses=["god"])
        self.assertEqual("a.safetensors", selected)
        self.assertEqual([], self.cycler_state()["shuffle_deck"])

    def test_local_list_overrides_fixed_and_ignores_filter(self):
        self.cycler_state()["local_list"] = ["c.safetensors"]
        selected = self.cycle(
            start="b.safetensors",
            mode="fixed",
            statuses=["god"],
            use_local_list=True,
        )
        self.assertEqual("c.safetensors", selected)
        self.assertEqual([], self.cycler_state()["local_list"])


class NodeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.suite = _load_suite_nodes()

    def test_public_node_mappings_are_stable(self):
        self.assertEqual(
            {
                "CheckpointListSelector",
                "CheckpointNameCycler",
                "CheckpointStatusTagger",
                "CheckpointTagExportImport",
                "EphemeralPreview",
                "ImageDirPreview",
            },
            set(self.suite.NODE_CLASS_MAPPINGS),
        )

    def test_node_menu_categories(self):
        main_nodes = (
            self.suite.CheckpointListSelector,
            self.suite.CheckpointNameCycler,
            self.suite.CheckpointStatusTagger,
            self.suite.CheckpointTagExportImport,
        )
        preview_nodes = (self.suite.EphemeralPreview, self.suite.ImageDirPreview)
        self.assertTrue(all(node.CATEGORY == "HandpickerSuite" for node in main_nodes))
        self.assertTrue(all(node.CATEGORY == "HandpickerSuite/Preview" for node in preview_nodes))

    def test_documented_output_contracts(self):
        self.assertEqual(
            ("ckpt_name", "ckpt_name_str", "ckpt_name_safe"),
            self.suite.CheckpointListSelector.RETURN_NAMES,
        )
        self.assertEqual((), self.suite.CheckpointStatusTagger.RETURN_TYPES)
        self.assertEqual((), self.suite.EphemeralPreview.RETURN_TYPES)


class TagTransferFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.suite = _load_suite_nodes()

    def test_explicit_file_confirms_again_if_existing_evaluation_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            chosen = directory / "Anima_20261125_153000.json"
            status = directory / "checkpoint_statuses.json"
            chosen.write_text(json.dumps({"format_version": 1, "evaluations": [
                {"file_name": "a.safetensors", "file_size": 7, "tag": "delete"},
            ]}), encoding="utf-8")
            status.write_text(json.dumps({"version": 1, "statuses": {"nested/a.safetensors": {"status": "keep"}}}),
                              encoding="utf-8")
            models = directory / "models"
            (models / "nested").mkdir(parents=True)
            (models / "nested/a.safetensors").write_bytes(b"1234567")
            queue = directory / "checkpoint_delete_queue.jsonl"

            class Request:
                def __init__(self, **values):
                    self.values = values

                async def json(self):
                    return {"directory": str(directory), **self.values}

            with (
                patch.object(self.suite, "STATUS_DB_PATH", status),
                patch.object(self.suite, "FAVORITES_COMPAT_PATH", directory / "checkpoint_favorites.json"),
                patch.object(self.suite, "DELETE_QUEUE_PATH", queue),
                patch.object(self.suite, "_checkpoint_roots", return_value=[models]),
                patch.object(self.suite, "_sync_imported_tag_states", return_value=1),
            ):
                auto = asyncio.run(self.suite.tag_transfer_import(Request()))
                self.assertEqual(404, auto["status"])
                standard = directory / "checkpoint_tags_20261125_153000.json"
                standard.write_bytes(chosen.read_bytes())
                auto = asyncio.run(self.suite.tag_transfer_import(Request()))["payload"]
                self.assertEqual(1, auto["conflicts"])
                preview = asyncio.run(self.suite.tag_transfer_import(Request(file_name=chosen.name)))["payload"]
                self.assertEqual(1, preview["overwrite_count"])
                self.assertIn('"keep"', status.read_text(encoding="utf-8"))

                status.write_text(json.dumps({"version": 1, "statuses": {"nested/a.safetensors": {"status": "nice"}}}),
                                  encoding="utf-8")
                renewed = asyncio.run(self.suite.tag_transfer_import(
                    Request(file_name=chosen.name, confirmation=preview["confirmation"])))["payload"]
                self.assertTrue(renewed["confirmation_required"])
                self.assertNotEqual(preview["confirmation"], renewed["confirmation"])
                self.assertIn('"nice"', status.read_text(encoding="utf-8"))

                result = asyncio.run(self.suite.tag_transfer_import(
                    Request(file_name=chosen.name, confirmation=renewed["confirmation"])))["payload"]
                self.assertEqual(1, result["imported"])
                self.assertEqual(1, result["overwritten"])
                self.assertIn('"delete"', status.read_text(encoding="utf-8"))
                self.assertFalse(queue.exists())

    def test_import_rejects_unique_identity_with_shared_evaluation_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            chosen = Path(temporary) / "Anima_20261125_153000.json"
            chosen.write_text(json.dumps({"format_version": 1, "evaluations": [
                {"file_name": "a.safetensors", "file_size": 7, "tag": "keep"},
            ]}), encoding="utf-8")
            index = {
                ("a.safetensors", 7): [{"relpath": "a.safetensors", "path": "first/a.safetensors"}],
                ("a.safetensors", 8): [{"relpath": "a.safetensors", "path": "second/a.safetensors"}],
            }
            with patch.object(self.suite, "_build_current_checkpoint_identity_index", return_value=index):
                result = self.suite._prepare_tag_import(chosen)
            self.assertFalse(result["matches"])
            self.assertEqual(1, len(result["ambiguous"]))

    def test_confirmed_overwrite_cancels_old_delete_reservation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            status = directory / "checkpoint_statuses.json"
            queue = directory / "checkpoint_delete_queue.jsonl"
            status.write_text(json.dumps({"version": 1, "statuses": {"a.safetensors": {"status": "delete"}}}),
                              encoding="utf-8")
            self.suite.studio.append_reservation(queue, {"type": "reserve", "id": "old", "ckpt_name_str": "a.safetensors"})
            model = directory / "a.safetensors"
            model.write_bytes(b"1234567")
            prepared = {"matches": [{"file_name": "a.safetensors", "file_size": 7, "tag": "keep",
                                     "relpath": model.name, "path": str(model.resolve())}],
                        "missing": [], "ambiguous": [], "failed": [], "source_digest": "test-digest"}
            with (
                patch.object(self.suite, "STATUS_DB_PATH", status),
                patch.object(self.suite, "DELETE_QUEUE_PATH", queue),
                patch.object(self.suite, "FAVORITES_COMPAT_PATH", directory / "checkpoint_favorites.json"),
            ):
                source = str(directory / "Anima.json")
                preview = self.suite._commit_tag_import(prepared, explicit_source=source)
                self.assertIn("a.safetensors", self.suite.studio.active_reservations(queue))
                result = self.suite._commit_tag_import(prepared, explicit_source=source, confirmation=preview["confirmation"])
                self.assertEqual(1, result["overwrite_count"])
                self.assertEqual("keep", self.suite._get_status("a.safetensors"))
                self.assertEqual({}, self.suite.studio.active_reservations(queue))

    def test_import_failure_and_confirmation_regressions(self):
        for case in ("changed_json", "same_plan_new_json", "changed_checkpoint", "save_failure",
                     "cancel_failure", "stale_reservation"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary).resolve()
                root = directory / "models"
                root.mkdir()
                model = root / "a.safetensors"
                other = root / "b.safetensors"
                model.write_bytes(b"123")
                other.write_bytes(b"1234")
                chosen = directory / "Anima.json"
                status = directory / "checkpoint_statuses.json"
                queue = directory / "checkpoint_delete_queue.jsonl"

                def write_export(path, size, tag):
                    chosen.write_text(json.dumps({"format_version": 1, "evaluations": [
                        {"file_name": path.name, "file_size": size, "tag": tag},
                    ]}), encoding="utf-8")

                class Request:
                    def __init__(self, **values):
                        self.values = values

                    async def json(self):
                        return {"directory": str(directory), "file_name": chosen.name, **self.values}

                def run(**values):
                    return asyncio.run(self.suite.tag_transfer_import(Request(**values)))

                current = "none" if case == "stale_reservation" else "delete"
                status.write_text(json.dumps({"version": 1, "statuses": {model.name: {"status": current}}}),
                                  encoding="utf-8")
                self.suite.studio.append_reservation(queue, {"type": "reserve", "id": "old", "ckpt_name_str": model.name})
                old_status = status.read_bytes()
                old_queue = queue.read_bytes()
                with patch.multiple(self.suite, STATUS_DB_PATH=status, DELETE_QUEUE_PATH=queue,
                                    FAVORITES_COMPAT_PATH=directory / "favorites.json",
                                    _checkpoint_roots=lambda: [root]):
                    if case == "stale_reservation":
                        write_export(model, 3, "delete")
                        self.assertEqual(1, run()["payload"]["conflicts"])
                    else:
                        write_export(model, 3, "keep")
                        preview = run()["payload"]
                        confirmed = {"confirmation": preview["confirmation"]}
                        if case == "changed_json":
                            write_export(other, 4, "nice")
                            result = run(**confirmed)["payload"]
                            self.assertTrue(result["confirmation_required"])
                            self.assertTrue(result["plan_changed"])
                            self.assertEqual((0, 1), (result["overwrite_count"], result["new_count"]))
                            self.assertEqual(old_status, status.read_bytes())
                            applied = run(confirmation=result["confirmation"])["payload"]
                            self.assertEqual(1, applied["imported"])
                            self.assertEqual("nice", self.suite._get_status(other.name))
                            self.assertEqual("delete", self.suite._get_status(model.name))
                        elif case == "same_plan_new_json":
                            document = json.loads(chosen.read_text(encoding="utf-8"))
                            document["exported_at"] = "2026-11-26T20:00:00+09:00"
                            chosen.write_text(json.dumps(document), encoding="utf-8")
                            result = run(**confirmed)["payload"]
                            self.assertTrue(result["confirmation_required"])
                            self.assertNotEqual(preview["confirmation"], result["confirmation"])
                        elif case == "changed_checkpoint":
                            prepare = self.suite._prepare_tag_import

                            def prepare_then_replace(path):
                                prepared = prepare(path)
                                replacement = root / "replacement.tmp"
                                replacement.write_bytes(b"changed length")
                                replacement.replace(model)
                                return prepared

                            with patch.object(self.suite, "_prepare_tag_import", side_effect=prepare_then_replace):
                                result = run(**confirmed)["payload"]
                            self.assertEqual((0, 1), (result["imported"], result["failed"]))
                        elif case == "save_failure":
                            with (patch.object(self.suite.studio, "write_json", side_effect=OSError("DB unavailable")),
                                  self.assertLogs(self.suite.logger, "ERROR")):
                                self.assertEqual(500, run(**confirmed)["status"])
                        else:
                            with (patch.object(self.suite, "_append_delete_record", side_effect=OSError("Queue unavailable")),
                                  self.assertLogs(self.suite.logger, "WARNING")):
                                result = run(**confirmed)["payload"]
                            self.assertTrue(result["ok"])
                            self.assertEqual("keep", self.suite._get_status(model.name))
                            self.assertEqual(1, len(result["reservation_warnings"]))
                            self.assertIn("cleanup failed", result["message"])
                if case not in ("cancel_failure", "changed_json"):
                    self.assertEqual(old_status, status.read_bytes())
                self.assertEqual(old_queue, queue.read_bytes())

    def test_named_import_rejects_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            for name in ("../outside.json", "folder\\outside.json", "C:outside.json", "Anima.txt"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    self.suite._named_tag_import_path(Path(temporary), name)


class StudioIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.suite = _load_suite_nodes()

    def test_versionless_status_database_is_accepted_for_v1_upgrade(self):
        with tempfile.TemporaryDirectory() as temporary:
            status_path = Path(temporary) / "checkpoint_statuses.json"
            status_path.write_text(json.dumps({"statuses": {"a.safetensors": {"status": "favorite"}}}), encoding="utf-8")
            with patch.object(self.suite, "STATUS_DB_PATH", status_path):
                self.assertEqual(
                    {"version": 1, "statuses": {"a.safetensors": {"status": "favorite"}}},
                    self.suite._load_status_db(for_write=True),
                )

    def test_delete_script_uses_its_sibling_bridge_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            script_dir = Path(temporary)
            script_path = script_dir / "checkpoint_delete.py"
            queue_path = script_dir / "checkpoint_delete_queue.jsonl"
            with (
                patch.object(self.suite, "DELETE_SCRIPT_DIR", script_dir),
                patch.object(self.suite, "DELETE_SCRIPT_PATH", script_path),
                patch.object(self.suite, "DELETE_QUEUE_PATH", queue_path),
                patch.object(self.suite, "_checkpoint_roots", return_value=[]),
            ):
                self.suite._write_delete_script()

            script = script_path.read_text(encoding="utf-8")
            bridge_copy = script_dir / "checkpoint_studio_bridge.py"
            self.assertTrue(bridge_copy.is_file())
            self.assertIn("sys.path.insert(0, str(SCRIPT_DIR))", script)
            self.assertNotIn(f"sys.path.insert(0, {str(self.suite.NODE_DIR)!r})", script)
            compile(script, str(script_path), "exec")


if __name__ == "__main__":
    unittest.main()
