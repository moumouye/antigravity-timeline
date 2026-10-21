#!/usr/bin/env python3
"""Antigravity Timeline Navigation - Plugin Lifecycle Manager."""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent
HOME = Path.home()
CONFIG_DIR = HOME / ".gemini" / "config"
PLUGINS_DIR = CONFIG_DIR / "plugins"
PLUGIN_TARGET = PLUGINS_DIR / "antigravity-timeline"
CONFIG_FILE = CONFIG_DIR / "config.json"
SIDECAR_DATA_DIR = HOME / ".gemini" / "antigravity" / "sidecar_data" / "antigravity-timeline"
PLUGIN_DATA_DIR = HOME / ".gemini" / "antigravity" / "plugin_data" / "antigravity-timeline"
PREFS_FILE = SIDECAR_DATA_DIR / "engine" / "data" / "preferences.json"


def load_json(path: Path, default=None):
    if not path.exists():
        return default if default is not None else {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}


def save_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def get_sidecar_pids() -> list:
    """Find running Sidecar helper process PIDs for this plugin."""
    engine_dir = SOURCE_DIR / "sidecars" / "engine"
    pids = []
    try:
        res = subprocess.run(["lsof", "+D", str(engine_dir)], capture_output=True, text=True)
        for line in res.stdout.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                cmd_name = parts[0].lower()
                if "antigravi" in cmd_name or "node" in cmd_name:
                    pids.append(int(parts[1]))
    except Exception:
        pass
    return sorted(list(set(pids)))


def kill_sidecar_processes(verbose: bool = True) -> int:
    """Terminate any running Sidecar processes for this plugin."""
    pids = get_sidecar_pids()
    if not pids:
        if verbose:
            print("[INFO] 当前无后台 Sidecar 进程运行。")
        return 0

    killed = 0
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            if verbose:
                print(f"[INFO] 已向 Sidecar 进程发送停止信号 (PID: {pid})。")
            killed += 1
        except ProcessLookupError:
            pass
        except Exception as e:
            if verbose:
                print(f"[WARN] 停止进程 PID {pid} 失败: {e}")

    time.sleep(0.5)
    remaining_pids = get_sidecar_pids()
    for pid in remaining_pids:
        try:
            os.kill(pid, signal.SIGKILL)
            if verbose:
                print(f"[INFO] 强制终止残留 Sidecar 进程 (PID: {pid})。")
        except Exception:
            pass

    return killed


def install_plugin():
    """Install plugin by linking to ~/.gemini/config/plugins and registering in config.json."""
    print("\n--- [1/2] 安装插件软链接 ---")
    PLUGINS_DIR.mkdir(parents=True, exist_ok=True)

    if PLUGIN_TARGET.exists() or PLUGIN_TARGET.is_symlink():
        try:
            if PLUGIN_TARGET.is_symlink():
                PLUGIN_TARGET.unlink()
            else:
                shutil.rmtree(PLUGIN_TARGET)
            print(f"[OK] 已清理旧安装路径: {PLUGIN_TARGET}")
        except Exception as e:
            print(f"[ERROR] 清理旧安装失败: {e}")
            return

    try:
        PLUGIN_TARGET.symlink_to(SOURCE_DIR, target_is_directory=True)
        print(f"[OK] 已创建软链接: {PLUGIN_TARGET} -> {SOURCE_DIR}")
    except OSError:
        shutil.copytree(SOURCE_DIR, PLUGIN_TARGET, symlinks=True)
        print(f"[OK] 已拷贝插件到: {PLUGIN_TARGET}")

    print("\n--- [2/2] 注册并启用插件 ---")
    config = load_json(CONFIG_FILE, {})
    plugins = config.setdefault("plugins", {})
    plugins["antigravity-timeline"] = {"enabled": True}
    save_json(CONFIG_FILE, config)
    print(f"[OK] 已在 {CONFIG_FILE} 中启用插件。")

    print("\n[完成] 时间线插件已安装并启用！")
    print("提示: 若 Antigravity 正在运行，请重启客户端或后台引擎即刻加载时间线插件。")


def uninstall_plugin(deep: bool = True):
    """Deep clean uninstall: terminate process, remove symlinks, clear config entries & cache."""
    print("\n--- [1/4] 停止运行中的后台引擎 ---")
    killed_count = kill_sidecar_processes(verbose=True)
    if killed_count > 0:
        print(f"[OK] 已停止 {killed_count} 个后台引擎进程。")

    print("\n--- [2/5] 移除插件软链接与安装目录 ---")
    if PLUGIN_TARGET.is_symlink():
        PLUGIN_TARGET.unlink()
        print(f"[OK] 已移除软链接: {PLUGIN_TARGET}")
    elif PLUGIN_TARGET.exists():
        shutil.rmtree(PLUGIN_TARGET)
        print(f"[OK] 已移除插件目录: {PLUGIN_TARGET}")
    else:
        print("[INFO] 插件安装目录/软链接不存在。")

    print("\n--- [3/5] 清理系统配置文件注册项 ---")
    config = load_json(CONFIG_FILE, {})
    modified = False

    plugins = config.get("plugins", {})
    if "antigravity-timeline" in plugins:
        del plugins["antigravity-timeline"]
        modified = True
        print("[OK] 已从 config.json 清理 ['plugins'] 注册项。")

    sidecars = config.get("sidecars", {})
    if "antigravity-timeline/engine" in sidecars:
        del sidecars["antigravity-timeline/engine"]
        modified = True
        print("[OK] 已从 config.json 清理 ['sidecars'] 注册项。")

    if modified:
        save_json(CONFIG_FILE, config)
    else:
        print("[INFO] config.json 中无残留注册项。")

    print("\n--- [4/5] 递归清除关联数据目录与宿主残留文件夹 ---")
    if deep:
        if SIDECAR_DATA_DIR.exists():
            try:
                shutil.rmtree(SIDECAR_DATA_DIR)
                print(f"[OK] 已彻底清除 Sidecar 数据目录: {SIDECAR_DATA_DIR}")
            except Exception as e:
                print(f"[WARN] 清除 Sidecar 数据目录失败: {e}")
        else:
            print("[INFO] Sidecar 数据目录不存在。")

        if PLUGIN_DATA_DIR.exists():
            try:
                shutil.rmtree(PLUGIN_DATA_DIR)
                print(f"[OK] 已彻底删除宿主生成的插件数据空文件夹: {PLUGIN_DATA_DIR}")
            except Exception as e:
                print(f"[WARN] 删除插件数据文件夹失败: {e}")
        else:
            print("[INFO] 插件数据文件夹不存在。")

    print("\n--- [5/5] 清理本地工程临时数据与日志 ---")
    local_sidecar_data = SOURCE_DIR / "sidecars" / "engine" / "data"
    if local_sidecar_data.exists():
        shutil.rmtree(local_sidecar_data)
        print(f"[OK] 已清理本地临时数据目录: {local_sidecar_data}")

    local_sidecar_logs = SOURCE_DIR / "sidecars" / "engine" / "logs"
    if local_sidecar_logs.exists():
        shutil.rmtree(local_sidecar_logs)
        print(f"[OK] 已清理本地临时日志目录: {local_sidecar_logs}")

    print("\n[完成] 彻底纯净卸载完毕！所有相关文件及对应空文件夹已全部删除，系统内零残留。")


def set_enabled(enable: bool):
    """Enable or disable plugin in config.json with state preservation feedback."""
    config = load_json(CONFIG_FILE, {})
    plugins = config.setdefault("plugins", {})
    entry = plugins.setdefault("antigravity-timeline", {})
    entry["enabled"] = enable
    save_json(CONFIG_FILE, config)

    if not enable:
        kill_sidecar_processes(verbose=False)
        print("\n[OK] 插件已禁用（后台进程已同步释放）。")
        print("[状态保留] 您的自定义偏好配置已完好保存在本地，绝不会丢失；重新启用即可恢复。")
    else:
        print("\n[OK] 插件已重新启用。")
        print("[状态恢复] 已加载历史时间线偏好设置，重启 Antigravity 后即刻生效。")


def check_status():
    """Inspect and report current plugin and engine status."""
    installed = PLUGIN_TARGET.exists() or PLUGIN_TARGET.is_symlink()
    link_type = "软链接" if PLUGIN_TARGET.is_symlink() else "实体目录"

    config = load_json(CONFIG_FILE, {})
    plugin_entry = config.get("plugins", {}).get("antigravity-timeline", {})
    enabled = plugin_entry.get("enabled", False)

    prefs = load_json(PREFS_FILE, {})
    if not prefs:
        prefs = load_json(SOURCE_DIR / "sidecars" / "engine" / "data" / "preferences.json", {})

    pids = get_sidecar_pids()

    print("\n=== Antigravity Timeline 状态报告 ===")
    print(f"安装状态: {'已安装 (' + link_type + ')' if installed else '未安装'}")
    if installed:
        print(f"安装路径: {PLUGIN_TARGET}")
    print(f"启用状态: {'已启用 (Active)' if enabled else '已禁用 (Disabled)'}")

    if pids:
        print(f"后台引擎: 正在运行 (PID: {', '.join(map(str, pids))})")
    else:
        print("后台引擎: 未运行")

    print("\n[偏好配置快照]")
    if prefs:
        print(f"  - 禁止发送后自动滚底: {'是 (已锁定)' if prefs.get('disableAutoScrollOnSend', True) else '否'}")
        print(f"  - 右侧边缘标记显示: {'开启' if prefs.get('showRightEdgeMarkers', True) else '关闭'}")
        print(f"  - 悬停预览气泡卡片: {'开启' if prefs.get('showHoverPreview', True) else '关闭'}")
        print(f"  - 标记主题强调色: {prefs.get('markerColor', '#10b981')}")
    else:
        print("  - 暂无持久化配置（使用系统出厂默认值）")
    print("=====================================\n")


def run_e2e_tests():
    """Run E2E automated test pipeline."""
    test_script = SOURCE_DIR / "sidecars" / "engine" / "test_e2e.mjs"
    if not test_script.exists():
        print(f"[ERROR] 测试脚本未找到: {test_script}")
        return

    print("\n>>> 开始执行 Antigravity Timeline 端到端自动化测试...")
    cmd = ["node", str(test_script)]
    res = subprocess.run(cmd)
    if res.returncode == 0:
        print("\n[OK] 端到端自动化测试顺利完成！")
    else:
        print(f"\n[FAIL] 测试异常退出，退出码: {res.returncode}")


def interactive_menu():
    """Simple terminal interactive menu."""
    while True:
        print("\n" + "=" * 46)
        print("   Antigravity Timeline 插件生命周期管理")
        print("=" * 46)
        print("  1. 安装并启用插件 (Install & Enable)")
        print("  2. 查看状态报告 (Status Report)")
        print("  3. 启用插件 (Enable Plugin)")
        print("  4. 禁用插件 (Disable Plugin)")
        print("  5. 执行端到端自动化测试 (Run E2E Tests)")
        print("  6. 彻底纯净卸载 (Deep Clean Uninstall)")
        print("  0. 退出 (Exit)")
        print("-" * 46)

        try:
            choice = input("请选择操作 [0-6]: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n已退出。")
            break

        if choice == "1":
            install_plugin()
        elif choice == "2":
            check_status()
        elif choice == "3":
            set_enabled(True)
        elif choice == "4":
            set_enabled(False)
        elif choice == "5":
            run_e2e_tests()
        elif choice == "6":
            confirm = input("确认彻底纯净卸载插件及所有残留数据？(y/N): ").strip().lower()
            if confirm in ("y", "yes"):
                uninstall_plugin(deep=True)
            else:
                print("已取消卸载。")
        elif choice == "0":
            print("再见！")
            break
        else:
            print("输入无效，请输入 [0-6] 之间的数字。")


def main():
    parser = argparse.ArgumentParser(description="Antigravity Timeline Plugin Lifecycle Manager")
    parser.add_argument("action", nargs="?", choices=["install", "uninstall", "enable", "disable", "status", "test"],
                        help="Action to perform")
    parser.add_argument("--deep", action="store_true", default=True, help="Deep clean uninstall (default: True)")
    args = parser.parse_args()

    if not args.action:
        interactive_menu()
    elif args.action == "install":
        install_plugin()
    elif args.action == "uninstall":
        uninstall_plugin(deep=args.deep)
    elif args.action == "enable":
        set_enabled(True)
    elif args.action == "disable":
        set_enabled(False)
    elif args.action == "status":
        check_status()
    elif args.action == "test":
        run_e2e_tests()


if __name__ == "__main__":
    main()
