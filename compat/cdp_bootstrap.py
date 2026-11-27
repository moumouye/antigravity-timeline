"""Shared, idempotent CDP bootstrap for Antigravity desktop plugins.

Ensures Antigravity launches with loopback CDP enabled without modifying the
signed application bundle or resources/app.asar. All plugins share a single
install location, schema version guard, and consumer reference list.
"""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

SCHEMA_VERSION = 1
CDP_ARGS = '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'
MACOS_AGENT_LABEL = 'com.moumouye.antigravity-cdp'
MACOS_LAUNCHER_BUNDLE_ID = 'com.moumouye.antigravity-cdp-launcher'
MACOS_LAUNCHER_NAME = 'Antigravity Launcher.app'
WINDOWS_RUN_VALUE = 'AntigravityCdpGuard'

MACOS_CDP_SCRIPT = """#!/bin/sh
# Starts Antigravity with a loopback CDP endpoint at login.
# If macOS restored an instance without the debugging switch, restart it once.
set -u

SKIP_STAMP="$HOME/.gemini/antigravity/cdp-bootstrap/.skip-restart-once"
if [ -f "$SKIP_STAMP" ]; then
    now=$(/bin/date +%s 2>/dev/null || echo 0)
    stamp=$(/bin/cat "$SKIP_STAMP" 2>/dev/null || echo 0)
    /bin/rm -f "$SKIP_STAMP"
    if [ "$stamp" -gt 0 ] 2>/dev/null && [ $((now - stamp)) -lt 30 ]; then
        exit 0
    fi
fi

APP="/Applications/Antigravity.app"
if [ ! -d "$APP" ] && [ -d "$HOME/Applications/Antigravity.app" ]; then
    APP="$HOME/Applications/Antigravity.app"
fi
[ -d "$APP" ] || exit 0

BIN="$APP/Contents/MacOS/Antigravity"
PORT_FILE="$HOME/Library/Application Support/Antigravity/DevToolsActivePort"

is_running() {
    /usr/bin/pgrep -f "$BIN" >/dev/null 2>&1
}

cdp_ready() {
    port=$(/usr/bin/head -n 1 "$PORT_FILE" 2>/dev/null)
    [ -n "$port" ] || return 1
    /usr/bin/curl -s --max-time 2 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1
}

if is_running; then
    for _ in 1 2 3; do
        if cdp_ready; then
            exit 0
        fi
        /bin/sleep 1
    done

    /usr/bin/pkill -TERM -f "$BIN" 2>/dev/null
    i=0
    while is_running && [ "$i" -lt 40 ]; do
        /bin/sleep 0.25
        i=$((i + 1))
    done
    if is_running; then
        /usr/bin/pkill -KILL -f "$BIN" 2>/dev/null
        /bin/sleep 0.5
    fi
fi

exec /usr/bin/env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \\
    /usr/bin/open -a "$APP" \\
    --args --remote-debugging-port=0 --remote-debugging-address=127.0.0.1
"""

MACOS_APPLESCRIPT = """on run
\tset appPath to "/Applications/Antigravity.app"
\tset userAppPath to (POSIX path of (path to home folder)) & "Applications/Antigravity.app"
\ttry
\t\tdo shell script "/bin/test -d " & quoted form of appPath
\ton error
\t\tset appPath to userAppPath
\tend try
\tset appName to "Antigravity"
\tset portFile to (POSIX path of (path to home folder)) & "Library/Application Support/Antigravity/DevToolsActivePort"

\tset cdpReady to false
\ttry
\t\tdo shell script "/bin/test -s " & quoted form of portFile
\t\tset portVal to do shell script "/usr/bin/head -n 1 " & quoted form of portFile
\t\tdo shell script "/usr/bin/curl -sf --max-time 1 " & quoted form of ("http://127.0.0.1:" & portVal & "/json/version") & " >/dev/null"
\t\tset cdpReady to true
\tend try

\tif application appName is running then
\t\tif cdpReady then
\t\t\tdo shell script "/usr/bin/open -a " & quoted form of appPath
\t\t\treturn
\t\tend if

\t\tdisplay dialog "Antigravity 正在运行，但没有开启调试端口。" & return & return & "需要重启一次，插件才能连接。现在重启吗？" buttons {"取消", "重启并开启"} default button "重启并开启" with title "Antigravity" with icon caution
\t\tif button returned of result is "取消" then return

\t\ttell application appName to quit
\t\trepeat 80 times
\t\t\tdelay 0.25
\t\t\tif not (application appName is running) then exit repeat
\t\tend repeat
\t\tif application appName is running then
\t\t\tdisplay dialog "Antigravity 没有退出，请手动退出后再点一次启动器。" buttons {"好"} default button "好" with title "Antigravity" with icon stop
\t\t\treturn
\t\tend if
\tend if

\tdo shell script "/usr/bin/env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS /usr/bin/open -a " & quoted form of appPath & " --args --remote-debugging-port=0 --remote-debugging-address=127.0.0.1"
end run
"""

WINDOWS_GUARD_PS1 = """# Checks at login whether Antigravity auto-started without CDP; restarts with loopback CDP if so.
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue
if (-not $procs) { exit 0 }

$candidates = @(
    (Join-Path $env:APPDATA 'Antigravity\\DevToolsActivePort'),
    (Join-Path $env:LOCALAPPDATA 'Antigravity\\DevToolsActivePort')
)

function Test-CdpReady {
    foreach ($file in $candidates) {
        if ($file -and (Test-Path $file)) {
            $port = (Get-Content -Path $file -TotalCount 1 -ErrorAction SilentlyContinue)
            if ($port -match '^\\d+$') {
                try {
                    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing
                    if ($resp.StatusCode -eq 200) { return $true }
                } catch {}
            }
        }
    }
    return $false
}

for ($i = 0; $i -lt 3; $i++) {
    if (Test-CdpReady) { exit 0 }
    Start-Sleep -Seconds 1
}

$exe = ($procs | Select-Object -First 1).Path
if (-not $exe) { exit 0 }

$procs | Stop-Process -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
$remaining = Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue
if ($remaining) {
    $remaining | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

$env:ELECTRON_RUN_AS_NODE = $null
$env:NODE_OPTIONS = $null
Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'
"""

WINDOWS_PATCH_SHORTCUTS_PS1 = r"""
$ErrorActionPreference = 'Stop'
$stateFile = $env:AG_CDP_SHORTCUT_STATE
$cdpArgs = $env:AG_CDP_ARGS
$runName = $env:AG_CDP_RUN_NAME
$guardPs1 = $env:AG_CDP_GUARD_PS1
$runKey = if ($env:AG_CDP_RUN_REG_PATH) { $env:AG_CDP_RUN_REG_PATH } else { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' }

$saved = @{}
if (Test-Path $stateFile) {
    try {
        $raw = Get-Content -Raw -Path $stateFile -Encoding UTF8 | ConvertFrom-Json
        if ($raw) {
            foreach ($p in $raw.PSObject.Properties) { $saved[$p.Name] = $p.Value }
        }
    } catch {}
}

$shell = New-Object -ComObject WScript.Shell
if ($env:AG_CDP_SEARCH_ROOTS) {
    $searchRoots = $env:AG_CDP_SEARCH_ROOTS -split ';' | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
} else {
    $searchRoots = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('Programs'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('CommonPrograms')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
}

$updated = 0
foreach ($root in $searchRoots) {
    Get-ChildItem -Path $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $lnk = $shell.CreateShortcut($_.FullName)
            if ($lnk.TargetPath -and ($lnk.TargetPath -like '*\Antigravity.exe')) {
                $full = $_.FullName
                $curr = [string]$lnk.Arguments
                $orig = $curr
                if ($curr -notmatch '--remote-debugging-port=') {
                    $lnk.Arguments = if ([string]::IsNullOrWhiteSpace($curr)) { $cdpArgs } else { "$curr $cdpArgs" }
                    $lnk.Save()
                }
                if (-not $saved.ContainsKey($full)) {
                    $saved[$full] = @{ originalArgs = $orig; created = $false }
                }
                $updated++
            }
        } catch {}
    }
}

if ($updated -eq 0) {
    if ($env:AG_CDP_EXE_CANDIDATES) {
        $exeCandidates = $env:AG_CDP_EXE_CANDIDATES -split ';'
    } else {
        $exeCandidates = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'),
            (Join-Path $env:LOCALAPPDATA 'Antigravity\Antigravity.exe'),
            (Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe')
        )
    }
    $exe = $exeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($exe) {
        $desktopDir = if ($env:AG_CDP_FALLBACK_DESKTOP) { $env:AG_CDP_FALLBACK_DESKTOP } else { [Environment]::GetFolderPath('Desktop') }
        if ($desktopDir -and (Test-Path $desktopDir)) {
            $desktopLnk = Join-Path $desktopDir 'Antigravity Launcher.lnk'
            $lnk = $shell.CreateShortcut($desktopLnk)
            $lnk.TargetPath = $exe
            $lnk.Arguments = $cdpArgs
            $lnk.WorkingDirectory = Split-Path -Parent $exe
            $lnk.IconLocation = "$exe,0"
            $lnk.Save()
            $saved[$desktopLnk] = @{ originalArgs = ''; created = $true }
            $updated = 1
        }
    }
}

$stateDir = Split-Path -Parent $stateFile
if ($stateDir -and -not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
[pscustomobject]$saved | ConvertTo-Json -Depth 5 | Set-Content -Path $stateFile -Encoding UTF8

if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
$runCmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$guardPs1`""
Set-ItemProperty -Path $runKey -Name $runName -Value $runCmd
Write-Output "SHORTCUTS=$updated"
"""

WINDOWS_RESTORE_SHORTCUTS_PS1 = r"""
$ErrorActionPreference = 'SilentlyContinue'
$stateFile = $env:AG_CDP_SHORTCUT_STATE
$runName = $env:AG_CDP_RUN_NAME
$runKey = if ($env:AG_CDP_RUN_REG_PATH) { $env:AG_CDP_RUN_REG_PATH } else { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' }

if (Test-Path $runKey) {
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
}

if (Test-Path $stateFile) {
    $raw = Get-Content -Raw -Path $stateFile -Encoding UTF8 | ConvertFrom-Json
    if ($raw) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($p in $raw.PSObject.Properties) {
            $path = $p.Name
            $info = $p.Value
            if (-not (Test-Path $path)) { continue }
            if ($info.created -eq $true) {
                Remove-Item -Force -Path $path -ErrorAction SilentlyContinue
            } else {
                $lnk = $shell.CreateShortcut($path)
                $lnk.Arguments = [string]$info.originalArgs
                $lnk.Save()
            }
        }
    }
}
"""


def _read_json(path, default):
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except Exception:
        return default


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, path)


def _is_live_system(home, platform):
    return home.resolve() == Path.home().resolve() and platform == sys.platform


def shared_paths(home=None):
    root = (Path(home) if home is not None else Path.home()) / '.gemini' / 'antigravity' / 'cdp-bootstrap'
    return {
        'root': root,
        'version': root / 'version.json',
        'consumers': root / 'consumers.json',
        'macos_script': root / 'antigravity-cdp',
        'macos_skip_stamp': root / '.skip-restart-once',
        'win_guard': root / 'antigravity-cdp.ps1',
        'win_shortcuts': root / 'windows-shortcuts.json',
        'linux_desktop_state': root / 'linux-desktop.json',
    }


def active_port_candidates(home=None, platform=None, env=None):
    home = Path(home) if home is not None else Path.home()
    platform = platform or sys.platform
    env = os.environ if env is None else env
    if platform == 'darwin':
        return [home / 'Library' / 'Application Support' / 'Antigravity' / 'DevToolsActivePort']
    if platform == 'win32':
        roaming = Path(env.get('APPDATA', home / 'AppData' / 'Roaming'))
        local = Path(env.get('LOCALAPPDATA', home / 'AppData' / 'Local'))
        candidates = [roaming / 'Antigravity' / 'DevToolsActivePort', local / 'Antigravity' / 'DevToolsActivePort']
        return list(dict.fromkeys(candidates))
    cfg = Path(env.get('XDG_CONFIG_HOME', home / '.config'))
    return [cfg / 'Antigravity' / 'DevToolsActivePort']


def inspect_cdp_status(home=None, platform=None, env=None):
    home = Path(home) if home is not None else Path.home()
    platform = platform or sys.platform
    env = os.environ if env is None else env
    paths = shared_paths(home)
    version_info = _read_json(paths['version'], {})
    consumers_info = _read_json(paths['consumers'], {'plugins': []})
    plugins_dir = home / '.gemini' / 'config' / 'plugins'
    active_consumers = [
        p for p in consumers_info.get('plugins', [])
        if (plugins_dir / p).exists() or (plugins_dir / p).is_symlink()
    ]

    port = None
    port_file_found = None
    endpoint_alive = False
    for candidate in active_port_candidates(home, platform, env):
        if candidate.is_file():
            try:
                first_line = candidate.read_text(encoding='utf-8').splitlines()[0].strip()
                if first_line.isdigit():
                    port = int(first_line)
                    port_file_found = str(candidate)
                    break
            except Exception:
                pass

    if port:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=0.8) as resp:
                endpoint_alive = resp.status == 200
        except Exception:
            endpoint_alive = False

    return {
        'bootstrapInstalled': bool(version_info.get('schemaVersion')),
        'schemaVersion': version_info.get('schemaVersion'),
        'consumers': active_consumers,
        'launcherPath': version_info.get('launcherPath'),
        'portFile': port_file_found,
        'port': port,
        'cdpReady': endpoint_alive,
    }


def _register_consumer(paths, plugin_id):
    data = _read_json(paths['consumers'], {'plugins': []})
    plugins = sorted(dict.fromkeys([*data.get('plugins', []), plugin_id]))
    _write_json(paths['consumers'], {'plugins': plugins})
    return plugins


def _unregister_consumer(home, paths, plugin_id):
    data = _read_json(paths['consumers'], {'plugins': []})
    plugins_dir = home / '.gemini' / 'config' / 'plugins'
    remaining = sorted(dict.fromkeys([
        p for p in data.get('plugins', [])
        if p != plugin_id and ((plugins_dir / p).exists() or (plugins_dir / p).is_symlink())
    ]))
    _write_json(paths['consumers'], {'plugins': remaining})
    return remaining


def _macos_plist_path(home):
    return home / 'Library' / 'LaunchAgents' / f'{MACOS_AGENT_LABEL}.plist'


def _macos_antigravity_running(home):
    for app_root in (Path('/Applications/Antigravity.app'), home / 'Applications/Antigravity.app'):
        binary = app_root / 'Contents' / 'MacOS' / 'Antigravity'
        if binary.is_file():
            res = subprocess.run(['/usr/bin/pgrep', '-f', str(binary)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if res.returncode == 0:
                return True
    return False


def _install_macos_launcher(home, live, applications_dir=None):
    if not live and applications_dir is None:
        return str(home / 'Applications' / MACOS_LAUNCHER_NAME)

    if applications_dir is not None:
        target_dir = Path(applications_dir)
    else:
        app_dirs = [Path('/Applications'), home / 'Applications']
        target_dir = next((d for d in app_dirs if d.is_dir() and os.access(d, os.W_OK)), home / 'Applications')
    target_dir.mkdir(parents=True, exist_ok=True)
    launcher_app = target_dir / MACOS_LAUNCHER_NAME

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        scpt_path = tmp_path / 'main.scpt.txt'
        scpt_path.write_text(MACOS_APPLESCRIPT, encoding='utf-8')
        built_app = tmp_path / MACOS_LAUNCHER_NAME
        subprocess.run(['/usr/bin/osacompile', '-o', str(built_app), str(scpt_path)], check=True)

        info_path = built_app / 'Contents' / 'Info.plist'
        with info_path.open('rb') as f:
            info = plistlib.load(f)
        info['CFBundleIdentifier'] = MACOS_LAUNCHER_BUNDLE_ID
        info['CFBundleName'] = 'Antigravity Launcher'
        info['CFBundleDisplayName'] = 'Antigravity Launcher'
        info['CFBundleShortVersionString'] = '1.1'
        info['CFBundleVersion'] = '1.1'
        info['LSUIElement'] = 0
        with info_path.open('wb') as f:
            plistlib.dump(info, f)

        for app_root in (Path('/Applications/Antigravity.app'), home / 'Applications/Antigravity.app'):
            icon_src = app_root / 'Contents' / 'Resources' / 'icon.icns'
            if icon_src.is_file():
                shutil.copy2(icon_src, built_app / 'Contents' / 'Resources' / 'applet.icns')
                break

        if launcher_app.exists():
            shutil.rmtree(launcher_app)
        shutil.copytree(built_app, launcher_app, symlinks=True)

    return str(launcher_app)


def _setup_macos(home, paths, live, applications_dir=None):
    script = paths['macos_script']
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(MACOS_CDP_SCRIPT, encoding='utf-8')
    os.chmod(script, 0o755)

    plist_path = _macos_plist_path(home)
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = str(home / 'Library' / 'Logs' / 'AntigravityCdpAgent.log')
    plist_data = {
        'Label': MACOS_AGENT_LABEL,
        'LimitLoadToSessionType': 'Aqua',
        'ProgramArguments': [str(script)],
        'RunAtLoad': True,
        'StandardErrorPath': log_path,
        'StandardOutPath': log_path,
    }
    tmp_plist = plist_path.with_name(plist_path.name + '.tmp')
    with tmp_plist.open('wb') as f:
        plistlib.dump(plist_data, f)
    os.replace(tmp_plist, plist_path)

    launcher_path = _install_macos_launcher(home, live, applications_dir=applications_dir)

    if live:
        if _macos_antigravity_running(home):
            paths['macos_skip_stamp'].write_text(str(int(time.time())), encoding='utf-8')
        uid = os.getuid()
        subprocess.run(['/bin/launchctl', 'bootout', f'gui/{uid}/{MACOS_AGENT_LABEL}'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        res = subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{uid}', str(plist_path)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode != 0:
            subprocess.run(['/bin/launchctl', 'load', '-w', str(plist_path)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    return {'launcherPath': launcher_path, 'plistPath': str(plist_path)}


def _setup_windows(paths, live, *, search_roots=None, exe_candidates=None,
                   fallback_desktop=None, run_reg_path=None):
    guard = paths['win_guard']
    guard.parent.mkdir(parents=True, exist_ok=True)
    guard.write_text(WINDOWS_GUARD_PS1, encoding='utf-8')
    shortcuts_updated = 0
    if live or search_roots is not None:
        env = {
            **os.environ,
            'AG_CDP_SHORTCUT_STATE': str(paths['win_shortcuts']),
            'AG_CDP_ARGS': CDP_ARGS,
            'AG_CDP_RUN_NAME': WINDOWS_RUN_VALUE,
            'AG_CDP_GUARD_PS1': str(guard),
        }
        if search_roots is not None:
            env['AG_CDP_SEARCH_ROOTS'] = ';'.join(str(p) for p in search_roots)
        if exe_candidates is not None:
            env['AG_CDP_EXE_CANDIDATES'] = ';'.join(str(p) for p in exe_candidates)
        if fallback_desktop is not None:
            env['AG_CDP_FALLBACK_DESKTOP'] = str(fallback_desktop)
        if run_reg_path is not None:
            env['AG_CDP_RUN_REG_PATH'] = str(run_reg_path)

        res = subprocess.run(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PATCH_SHORTCUTS_PS1],
            env=env, capture_output=True, text=True, check=True,
        )
        for line in res.stdout.splitlines():
            if line.startswith('SHORTCUTS='):
                try:
                    shortcuts_updated = int(line.split('=', 1)[1].strip())
                except ValueError:
                    pass
    return {'shortcutsUpdated': shortcuts_updated}


def _restore_windows(paths, live, *, run_reg_path=None):
    if not (live or run_reg_path is not None):
        return
    env = {
        **os.environ,
        'AG_CDP_SHORTCUT_STATE': str(paths['win_shortcuts']),
        'AG_CDP_RUN_NAME': WINDOWS_RUN_VALUE,
    }
    if run_reg_path is not None:
        env['AG_CDP_RUN_REG_PATH'] = str(run_reg_path)
    subprocess.run(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_RESTORE_SHORTCUTS_PS1],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def _setup_linux(home, paths, live):
    if not live:
        return {}
    candidates = [
        home / '.local' / 'share' / 'applications' / 'antigravity.desktop',
        Path('/usr/share/applications/antigravity.desktop'),
        Path('/usr/local/share/applications/antigravity.desktop'),
    ]
    source = next((p for p in candidates if p.is_file()), None)
    if not source:
        return {}
    content = source.read_text(encoding='utf-8')
    if '--remote-debugging-port=' in content:
        return {'desktopFile': str(source)}
    lines = []
    for line in content.splitlines():
        if line.startswith('Exec=') and '--remote-debugging-port=' not in line:
            if ' %' in line:
                head, tail = line.split(' %', 1)
                line = f'{head} {CDP_ARGS} %{tail}'
            else:
                line = f'{line} {CDP_ARGS}'
        lines.append(line)
    target = home / '.local' / 'share' / 'applications' / 'antigravity.desktop'
    target.parent.mkdir(parents=True, exist_ok=True)
    if not paths['linux_desktop_state'].exists():
        _write_json(paths['linux_desktop_state'], {
            'target': str(target),
            'hadOriginalUserFile': target.exists(),
            'originalContent': target.read_text(encoding='utf-8') if target.exists() else None,
        })
    target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return {'desktopFile': str(target)}


def ensure_cdp_bootstrap(plugin_id, *, home=None, platform=None, env=None, quiet=False):
    """Install or update the shared CDP bootstrap idempotently for plugin_id."""
    home = Path(home) if home is not None else Path.home()
    platform = platform or sys.platform
    env = os.environ if env is None else env
    paths = shared_paths(home)
    live = _is_live_system(home, platform)

    consumers = _register_consumer(paths, plugin_id)
    existing = _read_json(paths['version'], {})
    existing_ver = int(existing.get('schemaVersion', 0) or 0)

    if existing_ver > SCHEMA_VERSION:
        status = inspect_cdp_status(home=home, platform=platform, env=env)
        if not quiet:
            print(f'[CDP] 检测到更新版本的共享 CDP 启动配置 (schema v{existing_ver})，已直接复用。')
        return {'action': 'reused_newer', 'consumers': consumers, **status}

    details = {}
    try:
        if platform == 'darwin':
            details = _setup_macos(home, paths, live)
        elif platform == 'win32':
            details = _setup_windows(paths, live)
        elif platform.startswith('linux'):
            details = _setup_linux(home, paths, live)
    except Exception as exc:
        if not quiet:
            print(f'[WARN] 配置共享 CDP 启动入口时出现异常（不影响插件注册）: {exc}', file=sys.stderr)
        return {'action': 'warning', 'error': str(exc), 'consumers': consumers}

    _write_json(paths['version'], {
        'schemaVersion': SCHEMA_VERSION,
        'updatedBy': plugin_id,
        **details,
    })

    status = inspect_cdp_status(home=home, platform=platform, env=env)
    if not quiet:
        if platform == 'darwin':
            launcher = details.get('launcherPath') or f'/Applications/{MACOS_LAUNCHER_NAME}'
            print(f'[CDP] 已配置共享登录自启 ({MACOS_AGENT_LABEL}) 与启动器: {launcher}')
            if live and not status['cdpReady']:
                print('[CDP] 提示: 请完全退出当前 Antigravity 后，通过「Antigravity Launcher」重新打开以开启调试端口（建议替换 Dock 原图标）。')
        elif platform == 'win32':
            print('[CDP] 已为 Antigravity 快捷方式注入本地调试端口参数，并启用登录自检守护。')
            if live and not status['cdpReady']:
                print('[CDP] 提示: 请完全退出并重新打开 Antigravity（若使用任务栏旧固定图标未生效，请取消固定后从桌面/开始菜单重新固定）。')
        elif platform.startswith('linux') and details.get('desktopFile'):
            print(f"[CDP] 已更新桌面启动入口: {details['desktopFile']}")

    return {'action': 'configured', 'consumers': consumers, **details, **status}


def remove_cdp_bootstrap(plugin_id, *, home=None, platform=None, force=False, quiet=False):
    """Unregister plugin_id and remove shared CDP bootstrap only when no active consumer remains."""
    home = Path(home) if home is not None else Path.home()
    platform = platform or sys.platform
    paths = shared_paths(home)
    live = _is_live_system(home, platform)

    if not paths['root'].exists() and not _macos_plist_path(home).exists():
        return {'removed': False, 'remaining': []}

    remaining = _unregister_consumer(home, paths, plugin_id)
    if remaining and not force:
        if not quiet:
            print(f'[CDP] 保留共享 CDP 启动配置（仍有其他插件依赖: {", ".join(remaining)}）。')
        return {'removed': False, 'remaining': remaining}

    version_info = _read_json(paths['version'], {})
    try:
        if platform == 'darwin':
            plist_path = _macos_plist_path(home)
            if live and plist_path.exists():
                uid = os.getuid()
                subprocess.run(['/bin/launchctl', 'bootout', f'gui/{uid}/{MACOS_AGENT_LABEL}'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if plist_path.exists():
                plist_path.unlink()
            launcher_candidates = [
                Path(version_info['launcherPath']) if version_info.get('launcherPath') else None,
                Path('/Applications') / MACOS_LAUNCHER_NAME,
                home / 'Applications' / MACOS_LAUNCHER_NAME,
            ]
            for candidate in launcher_candidates:
                if candidate and candidate.exists():
                    info_file = candidate / 'Contents' / 'Info.plist'
                    try:
                        with info_file.open('rb') as f:
                            bid = plistlib.load(f).get('CFBundleIdentifier')
                        if bid == MACOS_LAUNCHER_BUNDLE_ID:
                            shutil.rmtree(candidate)
                    except Exception:
                        pass
        elif platform == 'win32':
            _restore_windows(paths, live)
        elif platform.startswith('linux') and live and paths['linux_desktop_state'].is_file():
            state = _read_json(paths['linux_desktop_state'], {})
            target = Path(state['target']) if state.get('target') else None
            if target:
                if state.get('hadOriginalUserFile') and state.get('originalContent') is not None:
                    target.write_text(state['originalContent'], encoding='utf-8')
                elif target.exists():
                    target.unlink()
    except Exception as exc:
        if not quiet:
            print(f'[WARN] 清理共享 CDP 启动配置时出现异常: {exc}', file=sys.stderr)

    if paths['root'].exists():
        shutil.rmtree(paths['root'], ignore_errors=True)
    if not quiet:
        print('[CDP] 已清理共享 CDP 启动配置与启动器。')
    return {'removed': True, 'remaining': []}
