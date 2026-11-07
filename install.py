#!/usr/bin/env python3
"""
Antigravity Timeline Navigator - One-line Bootstrap Installer.
Cross-platform support: macOS, Linux, and Windows.
Zero external dependencies (Python 3 standard library only).
"""
import io
import json
import os
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

GITHUB_REPO = "moumouye/antigravity-timeline"
ARCHIVE_URL = f"https://github.com/{GITHUB_REPO}/archive/refs/heads/main.zip"

HOME = Path.home()
CONFIG_DIR = HOME / ".gemini" / "config"
PLUGINS_DIR = CONFIG_DIR / "plugins"
PLUGIN_TARGET = PLUGINS_DIR / "antigravity-timeline"
CONFIG_FILE = CONFIG_DIR / "config.json"


def print_step(step: str, title: str):
    print(f"\n\033[1;36m==>\033[0m \033[1m[{step}] {title}\033[0m")


def main():
    print("\n\033[1;32m=== Antigravity Timeline Navigator 安装向导 ===\033[0m")
    print(f"目标安装路径: {PLUGIN_TARGET}")

    # 1. 确保目录环境
    PLUGINS_DIR.mkdir(parents=True, exist_ok=True)

    # 2. 下载仓库 ZIP 压缩包
    print_step("1/3", f"正在从 GitHub 拉取最新插件源码 ({GITHUB_REPO})...")
    try:
        req = urllib.request.Request(
            ARCHIVE_URL,
            headers={"User-Agent": "Antigravity-Timeline-Installer/1.0"}
        )
        with urllib.request.urlopen(req) as resp:
            zip_bytes = resp.read()
    except Exception as e:
        print(f"\033[1;31m[ERROR]\033[0m 下载插件包失败: {e}")
        print("提示：若处于受限网络环境，请先手动 git clone 后运行: python3 manage.py install")
        sys.exit(1)

    # 3. 解压缩与覆盖安装
    print_step("2/3", "正在解压并部署插件文件...")
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
            root_dir = z.namelist()[0].split('/')[0]
            if PLUGIN_TARGET.exists() or PLUGIN_TARGET.is_symlink():
                if PLUGIN_TARGET.is_symlink():
                    PLUGIN_TARGET.unlink()
                else:
                    shutil.rmtree(PLUGIN_TARGET)
            PLUGIN_TARGET.mkdir(parents=True, exist_ok=True)

            for member in z.infolist():
                if member.filename.startswith(root_dir + '/'):
                    rel_path = member.filename[len(root_dir) + 1:]
                    if not rel_path:
                        continue
                    dest_file = PLUGIN_TARGET / rel_path
                    if member.is_dir():
                        dest_file.mkdir(parents=True, exist_ok=True)
                    else:
                        dest_file.parent.mkdir(parents=True, exist_ok=True)
                        with z.open(member) as src, open(dest_file, 'wb') as dst:
                            shutil.copyfileobj(src, dst)
    except Exception as e:
        print(f"\033[1;31m[ERROR]\033[0m 解压安装失败: {e}")
        sys.exit(1)

    # 4. 注册并启用插件配置
    print_step("3/3", "正在宿主配置文件中注册并启用插件...")
    try:
        config = {}
        if CONFIG_FILE.exists():
            try:
                config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            except Exception:
                config = {}

        if "plugins" not in config or not isinstance(config["plugins"], dict):
            config["plugins"] = {}

        config["plugins"]["antigravity-timeline"] = {"enabled": True}

        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_file = CONFIG_FILE.with_name(CONFIG_FILE.name + ".tmp")
        temp_file.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temp_file.replace(CONFIG_FILE)
    except Exception as e:
        print(f"\033[1;33m[WARN]\033[0m 写入 config.json 失败: {e}")

    print("\n\033[1;32m🎉 安装成功！\033[0m")
    print("--------------------------------------------------")
    print("请完全退出并重新打开 \033[1mAntigravity 桌面客户端\033[0m 即可体验时间线导航。")
    print("后续管理（测试/更新/禁用/卸载）可在插件目录运行: python3 manage.py")
    print("--------------------------------------------------\n")


if __name__ == "__main__":
    main()
