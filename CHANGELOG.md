# 变更日志 (CHANGELOG)

本项目遵循 [语义化版本规范 (SemVer)](https://semver.org/lang/zh-CN/) 与 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范。

---

## [Unreleased]

## [1.2.0] - 2026-10-21

- ✨ `feat`: 实现被 Antigravity 虚拟折叠历史消息的自动平滑展开与全量轮次捕获引擎
- 🐛 `fix`: 彻底解决因 Antigravity 自动折叠更早消息导致时间线刻度缺失与拖拽条过短的问题
- 💄 `style`: 纯粹还原图 2 与图 3 规范，剔除多余的复杂设置弹窗，仅保留右下角精致药丸胶囊与右侧双线刻度
- 💄 `style`: 优化悬停两行卡片排版，实现提问加粗单行截断与浅绿胶囊回答摘要单行截断
- ♻️ `refactor`: 彻底移除设置弹窗（`div[role="dialog"]`）的注入代码，精简前端闭包体积（减少约 40%）
- ⚡ `perf`: 在展开折叠消息时保持 `scrollTop` 阅读视口锁定，杜绝页面产生跳变抖动
- 🧪 `test`: 端到端自动化测试验证全量 7 轮真实交互刻度生成与纯净 Popover 结构
- 📝 `docs`: 更新系统架构与使用说明，明确极简无干扰的界面交互设计

---

## [1.1.0] - 2026-10-21

- ✨ `feat`: 新增对 Antigravity 官方原生设置弹窗的无缝集成
- 🐛 `fix`: 修复多轮对话仅识别 1 轮的缺陷
- 💄 `style`: 重构悬停卡片（Popover）为两行纯净极简布局
- 🌐 `i18n`: 补充中英文双语字典
- 🧪 `test`: 更新端到端自动化测试链路

---

## [1.0.0] - 2026-10-21

- ✨ `feat`: 新增右侧边缘对话时间线刻度标记，直观映射各轮交互在长文中的相对高度
- ✨ `feat`: 新增悬停提问预览卡片（Popover），支持查看提问正文、回复摘要与时间戳
- ✨ `feat`: 新增点击快速平滑定位（`scrollIntoView`）与目标卡片专属光晕脉冲动画（Glow Pulse）
- ✨ `feat`: 新增「禁止发送后自动滑到底部」智能视口锁定机制，保持用户当前阅读高度
- 💄 `style`: 设计符合 Antigravity 原生暗色/亮色风格的毛玻璃悬停卡片
- 🧪 `test`: 编写 `test_e2e.mjs` 自动化端到端测试链路
- 🔧 `chore`: 编写零外部依赖的 `manage.py` 管理工具
- 📝 `docs`: 新增系统架构文档 `ARCHITECTURE.md` 与项目使用说明 `README.md`
