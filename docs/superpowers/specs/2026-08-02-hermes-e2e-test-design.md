# Hermes ↔ AgentOctopus 端到端测试 Skill — 设计

日期：2026-08-02
状态：已确认（brainstorm 通过，待写实现计划）

## 背景与目标

用户想要一个可重复运行的**端到端测试**，覆盖他所期望的完整链路：

1. 接入 Hermes（真实运行的 NousResearch `hermes-agent`）。
2. 在 Hermes 调用中分析任务意图。
3. 路由到合适的 skill。
4. 通过分数等指标选择合适的 skill。
5. 在隔离的环境中运行。

链路方向（已与用户确认）：

```
用户（对 Claude Code 说"运行这个测试"）
  └─ Claude Code 命中 skill 库里的 hermes-e2e-test
       └─ 执行 run.mjs（编排脚本）
            ├─ [0] 前置检查
            ├─ [1] hermes -z "<命中某 skill 的查询>"
            │        └─ Hermes agent 自主决定调它的 "agentoctopus" tool
            │             └─ POST http://localhost:3002/agent/ask {query}
            │                  └─ AgentOctopus: 意图分析→路由→评分→SandboxRunner 沙箱执行
            ├─ [2] 拉取 GET /agent/debug/last-run（新增端点）
            └─ [3] 对 5 个阶段逐一断言，输出 PASS/FAIL 报告
```

**测试 skill 本身不在 AgentOctopus 沙箱里跑**——它是 Claude Code 侧的编排者。沙箱验证（第 5 步）体现在被 Hermes 触发的下层 skill（如 `ip-lookup` / `weather`）在 AgentOctopus 的 `SandboxRunner` 沙箱后端里执行。

## 关键事实（已核实）

- 本地 Hermes：`/Users/sam/.local/bin/hermes`（NousResearch hermes-agent）。
- 非交互调用：`hermes -z "<prompt>"`（one-shot；只把最终响应打到 stdout，工具/记忆启用）。等价：`hermes chat -q "<query>" -Q`。
- Hermes↔AgentOctopus 接线：`docs/integrations/hermes.md`，把 AgentOctopus 配置为 Hermes 的一个 HTTP tool，endpoint 指到 `http://localhost:3002/agent/ask`。
- Gateway 启动：`octopus start`（默认端口 `config.gateway.port`，:3002）。
- `/agent/ask` 现有响应：`{success, response, skill, sessionId, confidence}`；`ExecutionResult` 只带 `{skill, adapterResult, formattedOutput}`，**不暴露沙箱 backend**。
- `Router.route()` 返回 `{skill, score}[]`，内部已算出 intent 与候选数但未透传。

## 五个验证阶段 ↔ 证据来源

| 用户的步骤 | 验证点 | 证据来源 |
|---|---|---|
| 1. 接入 Hermes | Hermes 成功调用了 AgentOctopus tool | `debug/last-run` 出现新执行记录 + Hermes 输出非空 |
| 2. 分析任务意图 | Router 做了非平凡路由 | `debug/last-run.routing.intent` 非空 + `candidatesConsidered > 0` |
| 3. 路由到合适的 skill | 选中 skill == 预期 skill | `debug/last-run.skill` |
| 4. 按分数选择 | confidence/routingScore 在阈值之上 | `debug/last-run.confidence` / `topScore` |
| 5. 隔离环境执行 | 走了真实沙箱 backend（非 host fallback） | `debug/last-run.sandbox.backend` 非空 + `isolationLevel ∈ {full, restricted}` |

## 组件一：AgentOctopus 侧调试端点 `/agent/debug/last-run`

**改动位置**：`packages/gateway/src/agent-protocol.ts`（挂在现有 agent router 下，复用 auth 中间件）。

**行为**：engine 维护一个只读的"最近执行记录"环形缓冲（last-N，默认 N=1，可调）。每次 `/agent/ask` 成功执行完一个 skill，把关键遥测写入。

**`GET /agent/debug/last-run` 返回**：

```json
{
  "success": true,
  "run": {
    "timestamp": 1754150400000,
    "query": "Lookup IP 8.8.8.8",
    "skill": "ip-lookup",
    "confidence": 0.87,
    "routing": {
      "intent": "geolocate an IP address",
      "candidatesConsidered": 20,
      "topScore": 0.87
    },
    "sandbox": {
      "backend": "docker",
      "isolationLevel": "full",
      "digest": "sha256:…"
    },
    "latencyMs": 1240
  }
}
```

**需要补的两个数据来源**：

1. **沙箱 backend**：让 `SandboxRunner.bind()` / `selectBackend` 的结果（backend 名 + isolationLevel + digest）能回流到 `/agent/ask` 处理器。这是 core 唯一改动点——最小侵入（执行结果或遥测回调带出 backend metadata），**不改沙箱安全语义**。
2. **路由 intent/candidates**：在 `RoutingResult` 上补几个只读字段（`intent`、`candidatesConsidered`）透传给处理器。

**安全边界**：只读；除 query 原文外不返回敏感数据（不返回 skill 内部输出、不返回 secret）；复用现有 API key 鉴权；**默认关闭**，用 `gateway.debugEndpoints: true` 开启。

## 组件二：Claude Code 测试 Skill 本体

**位置**：`~/.claude/skills/hermes-e2e-test/`（用户个人 skill 库，**不在本仓库**）

```
hermes-e2e-test/
├── SKILL.md        # Claude Code 原生 frontmatter + 指令
└── run.mjs         # 编排 + 断言脚本（Node，无第三方依赖）
```

> 注（已与用户确认，方案 B）：SKILL.md 与 run.mjs 的实体文件**只落在用户机器 `~/.claude/skills/hermes-e2e-test/`，不提交进本仓库**。因此本仓库只交付"支撑它的 gateway 端点 + core 透传 + 文档 + 端点单测"；run.mjs 本体及其单测不进仓库 CI（见"测试策略"）。

**SKILL.md**：
- frontmatter：`name: hermes-e2e-test`；`description` 说明用途。
- 正文：当用户说"运行这个测试 / run the hermes e2e test"时，执行 `node run.mjs`（可带 `--query`），把 PASS/FAIL 报告读给用户，失败时按报告里的排查提示引导。

**run.mjs 执行逻辑**：

1. **前置检查**（任一失败给明确修复提示并非零退出）：
   - `hermes` 在 PATH（`hermes --version`）
   - gateway 活：`GET /agent/health` → `{status:'ok', skills:N}`
   - 调试端点已开：`GET /agent/debug/last-run` 非 404/403；403 则提示开 `gateway.debugEndpoints`
   - Hermes tool 配置已指向 `http://localhost:3002/agent/ask`
2. **发测试查询**：默认 `"Geolocate IP 8.8.8.8"`（稳定命中 `ip-lookup`，免费无 key）。`hermes -z "<query>"`，带 `--timeout`（默认 90s）。
3. **断言**（5 阶段，逐条 PASS/FAIL + 证据）：
   - 接入：Hermes 退出码 0 且输出非空；`last-run` 出现 timestamp > 测试开始时间的新记录
   - 意图分析：`routing.intent` 非空、`candidatesConsidered > 0`
   - 路由：`skill === <预期 skill>`
   - 评分：`confidence >= 0.5`（`--threshold` 可调）
   - 沙箱：`sandbox.backend` 非空、`isolationLevel ∈ {full, restricted}`
4. **输出**：5 行 PASS/FAIL 汇总 + 总体 verdict；`--json` 输出机器可读结果（进 CI）。

**CLI 参数**：`--query`、`--expect-skill`、`--threshold`、`--timeout`、`--json`。

**YAGNI**：默认只测单查询走通全链路；不做参数化大批量。

## 错误处理（run.mjs 失败路径，每条给可操作提示）

| 失败场景 | 检测方式 | 提示 |
|---|---|---|
| Hermes 不在 PATH | `hermes --version` 非零 | 安装/登录 Hermes，确认 `~/.local/bin` 在 PATH |
| gateway 没起 | `/agent/health` 连接拒绝 | 先跑 `octopus start`（默认 :3002） |
| 调试端点没开 | `/agent/debug/last-run` 403/404 | `octopus.json` 设 `gateway.debugEndpoints:true` 并重启 |
| Hermes 没接线 | `last-run` 无新记录 | 按 `docs/integrations/hermes.md` 把 tool 指到 `/agent/ask` |
| 调用超时 | 超 `--timeout` | 区分模型慢 vs 接线断，先手动 `hermes -z` 试 |
| 路由选错 | `skill !== expected` | 显示实际命中 + top 候选 |
| host fallback | `isolationLevel` 缺 / `none` | 查 `sandbox.defaultBackend`/`minIsolationLevel` |

## 测试策略（两层）

1. **`/agent/debug/last-run` 端点**（本仓库，`packages/gateway/tests/`，vitest）：覆盖鉴权、开关默认关闭、执行后写记录、不泄露敏感字段。
2. **真实 E2E（手动/冒烟）**：`node ~/.claude/skills/hermes-e2e-test/run.mjs` 在真实环境跑通，作发布前冒烟；`TEST_INSTRUCTIONS.md` 加说明（标注：依赖用户本地已配好的 Hermes + gateway，不进仓库 CI）。

> run.mjs 本体不进仓库（见上方方案 B），故**不写 run.mjs 的仓库内单测**；其断言正确性由真实 E2E 冒烟保证。

## 文档与变更范围

- `docs/integrations/hermes.md`：加"端到端验证"一节（如何用测试 skill + 开 `gateway.debugEndpoints`）。
- `TEST_INSTRUCTIONS.md`：加测试行。
- `CLAUDE.md`：更新 gateway/agent-protocol 描述（新增 `debugEndpoints` 配置 + 端点）。
- `docs/api-reference/agent-protocol.md`：记录新端点。
- changeset：`feat(gateway)`（core 透传字段视情况并入）。

## 明确不做（YAGNI）

- 不把测试 skill 放进 AgentOctopus 沙箱执行。
- 不做多查询/参数化大批量测试。
- 不改动沙箱安全语义、路由评分算法。
- 不引入第三方 npm 依赖到 run.mjs。
