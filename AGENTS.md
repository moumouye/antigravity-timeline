# 架构治理与协同准则 (Architecture & Contribution Guide)

本文档定义系统架构指针、质量验收门禁、代码规范强绑定、语义化版本与提交决策档案标准。

---

## 1. 架构指针与质量验收门禁 (Verification Gate)

为保证系统架构一致性与代码质量，所有代码变更须遵守以下规范：

1. **架构索引指针**：修改核心通信、DOM 交互或定位逻辑前，首先查阅 [`ARCHITECTURE.md`](ARCHITECTURE.md) 的意图路由表，并按需调阅 [`docs/`](docs/) 对应真理库（[`docs/boundaries.md`](docs/boundaries.md)、[`docs/contracts.md`](docs/contracts.md)、[`docs/anti-patterns.md`](docs/anti-patterns.md)）与领域规范（[`docs/specs/VIEWPORT_ANCHORING_SPEC.md`](docs/specs/VIEWPORT_ANCHORING_SPEC.md)）；
2. **交付前机器自主门禁 (Zero-User-Testing Mandate)**：交付成果前，智能体必须在本地终端自主运行并全绿通过自动化测试（参考 [`docs/verification.md`](docs/verification.md)）：
   ```bash
   manage.py test
   # 本地环境可使用 python3 manage.py test 或 uv run manage.py test
   ```
   * 进程退出码必须严格为 `0`；
   * 严禁要求用户手动测试代码；遇错须基于 STDERR 堆栈在本地自主排查自愈；
3. **缺陷锁死铁律 (Bug-to-Test Invariant)**：凡涉及缺陷修复，同次提交必须伴随新增针对该缺陷的反向断言测试用例，并在 [`docs/anti-patterns.md`](docs/anti-patterns.md) 中沉淀技术根因，杜绝同类问题二次逃逸；
4. **单一真理维护原则**：系统架构重构或核心流程调整时，代码提交须同步覆盖更新 [`docs/`](docs/) 与 [`ARCHITECTURE.md`](ARCHITECTURE.md)，确保技术文档与代码实现严格一致，历史变更统一归入 [`CHANGELOG.md`](CHANGELOG.md)；
5. **门禁全绿后自主提交**：门禁全绿（退出码 0）后，仅 `git add` 本次变更的特定文件（严禁 `git add -A`），严格按【第 4 节决策档案规范】执行 `git commit`；严禁私自 push、amend 或绕过 hook；涉及版本号变动时须与代码同次提交。

---

## 2. 代码与领域规范强绑定映射 (Code-to-Doc Living Locks)

为杜绝文档腐化，凡改动以下源码核心逻辑，必须在同一次提交中同步覆盖写对应的领域规范文档，测试断言与文档必须保持 100% 一致性：

| 变更源码路径 | 核心业务领域 | 必须同步更新的规范文档 | 核心关注点与不变量 |
| :--- | :--- | :--- | :--- |
| `sidecars/engine/client/panel.js` | 视口锚定与定位控制器 | [`docs/specs/VIEWPORT_ANCHORING_SPEC.md`](docs/specs/VIEWPORT_ANCHORING_SPEC.md) | 主视口 0 像素位移、1800ms 平息收敛状态机 |
| `sidecars/engine/main.mjs` | 底层日志监听与 CDP 桥接 | [`docs/contracts.md`](docs/contracts.md) | 单向数据流管道、CDP IPC 契约一致性 |
| `sidecars/engine/client/` | 页面交互与提问卡片采集 | [`docs/anti-patterns.md`](docs/anti-patterns.md) | 杜绝耦合排版类名、空会话状态机重置 |
| `sidecars/engine/test_e2e.mjs` | 自动化质量工程与断言 | [`docs/verification.md`](docs/verification.md) | 六大阶段断言、四大不可违背物理不变量 |

---

## 3. 语义化版本规范 (SemVer)

版本号格式为：`X.Y.Z`（`MAJOR.MINOR.PATCH`）。

| 版本位 | 递增条件 | 示例 |
| :---: | :--- | :--- |
| **MAJOR** (X) | 存在不兼容的核心架构重构或宿主破坏性变动 | `1.0.0` → `2.0.0` |
| **MINOR** (Y) | 向下兼容的功能性新增（如新控制项、新特性） | `1.0.0` → `1.1.0` |
| **PATCH** (Z) | 向下兼容的缺陷修复（如样式溢出、选择器校准） | `1.0.0` → `1.0.1` |

版本号升级时，同步更新 `plugin.json`、`CHANGELOG.md` 并打上 Git Tag（`git tag vX.Y.Z`）。

---

## 4. 提交与决策档案规范 (Conventional Commits)

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

## 5. 变更日志维护 (CHANGELOG)

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
