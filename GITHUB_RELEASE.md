# Antigravity Timeline Navigator v1.8.0 发版说明

### 核心更新与说明

- **跨平台共享无侵入 CDP 引导**：适配新版 Antigravity 默认关闭 CDP 的机制，新增共享引导模块 `compat/cdp_bootstrap.py`（与 Antigrative Dashboard、Font Settings 共用同一公共底座与引用计数卸载，严禁篡改原应用或 `app.asar`）：
  - **macOS**：自动配置登录自启项（`com.moumouye.antigravity-cdp`）与 `/Applications/Antigravity Launcher.app`；
  - **Windows**：自动为桌面、开始菜单与任务栏快捷方式注入 `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` 并支持卸载还原。
- **安装与管理修复**：
  - 在一键安装脚本 `install.py` 与 `manage.py install` 中自动配置共享 CDP 入口，新增 `manage.py setup-cdp` 命令；
  - 修复 `manage.py install` 在目标目录内执行时误删自身目录的边界缺陷，并将 `uninstall.sh` / `uninstall.ps1` 接入统一引用计数卸载流程；
  - 修复 Windows 仅检索 `%LOCALAPPDATA%\Antigravity` 漏掉 `%APPDATA%\Antigravity\DevToolsActivePort` 的端口发现问题，并兼容 Windows 非 UTF-8（`cp1252`）终端输出。
- **包含 v1.7.5 对话撤回与定位修复**：
  - 支持非系统事件 `step_index` 回滚分支剪枝，解决撤回（Undo/Rewind）或编辑重发后出现重复幽灵轮次的问题；
  - 建立 `scanTurns` 完全匹配优先（Tier 1.1），防止幽灵轮次占用 DOM 真实卡片。

---

*详细更新历史请参阅 [CHANGELOG.md](CHANGELOG.md)。*
