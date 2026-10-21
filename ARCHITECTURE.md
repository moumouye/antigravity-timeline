# 系统总架构指南 (System Master Architecture)

本项目为 Antigravity 桌面客户端提供非侵入式的对话时间线导航与智能视口控制能力。
依托 Antigravity 原生 Sidecar 运行机制与 Chrome DevTools Protocol (CDP) 调试通道，实现右侧侧边手柄悬停展开全量对话提问列表、冷数据按需挂载平滑定位、智能视口防滚屏锁定与热重载。

---

## 四维工程真理库 (The 4 Pillars of Architecture)

为了保证项目在由不同无状态 AI 接力维护的过程中**永不翻车、永不堆积如山**，系统知识严格按照四维真理库进行解耦分治。AI 智能体在执行不同性质的任务时，应**按需查阅对应专注文档（渐进式加载）**：

```mermaid
flowchart TD
    Hub["<b>ARCHITECTURE.md (总架构地图)</b>"]

    Doc1["<b>① 边界与红线 (Boundaries)</b><br/><code>docs/boundaries.md</code><br/>技术栈边界、沙箱通信隔离、主视口 0 位移物理铁律"]
    Doc2["<b>② 契约与流向 (Contracts)</b><br/><code>docs/contracts.md</code><br/>数据管道、CDP IPC 协议、TypeScript 类型契约"]
    Doc3["<b>③ 否决与避坑档案 (Anti-Patterns)</b><br/><code>docs/anti-patterns.md</code><br/>暗知识档案：实测枪毙的 5 大废案及根因"]
    Doc4["<b>④ 自动化验收门禁 (Verification)</b><br/><code>docs/verification.md</code><br/>端到端测试用例标准、硬性断言与自修复排查手册"]

    Hub --> Doc1
    Hub --> Doc2
    Hub --> Doc3
    Hub --> Doc4
```

### 1. [① 边界与红线 (docs/boundaries.md)](docs/boundaries.md)
* **适用场景**：涉及模块重构、权限边界划分、引入新依赖或跨环境调用时必读；
* **核心内容**：主视口 0 像素位移铁律、Chromium 沙箱禁止本地文件跨域读取、后台守护宿主托管原则。

### 2. [② 契约与流向 (docs/contracts.md)](docs/contracts.md)
* **适用场景**：涉及接口变更、数据流向改造、新增通信字段或卡片排版更新时必读；
* **核心内容**：底层 `transcript.jsonl` 单一真实源管道、CDP 双向绑定方法、TypeScript 接口契约。

### 3. [③ 否决与避坑档案 (docs/anti-patterns.md)](docs/anti-patterns.md)
* **适用场景**：排查定位异常、尝试新优化算法或考虑重构方案时必读；
* **核心内容**：详细记录为什么不能依赖前端 DOM、为什么悬停绝不能模拟点击、为什么不能用固定延时轮询等 5 大被枪毙方案。

### 4. [④ 自动化验收门禁 (docs/verification.md)](docs/verification.md)
* **适用场景**：完成代码修改、准备交付给用户前必读并执行；
* **核心内容**：唯一指定验证命令 `python3 manage.py test`、五大校验阶段硬性断言与自检排查手册。
