# 系统架构与实现原理 (System Architecture)

本项目为 Antigravity 桌面客户端提供非侵入式的对话时间线导航与智能视口控制能力。无需解包客户端二进制或修改 `app.asar`，利用 Antigravity 原生 Sidecar 运行机制与 Chrome DevTools Protocol (CDP) 调试桥接，实现右侧边缘时间线标记、悬停预览卡片、毫秒级平滑定位、智能视口防滚屏锁定与免重启热重载。

---

## 1. 系统总体架构 (System Architecture)

系统由 **宿主层 (Host)**、**引擎层 (Sidecar Engine)**、**注入层 (Page Renderer)** 与 **数据持久化层 (Storage)** 四部分组成：

```mermaid
flowchart TB
    subgraph Host ["🖥️ Antigravity 宿主层 (Electron)"]
        DevTools["DevTools 活跃调试端口<br/>(DevToolsActivePort)"]
        Renderer["主渲染进程窗口<br/>(autoscroll-viewport / turnContent)"]
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
        Panel["panel.js (DOM 扫描、监听与交互)"]
    end

    subgraph Injected ["🎨 渲染注入层 (Page Context)"]
        Track["右侧边缘导轨 (#agy-timeline-track)"]
        Markers["双线刻度标记 (.agy-timeline-marker)"]
        Popover["悬停提问预览卡片 (#agy-timeline-popover)"]
        Drawer["完整时间线抽屉 (#agy-timeline-drawer)"]
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
    Renderer --> Drawer
    Renderer --> ScrollController
    Drawer -->|配置切换| Binding
    Binding -->|CDP 事件回传| Main
    Main -->|原子写入| Prefs
    Prefs -.->|启动时回填| Main
```

---

## 2. 核心交互与定位时序 (Interaction & Navigation Sequence)

用户通过右侧边缘的时间线标记或抽屉节点进行快速定位时，视口平滑滚动与目标视觉反馈的流转时序如下：

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 用户
    participant Marker as 🏷️ 右侧标记 (==)
    participant Popover as 💬 悬停预览卡片
    participant Viewport as 🖥️ 主视口 (autoscroll-viewport)
    participant Target as 🎯 目标对话卡片 (Turn)
    participant Engine as ⚙️ Sidecar 引擎

    Note over User, Marker: 悬停查看阶段
    User->>Marker: 鼠标移入右侧时间线刻度
    Marker->>Popover: 依据相对高度计算坐标并呈现
    Popover-->>User: 展现该轮用户提问正文、回复摘要与时间戳

    Note over User, Target: 点击定位与光晕引导阶段
    User->>Popover: 点击预览卡片或右侧刻度
    Popover->>Viewport: scrollIntoView({ behavior: 'smooth', block: 'center' })
    Viewport-->>User: 视口毫秒级平滑滚动至目标消息处
    Popover->>Target: 添加 .agy-timeline-target-highlight
    Target-->>User: 触发由外向内的柔和光晕脉冲动画 (1.4s)

    Note over User, Engine: 偏好设置变更阶段
    User->>Popover: 勾选「禁止发送后自动滑到底部」
    Popover->>Engine: 触发 __agyTimelineSavePrefs(json)
    Engine->>Engine: 原子持久化至 preferences.json
```

---

## 3. 智能视口锁定机制 (Smart Scroll Lock)

Antigravity 宿主在用户发送消息或 Agent 流式响应时，默认会强制执行滚动到底部逻辑。本项目通过对用户交互事件的深度捕获与视口位置检测实现智能锁定：

```mermaid
flowchart TD
    Start["用户在输入框敲击 Enter 发送 Prompt"] --> CheckPref{"是否开启「禁止自动滚底」偏好？"}
    CheckPref -- 否 --> DefaultScroll["宿主默认自动滚底"]
    CheckPref -- 喜 --> RecordPos["捕获当前视口阅读高度 scrollTop"]
    RecordPos --> LockLoop["维持当前视口阅读位置 (持续 2000ms)"]
    LockLoop --> UserChoice["用户可自由阅读历史代码或按需点击「⬇️ 触底」"]
```

---

## 4. 免重启热重载机制 (Hot-Reloading Sequence)

当开发者修改了 `client/` 下的样式（`styles.css`）、国际化文案（`i18n.js`）或交互控制器（`panel.js`）时，后台引擎通过 CDP 自动执行热重载，无需关闭或重启 Antigravity 宿主：

```mermaid
sequenceDiagram
    autonumber
    actor Dev as 👨‍💻 源码更新
    participant File as 📄 client/ 源码模块
    participant Engine as ⚙️ main.mjs (装配轮询器)
    participant CDP as 🔌 CDP 通道 (WebSocket)
    participant Page as 🖥️ 运行中的 Antigravity 窗口

    Dev->>File: 保存新样式或交互逻辑
    loop 每 3 秒定期检测
        Engine->>File: 读取模块内容并计算装配哈希 (tick)
    end
    File-->>Engine: 感知源码哈希变动
    Engine->>Engine: 内存中动态拼装为新版 IIFE 闭包
    Engine->>CDP: Runtime.evaluate (注入最新脚本源码)
    CDP->>Page: 页面执行热重载
    Page-->>Page: 自动卸载旧 DOM 结构，无缝挂载新版时间线与标记
    Note over Dev, Page: ✅ 全程无需关闭或重启客户端，新功能与样式即时生效
```

---

## 5. 关键设计原则与隔离规范

1. **非侵入原则**：完全依托 Antigravity 官方 Sidecar 架构与 CDP 调试协议，不修改客户端二进制或 ASAR 归档。
2. **样式作用域隔离**：所有注入样式均封装在 `#agy-timeline-*` 命名空间内，利用宿主已有的原生 CSS 变量（`--background`, `--foreground`, `--border`, `--card`, `--primary` 等），实现明暗主题自适应。
3. **零外部依赖**：管理脚本 [`manage.py`](manage.py) 完全基于 Python 3 标准库构建，无需 pip 安装任何三方库；卸载时提供纯净 5 步清理，确保系统零残留。
