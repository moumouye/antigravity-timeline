# ① 边界与红线 (Boundaries & Constraints)

本文档定义 Antigravity Timeline 插件的系统架构边界、模块职责与不可逾越的物理红线。

---

## 1. 核心架构红线 (Non-negotiable Constraints)

系统核心架构约束与物理红线：

1. **主视口绝对静止红线 (Zero Scroll Displacement)**：
   * 鼠标悬停手柄、展开时间线菜单、列表滚动查阅，属于 **100% 纯读操作**；
   * 悬停交互期间，主视口位移严格恒定为 `0 像素`（`viewportScrollDelta === 0`），绝对禁止触发任何导致宿主重新计算滚动高度的模拟点击。
2. **沙箱隔离与通信红线 (No Direct Local File Fetch)**：
   * 页面注入层（`client/`）运行在 Chromium 渲染进程沙箱中，**严禁直接调用 `fetch("file://...")`**（会被浏览器安全策略拦截导致 `Failed to fetch`）；
   * 所有针对本地日志、配置文件和底层会话数据的访问，必须由后台 Node.js Sidecar 引擎读取，并通过 CDP WebSocket 管道推送到渲染层。
3. **冷热数据解耦红线 (Cold Metadata Decoupling)**：
   * 菜单时间线展示全量会话历史时，仅消费内存中的轻量 Prompt 元数据，严禁为了显示菜单而强行将全部早期节点展开挂载进宿主 DOM；
   * 仅当用户在菜单中**显式单击了某一轮折叠会话**时，才允许定向触发宿主展开该轮次并平滑定位。
4. **后台守护托管红线 (Host Daemon Ownership)**：
   * 插件后台引擎由 Antigravity 宿主插件系统在系统底层静默托管（`sidecar.json`）；
   * 禁止在客户端或任务交互层挂起常驻守护进程（Daemon Process），避免在宿主操作界面产生非预期的长任务指示框。

---

## 2. 模块职责与技术栈边界 (Module Responsibilities)

| 模块层级 | 物理位置 | 技术栈 | 职责与架构规范 |
| :--- | :--- | :--- | :--- |
| **宿主层 (Host)** | Antigravity 桌面端 | Electron / React | 宿主原生黑盒，严禁修改任何客户端二进制或 `app.asar` 归档。 |
| **引擎层 (Sidecar)** | `sidecars/engine/main.mjs` | Node.js 原生 ES Module | 负责探测 CDP 调试端口、监控文件变动、解析底层会话日志并执行 CDP 管道注入。基于原生标准库实现零外部依赖设计（Zero-dependency），保障秒级冷启动与轻量常驻；严禁直接操作前端 DOM 树。 |
| **注入层 (Client)** | `sidecars/engine/client/` | 原生 JS / CSS | 运行在渲染窗口内部，负责手柄与菜单 UI 渲染、视口监听与平滑跳转。严禁发起跨域本地文件请求，严禁直接读写操作系统文件系统。 |
| **测试门禁 (Testing)** | `sidecars/engine/test_e2e.mjs` | Node.js / CDP | 负责模拟用户交互并对核心指标进行硬性机器断言，直连 Electron 真实运行时。 |
| **生命周期管理 (CLI)** | `manage.py` | Python 3 标准库 | 插件安装、软链接建立、配置注册与启停管理。基于 Python 3 标准库实现开箱即用，无需用户预先配置独立包依赖。 |
