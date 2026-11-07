#!/usr/bin/env bash
set -e

echo -e "\033[1;36m==>\033[0m 正在卸载 Antigravity Timeline 插件..."

# 1. 停止运行中的 Sidecar 引擎进程
pkill -f "sidecars/engine/main.mjs" 2>/dev/null || true
pkill -f "antigravity-timeline" 2>/dev/null || true

# 2. 移除插件目录或软链接
TARGET_DIR="$HOME/.gemini/config/plugins/antigravity-timeline"
if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
    echo -e "\033[1;32m[OK]\033[0m 已清理插件安装目录: $TARGET_DIR"
fi

# 3. 清理运行时数据与持久化配置
rm -rf "$HOME/.gemini/antigravity/sidecar_data/antigravity-timeline"
rm -rf "$HOME/.gemini/antigravity/plugin_data/antigravity-timeline"

# 4. 从 config.json 中注销插件
CONFIG_FILE="$HOME/.gemini/config/config.json"
if [ -f "$CONFIG_FILE" ]; then
    if command -v python3 &>/dev/null; then
        python3 -c '
import json, os
p = os.path.expanduser("~/.gemini/config/config.json")
try:
    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)
    if "plugins" in data and "antigravity-timeline" in data["plugins"]:
        del data["plugins"]["antigravity-timeline"]
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
except Exception:
    pass
'
    fi
fi

echo -e "\033[1;32m🎉 卸载完成（零文件残留）！\033[0m"
echo "请完全退出并重启 Antigravity 客户端以生效。"
