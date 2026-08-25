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


if __name__ == "__main__":
    unittest.main()
