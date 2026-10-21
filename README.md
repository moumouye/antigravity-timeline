# Antigravity Timeline Navigator

面向 Antigravity 桌面客户端的非侵入式、极简纯粹对话时间线导航与智能视口控制插件。

无需解包或修改 `app.asar`，依托 Antigravity 原生 Sidecar 机制与 DevTools 调试通道（CDP），无侵入实现全量历史折叠消息感知展开、右侧侧边居中时间线手柄、悬停展开全量对话列表、点击毫秒级平滑定位、智能视口防滚屏锁定与双向持久化存储。架构设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 核心特性

- **右侧侧边居中时间线手柄**：在对话主视口右侧侧边垂直居中区域无缝挂载极简双线手柄，不遮挡内容，随手可触。
- **悬停自动展开全量对话列表**：鼠标悬停在手柄上即刻展开对话全景树，完整罗列从首轮至当前所有交互历史：
  - **第 1 行**：提问要点正文（单行省略截断）；
  - **第 2 行**：浅绿背景胶囊条（模型回答摘要单行截断）；
- **列表中点击快速定位与光晕脉冲**：在展开列表中点击任意一轮对话，主视口毫秒级平滑滚动至对应消息卡片，并触发专属发光脉冲（Glow Pulse）。
- **自动展开历史折叠消息**：彻底攻克宿主自动折叠早期交互的机制缺陷，自动平滑展开全部历史消息，完整呈现长对话全貌。
- **禁止发送后自动滑到底部（智能视口锁定）**：在发送新消息或模型流式输出时自动锁定当前阅读高度，彻底避免屏幕被强制拉到底部。
- **零干扰极简纯粹设计**：无冗余弹窗与分散元素，开箱即用，专注于长文时间线导航。

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

---

## 管理命令

直接运行 `uv run manage.py`（或 `python3 manage.py`）进入交互式控制台，或通过参数直接执行：

| 操作 | 推荐命令 | 说明 |
| :--- | :--- | :--- |
| **交互控制台** | `uv run manage.py` | 启动极简交互菜单，按数字键 [0-6] 选取操作 |
| 查看状态 | `uv run manage.py status` | 查看插件安装与后台引擎运行状态 |
| 安装启用 | `uv run manage.py install` | 建立软链接并在 `config.json` 中注册启用 |
| 启用插件 | `uv run manage.py enable` | 激活插件并生效时间线导航 |
| 禁用插件 | `uv run manage.py disable` | 暂时停用插件并释放后台引擎进程 |
| 自动化测试 | `uv run manage.py test` | 运行端到端自动化测试链路，验证全量折叠展开与手柄挂载 |
| 彻底卸载 | `uv run manage.py uninstall` | 纯净卸载：清理软链接、配置条目、运行数据及系统残留空文件夹（零残留） |

---

## 项目结构

```text
antigrative-timeline/
├── plugin.json               # 插件清单文件 (v1.3.0)
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
            ├── styles.css    # 原生 CSS 样式表 (右侧居中手柄、全量悬停菜单与发光脉冲)
            ├── i18n.js       # 中英双语国际化字典
            └── panel.js      # 自动折叠展开器、全量多轮扫描、Scrollspy 与平滑定位
```
