# Antigravity Timeline Navigator

面向 Antigravity 桌面客户端的非侵入式对话时间线导航与智能视口控制插件。

无需解包或修改 `app.asar`，依托 Antigravity 原生 Sidecar 机制与 DevTools 调试通道（CDP），无侵入实现长对话右侧边缘时间线标记、两行纯净悬停预览、原生设置弹窗集成、毫秒级平滑定位、智能视口防滚屏锁定与双向持久化存储。架构设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 核心特性

- **多轮交互全量识别**：全量遍历长对话中的所有交互轮次，真实呈现 `共 N 轮交互`，并在右侧滚动条边缘一一映射刻度。
- **右侧边缘时间线刻度**：在对话主视口右侧边缘无缝挂载极简双线刻度（`==`），精准对应每一轮交互在长文中的相对高度。
- **两行极简悬停预览卡片**：鼠标悬停在刻度上时展开纯净气泡：
  - **第 1 行**：提问要点正文（单行省略截断）；
  - **第 2 行**：浅绿背景胶囊条（模型回答摘要单行截断）；
  - 杜绝多层冗余与杂乱重叠。
- **原生设置弹窗集成**：在 Antigravity 官方 `⚙️ Settings` 设置弹窗左侧菜单中无缝挂载「Timeline Settings」标签页，控制项原生直达。
- **毫秒级平滑定位与光晕脉冲**：点击标记或预览卡片，主视口快速平滑滚动至目标消息，并触发 1.4 秒专属发光脉冲（Glow Pulse）。
- **禁止发送后自动滑到底部（智能视口锁定）**：在发送新消息或模型流式输出时自动锁定当前阅读高度，彻底避免屏幕被强制拉到底部。
- **免重启热更新与持久化**：后台 Node.js 守护进程毫秒级监听源码变动并执行热注入，偏好设置自动落盘，重启不丢失。

---

## 安装与使用

### 1. 启动管理器或安装插件
管理脚本完全基于 Python 3 标准库开发，**零第三方依赖**，无需安装任何外部 pip 包。在项目目录下运行：

```bash
uv run manage.py
# 或使用 Python 3 原生运行
python3 manage.py
```

终端将弹出交互式数字菜单，按数字键 `1` 即可一键完成安装与启用；亦可直接通过命令行参数执行：

```bash
uv run manage.py install
```

### 2. 重启 Antigravity 或重新加载
完全退出并重新打开 Antigravity 客户端（若后台引擎已在运行，热注入将自动完成）。

### 3. 打开原生设置弹窗调节
1. 点击主界面左下角的 **`⚙️ Settings`** 按钮（或按快捷键 `Cmd+,`）；
2. 在左侧菜单中点击 **「Timeline Settings」**；
3. 即可直接开关「禁止发送后自动滑到底部」、「右侧边缘刻度显示」与「悬停预览卡片」。

---

## 管理命令

直接运行 `uv run manage.py`（或 `python3 manage.py`）进入交互式控制台，或通过参数直接执行：

| 操作 | 推荐命令 | 说明 |
| :--- | :--- | :--- |
| **交互控制台** | `uv run manage.py` | 启动极简交互菜单，按数字键 [0-6] 选取操作 |
| 查看状态 | `uv run manage.py status` | 查看插件安装、偏好数据快照与后台引擎运行状态 |
| 安装启用 | `uv run manage.py install` | 建立软链接并在 `config.json` 中注册启用 |
| 启用插件 | `uv run manage.py enable` | 激活插件并自动继承已保存的历史偏好设置 |
| 禁用插件 | `uv run manage.py disable` | 暂时停用插件并释放进程，完整保留偏好配置 |
| 自动化测试 | `uv run manage.py test` | 运行端到端自动化测试链路，验证装配、CDP 连通性与 DOM 挂载 |
| 彻底卸载 | `uv run manage.py uninstall` | 纯净卸载：清理软链接、配置条目、运行数据及系统残留空文件夹（零残留） |

---

## 项目结构

```text
antigrative-timeline/
├── plugin.json               # 插件清单文件 (v1.1.0)
├── manage.py                 # 跨平台一键安装/管理工具（零外部依赖）
├── ARCHITECTURE.md           # 系统架构设计与 Mermaid 交互时序文档
├── CHANGELOG.md              # 严格遵循 SemVer 与 Emoji 排序规范的变更日志
├── README.md                 # 项目使用与管理说明文档
├── AGENTS.md                 # 项目版本控制与提交规范
├── assets/
│   └── logo.svg              # 插件矢量图标
└── sidecars/
    └── engine/
        ├── sidecar.json      # 后台服务清单
        ├── main.mjs          # CDP 调试端口发现、WebSocket 双向通信与热重载服务
        ├── test_e2e.mjs      # 自动化端到端测试链路
        └── client/           # 页面注入层源码模块
            ├── types.d.ts    # TypeScript 偏好与接口类型定义
            ├── styles.css    # 原生 CSS 样式表 (右侧双线、两行纯净卡片、设置弹窗样式与发光脉冲)
            ├── i18n.js       # 中英双语国际化字典
            └── panel.js      # DOM 全量多轮扫描、设置弹窗挂载、Scrollspy 与定位交互
```
