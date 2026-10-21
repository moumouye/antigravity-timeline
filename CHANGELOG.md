# 变更日志 (CHANGELOG)

本项目遵循 [语义化版本规范 (SemVer)](https://semver.org/lang/zh-CN/) 与 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范。

---

## [Unreleased]

## [1.0.0] - 2026-10-21

- ✨ `feat`: 新增右侧边缘对话时间线刻度标记，直观映射各轮交互在长文中的相对高度
- ✨ `feat`: 新增悬停提问预览卡片（Popover），支持查看提问正文、回复摘要与时间戳
- ✨ `feat`: 新增点击快速平滑定位（`scrollIntoView`）与目标卡片专属光晕脉冲动画（Glow Pulse）
- ✨ `feat`: 新增「禁止发送后自动滑到底部」智能视口锁定机制，保持用户当前阅读高度
- ✨ `feat`: 新增时间线节点 `🌿 分支 (Fork)` 交互入口与消息快照接口预留
- ✨ `feat`: 新增完整时间线折叠抽屉面板，集成一键置顶、一键触底与配置开关
- ✨ `feat`: 新增视口滚动联动追踪机制（Scrollspy），自动高亮当前视野内的活跃交互轮次
- 💄 `style`: 设计符合 Antigravity 原生暗色/亮色风格的毛玻璃悬停卡片与抽屉排版
- 💄 `style`: 添加符合用户预期的右侧双绿线刻度（`==`）与发光脉冲关键帧动画
- 🌐 `i18n`: 引入中英文双语字典，支持随系统语言自动适配文案
- ♻️ `refactor`: 采用模块化前端注入层架构（`types.d.ts`、`styles.css`、`i18n.js`、`panel.js`）解耦逻辑
- ⚡ `perf`: 基于 `MutationObserver` 与节流机制实现轻量级 DOM 监听，避免长文本性能损耗
- 🧪 `test`: 编写 `test_e2e.mjs` 自动化端到端测试链路，覆盖模块装配、CDP 连接与 DOM 校验
- 🔧 `chore`: 编写零外部依赖的 `manage.py` 管理工具，全面兼容 `uv run` 与 Python 3 原生标准库
- 📝 `docs`: 新增系统架构文档 `ARCHITECTURE.md` 与项目使用说明 `README.md`
