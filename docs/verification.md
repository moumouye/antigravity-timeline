# ④ 自动化验收门禁 (Verification Gate)

本文档定义代码交付前的物理级硬性测试门禁与断言标准。
任何 AI 智能体在声称“任务完成”或向人类交卷前，**必须本地运行并全绿通过该测试套件**。

---

## 1. 唯一指定测试命令 (Execution Command)

```bash
python3 manage.py test
```

* 退出码必须为 `0`（全绿通过）；
* 若出现退出码 `1` 或抛出异常，**严禁向用户交付**，必须在本地自行查阅日志并完成修复。

---

## 2. 五大验收环节与硬性断言标准 (Hard Assertions)

测试脚本 [`sidecars/engine/test_e2e.mjs`](../sidecars/engine/test_e2e.mjs) 通过 CDP 直连运行中的 Antigravity 实例，自动执行以下五大阶段校验：

| 校验阶段 | 阶段任务 | 硬性断言指标 (Hard Assertions) | 判定通过标准 |
| :--- | :--- | :--- | :--- |
| **[1/5] 源码装配** | 读取并编译 `client/` 下的 CSS、i18n 与 JS | 语法无报错，生成完整的 IIFE 自执行脚本 | 脚本长度正常，无语法解析异常 |
| **[2/5] 端口与会话** | 读取 `DevToolsActivePort` 并建立 WebSocket | 成功连接至目标 Electron 页面窗口 | 建立有效 WebSocket CDP 连接 |
| **[3/5] 热注入评估** | 调用 `Runtime.evaluate` 执行脚本注入 | `evalRes.exceptionDetails` 必须为空 | 注入无运行时报错 |
| **[4/5] 悬停静止与全量对齐** | 模拟悬停手柄，展开菜单 | 1. `viewportScrollDelta === 0`<br>2. `totalTurnsInMenu === transcriptTurns.length`<br>3. `hasResidualFloatBtn === false`<br>4. `hasActiveCard === true` | **主视口位移严格为 0 像素**，菜单条目数与底层日志完全相等，无旧按钮残留 |
| **[5/5] 定向跳转与光晕脉冲** | 模拟点击未折叠卡片触发平滑定位 | 1. `cardClicked === true`<br>2. `jumpHighlightFired === true` | 成功触发平滑定位，并激活目标卡片 1.4 秒专属脉冲光晕 |

---

## 3. 常见失败排查手册 (Self-Correction Guide)

若测试运行报错，AI 智能体应参照下表进行针对性自我排查与修复：

1. **报错：`悬停导致主视口产生非预期位移 (Xpx)`**：
   * **排查点**：检查 `panel.js` 中的 `showMenu()` 或 `scanTurns()` 是否又调用了 `loadBtn.click()` 或 `expandAllHistorySilently()`。
   * **修复**：彻底删除所有悬停期的点击模拟，恢复纯读。
2. **报错：`未成功展开对话轮次列表菜单` 或 `totalTurnsInMenu === 0`**：
   * **排查点**：检查 Sidecar 到 Client 的 `__agyReceiveFullTurns` 回调是否受阻，或 `transcript.jsonl` 路径解析异常。
   * **修复**：检查 `main.mjs` 中的 `loadTranscriptTurns` 正则解析，确保正确提取了用户提问。
3. **报错：`未检测到 Antigravity 调试端口文件 (DevToolsActivePort)`**：
   * **排查点**：Antigravity 桌面客户端未启动。
   * **修复**：提示用户启动 Antigravity 客户端后重试。
