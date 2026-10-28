# 架构治理与协同准则 (Architecture & Contribution Guide)

本文档定义系统架构指针、质量验收门禁、语义化版本与代码提交标准。

---

## 1. 架构指针与质量门禁 (Architecture Pointers & Verification Gate)

为保证系统架构一致性与代码质量，所有代码变更须遵守以下规范：

1. **架构索引指针**：修改核心通信、DOM 交互或定位逻辑前，查阅 [`ARCHITECTURE.md`](ARCHITECTURE.md) 并调阅 [`docs/`](docs/) 对应真理库（[`docs/boundaries.md`](docs/boundaries.md)、[`docs/contracts.md`](docs/contracts.md)、[`docs/anti-patterns.md`](docs/anti-patterns.md)）；
2. **自动化测试门禁**：代码提交前必须本地全绿通过端到端测试（参考 [`docs/verification.md`](docs/verification.md)）：
   ```bash
   uv run manage.py test
   # 或 python3 manage.py test
   ```
   若测试未全绿通过（如主视口产生位移、条目数量不符），严禁提交代码，须修复至完全通过；
3. **单一真理维护原则**：系统架构重构或核心流程调整时，代码提交须同步覆盖更新 [`docs/`](docs/) 与 [`ARCHITECTURE.md`](ARCHITECTURE.md)，确保技术文档与代码实现严格一致，历史变更统一归入 [`CHANGELOG.md`](CHANGELOG.md)；
4. **门禁全绿后自主提交**：门禁全绿（退出码 0）后，仅 `git add` 本次变更的特定文件（严禁 `git add -A`），严格按【第 3 节决策档案规范】执行 `git commit`；严禁私自 push、amend 或绕过 hook；涉及版本号变动时须与代码同次提交。

---

## 2. 语义化版本规范 (SemVer)

版本号格式为：`X.Y.Z`（`MAJOR.MINOR.PATCH`）。

| 版本位 | 递增条件 | 示例 |
| :---: | :--- | :--- |
| **MAJOR** (X) | 存在不兼容的核心架构重构或宿主破坏性变动 | `1.0.0` → `2.0.0` |
| **MINOR** (Y) | 向下兼容的功能性新增（如新控制项、新特性） | `1.0.0` → `1.1.0` |
| **PATCH** (Z) | 向下兼容的缺陷修复（如样式溢出、选择器校准） | `1.0.0` → `1.0.1` |

版本号升级时，同步更新 `plugin.json`、`CHANGELOG.md` 并打上 Git Tag（`git tag vX.Y.Z`）。

---

## 3. 提交与决策档案规范 (Conventional Commits)

提交信息采用**“简短结果标题 + 决策档案正文（Why > What）”**格式：

```text
<emoji> <type>(<scope>): <简要总结改动结果>

- **Why**: 解释做出该改动的背景、根本原因或业务动机。
- **How**: 简述核心实现方式。
- **Caveats**: 记录放弃的备选废案、已知边界或后续维护注意事项。
```

| Emoji | Type | 说明 |
| :---: | :--- | :--- |
| ✨ | `feat` | 新增功能特性 |
| 🐛 | `fix` | 修复缺陷或样式 Bug |
| 💄 | `style` | 界面排版、视觉规范与样式微调 |
| 📝 | `docs` | 文档更新 |
| ♻️ | `refactor` | 代码重构（不改变外部行为） |
| ⚡ | `perf` | 性能提升与响应优化 |
| 🧪 | `test` | 自动化测试用例构建与维护 |
| 🔧 | `chore` | 构建、配置或管理脚本变动 |
| 🚀 | `release` | 里程碑版本发布与打标 |

---

## 4. 变更日志维护 (CHANGELOG)

变更记录统一维护在根目录 [`CHANGELOG.md`](CHANGELOG.md) 中，采用扁平化无序列表配合 Emoji 前缀记录。

### 条目排序严格优先级
每个版本章节内的无序列表**按以下类型优先级自上而下严格归类排序，严禁不同类型交替穿插**：
1. ✨ `feat`：新增功能特性（优先排在最前）
2. 🐛 `fix`：缺陷与异常修复（紧随其后）
3. 💄 `style`：界面排版、视觉规范与样式微调
4. 🛡️ `scope` / 🌐 `i18n`：样式作用域隔离与多语言规范
5. ♻️ `refactor`：工程架构解耦与类型约束
6. ⚡ `perf`：性能提升与加载优化
7. 🧪 `test` / 🔧 `chore`：自动化测试、构建与管理脚本
8. 📝 `docs`：文档更新
