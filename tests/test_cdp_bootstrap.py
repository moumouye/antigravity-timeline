import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, rel_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cdp = load_module('timeline_cdp_bootstrap', 'compat/cdp_bootstrap.py')
manager = load_module('timeline_manager', 'manage.py')
installer = load_module('timeline_installer', 'install.py')


class TimelineCdpBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config_dir = self.home / '.gemini' / 'config'
        self.plugins_dir = self.config_dir / 'plugins'
        self.plugins_dir.mkdir(parents=True, exist_ok=True)
        self.plugin_target = self.plugins_dir / 'antigravity-timeline'
        self.config_file = self.config_dir / 'config.json'
        self.sidecar_data = self.home / '.gemini' / 'antigravity' / 'sidecar_data' / 'antigravity-timeline'
        self.plugin_data = self.home / '.gemini' / 'antigravity' / 'plugin_data' / 'antigravity-timeline'
        self.prefs_file = self.sidecar_data / 'engine' / 'data' / 'preferences.json'
        self.fake_source = self.home / 'repo-src'
        (self.fake_source / 'compat').mkdir(parents=True, exist_ok=True)
        (self.fake_source / 'compat' / 'cdp_bootstrap.py').write_text(
            (ROOT / 'compat' / 'cdp_bootstrap.py').read_text(encoding='utf-8'), encoding='utf-8'
        )
        (self.fake_source / 'plugin.json').write_text(json.dumps({'name': 'antigravity-timeline'}), encoding='utf-8')

    def test_install_from_target_dir_does_not_self_delete(self):
        # Simulate install.py placing files directly at PLUGIN_TARGET and invoking manage.py install.
        self.plugin_target.mkdir(parents=True, exist_ok=True)
        (self.plugin_target / 'compat').mkdir(parents=True, exist_ok=True)
        (self.plugin_target / 'compat' / 'cdp_bootstrap.py').write_text(
            (ROOT / 'compat' / 'cdp_bootstrap.py').read_text(encoding='utf-8'), encoding='utf-8'
        )
        (self.plugin_target / 'plugin.json').write_text(json.dumps({'name': 'antigravity-timeline'}), encoding='utf-8')

        with patch.multiple(
            manager,
            SOURCE_DIR=self.plugin_target,
            HOME=self.home,
            CONFIG_DIR=self.config_dir,
            PLUGINS_DIR=self.plugins_dir,
            PLUGIN_TARGET=self.plugin_target,
            CONFIG_FILE=self.config_file,
            SIDECAR_DATA_DIR=self.sidecar_data,
            PLUGIN_DATA_DIR=self.plugin_data,
            PREFS_FILE=self.prefs_file,
        ):
            manager.install_plugin()
            self.assertTrue((self.plugin_target / 'plugin.json').is_file())
            self.assertIn('antigravity-timeline', cdp._read_json(cdp.shared_paths(self.home)['consumers'], {})['plugins'])

    def test_manage_install_and_uninstall_preserve_other_cdp_consumers(self):
        other = self.plugins_dir / 'antigravity-pulse'
        other.mkdir(parents=True, exist_ok=True)
        (other / 'plugin.json').write_text(json.dumps({'name': 'antigravity-pulse'}), encoding='utf-8')
        cdp.ensure_cdp_bootstrap('antigravity-pulse', home=self.home, quiet=True)

        with patch.multiple(
            manager,
            SOURCE_DIR=self.fake_source,
            HOME=self.home,
            CONFIG_DIR=self.config_dir,
            PLUGINS_DIR=self.plugins_dir,
            PLUGIN_TARGET=self.plugin_target,
            CONFIG_FILE=self.config_file,
            SIDECAR_DATA_DIR=self.sidecar_data,
            PLUGIN_DATA_DIR=self.plugin_data,
            PREFS_FILE=self.prefs_file,
        ), patch.object(manager, 'kill_sidecar_processes', return_value=0):
            manager.install_plugin()
            paths = cdp.shared_paths(self.home)
            self.assertEqual(
                cdp._read_json(paths['consumers'], {})['plugins'],
                ['antigravity-pulse', 'antigravity-timeline'],
            )
            manager.uninstall_plugin(deep=True)
            self.assertEqual(cdp._read_json(paths['consumers'], {})['plugins'], ['antigravity-pulse'])
            self.assertTrue(paths['root'].exists())

    def test_one_line_installer_configures_cdp_bootstrap(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('antigravity-timeline-main/plugin.json', json.dumps({'name': 'antigravity-timeline'}))
            zf.writestr('antigravity-timeline-main/compat/cdp_bootstrap.py',
                        (ROOT / 'compat' / 'cdp_bootstrap.py').read_text(encoding='utf-8'))
        payload = buf.getvalue()

        class FakeResp:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return payload

        with patch.multiple(
            installer,
            HOME=self.home,
            CONFIG_DIR=self.config_dir,
            PLUGINS_DIR=self.plugins_dir,
            PLUGIN_TARGET=self.plugin_target,
            CONFIG_FILE=self.config_file,
        ), patch.object(installer.urllib.request, 'urlopen', return_value=FakeResp()):
            installer.main()

        paths = cdp.shared_paths(self.home)
        self.assertIn('antigravity-timeline', cdp._read_json(paths['consumers'], {})['plugins'])
        self.assertTrue(cdp._read_json(self.config_file, {})['plugins']['antigravity-timeline']['enabled'])

    def test_windows_roaming_and_local_port_candidates(self):
        roaming = self.home / 'AppData' / 'Roaming'
        local = self.home / 'AppData' / 'Local'
        self.assertEqual(
            cdp.active_port_candidates(home=self.home, platform='win32',
                                       env={'APPDATA': str(roaming), 'LOCALAPPDATA': str(local)}),
            [roaming / 'Antigravity' / 'DevToolsActivePort', local / 'Antigravity' / 'DevToolsActivePort'],
        )

    @unittest.skipUnless(sys.platform == 'win32', 'Windows shortcut patching integration test')
    def test_windows_shortcut_patching_and_restore(self):
        desktop = self.home / 'Desktop'
        desktop.mkdir(parents=True, exist_ok=True)
        fake_exe = self.home / 'Antigravity.exe'
        fake_exe.write_bytes(b'MZ')
        lnk = desktop / 'Antigravity.lnk'
        reg_key = f'HKCU:\\Software\\AntigravityTimelineCdpTest_{os.getpid()}'
        self.addCleanup(lambda: subprocess.run(
            ['powershell', '-NoProfile', '-Command', f"Remove-Item -Path '{reg_key}' -Recurse -Force -ErrorAction SilentlyContinue"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ))
        subprocess.run([
            'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            f"$s = New-Object -ComObject WScript.Shell; $a = $s.CreateShortcut('{lnk}'); $a.TargetPath = '{fake_exe}'; $a.Arguments = ''; $a.Save()",
        ], check=True)
        paths = cdp.shared_paths(self.home)
        paths['root'].mkdir(parents=True, exist_ok=True)
        res = cdp._setup_windows(paths, live=True, search_roots=[desktop], run_reg_path=reg_key)
        self.assertEqual(res['shortcutsUpdated'], 1)
        args = subprocess.check_output([
            'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            f"(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}').Arguments",
        ], text=True).strip()
        self.assertEqual(args, cdp.CDP_ARGS)
        cdp._restore_windows(paths, live=True, run_reg_path=reg_key)
        restored = subprocess.check_output([
            'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            f"(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}').Arguments",
        ], text=True).strip()
        self.assertEqual(restored, '')


if __name__ == '__main__':
    unittest.main()
