# 系统架构与实现原理 (System Architecture)

本项目为 Antigravity 桌面客户端提供非侵入式的对话时间线导航与智能视口控制能力。无需解包客户端二进制或修改 `app.asar`，利用 Antigravity 原生 Sidecar 运行机制与 Chrome DevTools Protocol (CDP) 调试桥接，实现右侧边缘时间线标记、悬停两行极简预览卡片、原生设置弹窗集成、毫秒级平滑定位、智能视口防滚屏锁定与免重启热重载。

---

## 1. 系统总体架构 (System Architecture)

系统由 **宿主层 (Host)**、**引擎层 (Sidecar Engine)**、**注入层 (Page Renderer)** 与 **数据持久化层 (Storage)** 四部分组成：

```mermaid
flowchart TB
    subgraph Host ["🖥️ Antigravity 宿主层 (Electron)"]
        DevTools["DevTools 活跃调试端口<br/>(DevToolsActivePort)"]
        Renderer["主渲染进程窗口<br/>(autoscroll-viewport / group/user-input-step)"]
        NativeSettings["官方设置弹窗<br/>(div[role='dialog'])"]
    end

    subgraph Sidecar ["⚙️ 引擎服务层 (Sidecar Engine)"]
        Main["main.mjs 守护进程<br/>(零依赖动态装配器)"]
        CDP["CDP Client (WebSocket)"]
        Watcher["源码变动轮询感知器 (3s Tick)"]
    end

    subgraph Client ["🎨 渲染注入层源码 (sidecars/engine/client/)"]
        Types["types.d.ts (TS 接口约束)"]
        Styles["styles.css (纯 CSS 与动效)"]
        I18n["i18n.js (中英双语字典)"]
        Panel["panel.js (DOM 全量扫描、设置弹窗挂载与交互)"]
    end

    subgraph Injected ["🎨 渲染注入层 (Page Context)"]
        Track["右侧边缘导轨 (#agy-timeline-track)"]
        Markers["双线刻度标记 (.agy-timeline-marker)"]
        Popover["两行纯净提问预览卡片 (#agy-timeline-popover)"]
        SettingsTab["原生设置弹窗挂载项 (#agy-timeline-settings-tab)"]
        SettingsPanel["时间线控制面板 (#agy-timeline-settings-panel)"]
        ScrollController["智能视口锁定与 Scrollspy 监听"]
        Binding["__agyTimelineSavePrefs() RPC 绑定"]
    end

    subgraph Storage ["💾 数据持久化层"]
        Prefs["preferences.json<br/>(用户偏好与视口锁定设置)"]
    end

    Main -->|探测调试端口| DevTools
    Main -->|建立 WebSocket 会话| CDP
    CDP <==>|双向通信通道| Renderer

    Watcher -->|监听模块文件变动| Client
    Client -->|内存动态装配| Main
    Main -->|运行时 CDP 动态评估注入| CDP

    Renderer --> Track
    Track --> Markers
    Markers --> Popover
    NativeSettings --> SettingsTab
    SettingsTab --> SettingsPanel
    Renderer --> ScrollController
    SettingsPanel -->|配置切换| Binding
    Binding -->|CDP 事件回传| Main
    Main -->|原子写入| Prefs
    Prefs -.->|启动时回填| Main
```

---

## 2. 多轮对话扫描与定位时序 (Multi-turn Scan & Navigation)

系统通过全量扫描长对话中的用户提问卡片与对应 AI 回答段落，建立高保真时间轴树：

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 用户
    participant Viewport as 🖥️ autoscroll-viewport
    participant Engine as 🎨 panel.js (全量扫描引擎)
    participant Marker as 🏷️ 右侧双线刻度 (==)
    participant Popover as 💬 两行极简预览卡片

    Note over Viewport, Engine: 多轮对话感知阶段
    Engine->>Viewport: 全量遍历 div[class*="group/user-input-step"]
    Viewport-->>Engine: 捕获所有轮次用户提问、时间戳与回复段落
    Engine->>Marker: 按相对高度动态渲染多个对应刻度

    Note over User, Popover: 悬停简洁预览阶段
    User->>Marker: 鼠标移入第 N 轮刻度
    Marker->>Popover: 呈现两行纯净卡片
    Note over Popover: 第 1 行：提问正文（省略截断）<br/>第 2 行：浅绿胶囊回答摘要（省略截断）
    Popover-->>User: 极致简洁明了，无冗余杂乱元素

    Note over User, Viewport: 点击定位阶段
    User->>Popover: 点击卡片或右侧刻度
    Popover->>Viewport: scrollIntoView({ behavior: 'smooth', block: 'center' })
    Viewport-->>User: 视口平滑定位并触发 1.4s 柔和光晕脉冲
```

---

## 3. 原生设置弹窗深度集成 (Native Settings Modal Integration)

对标 `Antigravity-font-settings`，系统监听宿主 `⚙️ Settings`（`div[role="dialog"]`）的生命周期：
1. **菜单挂载**：在设置弹窗左侧导航栏末尾自动插入带图标的「Timeline Settings」按钮；
2. **面板切换**：点击时激活该 Tab，并平滑隐藏原生面板，呈现专属时间线配置表单；
3. **设置项清单**：
   - `禁止发送后自动滑到底部`（开关，智能锁定视口）
   - `在右侧边缘显示时间线刻度`（开关，显示/隐藏右侧刻度）
   - `悬停刻度显示提问预览卡片`（开关，显示/隐藏 Popover）
4. **实时落盘**：配置变更通过 CDP 绑定 `__agyTimelineSavePrefs` 实时写入磁盘 `preferences.json`。

---

## 4. 关键设计原则与隔离规范

1. **非侵入原则**：完全依托 Antigravity 官方 Sidecar 架构与 CDP 调试协议，不修改客户端二进制或 ASAR 归档。
2. **文本截断与紧凑排版**：提问首行超出 48 字符自动截断附加 `...`；回答摘要超出 42 字符单行截断，保证气泡体积轻巧美观。
3. **零外部依赖**：管理脚本 [`manage.py`](manage.py) 完全基于 Python 3 标准库构建，无需 pip 安装任何三方库；卸载时提供纯净 5 步清理，确保系统零残留。
