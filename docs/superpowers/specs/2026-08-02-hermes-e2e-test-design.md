# Hermes ↔ AgentOctopus 端到端测试 + 沙箱联网修复 — 设计（v2）

日期：2026-08-02（v2 全面修订，吸收 code review 5 项阻塞问题 + 实测发现的沙箱联网根因）
状态：已确认方向，待写实现计划

> v2 说明：v1 只覆盖"测试 skill + 调试端点"。一轮 code review 指出 5 个阻塞问题（鉴权缺失、记录关联不可靠、沙箱遥测范围被低估、score/confidence 混淆、默认用例不可运行），随后的**真实沙箱实测**进一步发现：当前任何真实 skill 都无法在沙箱联网（架构级根因）。本版把范围扩大为一个多阶段工程，先修通沙箱联网，再建 E2E。

## 目标

让用户能对 Claude Code 说"运行这个测试"，端到端验证其所期望的完整链路：

1. 接入 Hermes（真实的 NousResearch `hermes-agent`，本地已运行于 `/Users/sam/.local/bin/hermes`）。
2. 在 Hermes 调用中分析任务意图。
3. 路由到合适的 skill。
4. 通过分数等指标选择合适的 skill。
5. 在隔离的环境（AgentOctopus SandboxRunner 沙箱）中运行。

链路方向：

```
用户（对 Claude Code 说"运行这个测试"）
  └─ Claude Code 命中 skill 库里的 hermes-e2e-test
       └─ 执行 run.mjs（编排脚本，仅在用户机器 ~/.claude/skills/，不入库）
            ├─ [0] 前置检查（hermes CLI / gateway 存活 / 调试端点已开(admin key) / 两个 key 齐备）
            ├─ [1] 生成关联键 oct-e2e-<uuid>，嵌入 query 文本
            │        hermes -z "<查询…[trace: oct-e2e-<uuid>]；指令：调用 agentoctopus 并逐字传 query>"
            │        └─ Hermes agent 把 AgentOctopus 当 tool 调用（AGENTOCTOPUS_E2E_ASK_KEY，free）
            │             └─ POST http://localhost:3002/agent/ask {query: "…[trace: oct-e2e-<uuid>]"}
            │                  └─ gateway 从 query 提取关联键→剥除 [trace:...]→ExecutionContext.traceId
            │                       └─ AgentOctopus: 意图分析→路由→评分→SandboxRunner 沙箱执行（联网）
            ├─ [2] GET /agent/debug/last-run?runId=oct-e2e-<uuid>（AGENTOCTOPUS_E2E_ADMIN_KEY，admin）
            └─ [3] 对 5 个阶段逐一断言，输出 PASS/FAIL
```

## 关键事实（全部经实测/读码核实）

- Hermes 非交互调用：`hermes -z "<prompt>"`（one-shot，最终响应打 stdout，工具/记忆启用）。等价 `hermes chat -q "<q>" -Q`。
- 接线：`docs/integrations/hermes.md`，AgentOctopus 配置为 Hermes 的一个 HTTP tool，endpoint 指 `/agent/ask`。
- 鉴权：`auth.enabled` 默认 `true`（`config-types.ts:54`），公开路径仅 `/health`、`/register`（`auth-middleware.ts:198`），其余（含 `/agent/ask`、新调试端点）一律要 API key，未带 key 返回 **401**。
- 沙箱是 **fail-closed**：`resolvePolicy` 只放行 `requested ∩ granted`（`policy.ts:71-98`）；egress `policy-engine.ts:161-163` 对无 grant 的 host 返回 `{allow:false,'host not granted'}` → 403。
- 沙箱导流：docker backend 只注入 `HTTP_PROXY`/`HTTPS_PROXY`/`SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`（`docker-backend.ts:50-54`），**无任何让 Node fetch 走代理的机制**（全仓库无 `NODE_OPTIONS`/dispatcher/global-agent 注入）。
- runtime 镜像是 **distroless**（`images/runtime/Dockerfile`）：仅 COPY node 二进制 + `USER 65532` + 无 ENTRYPOINT/CMD；**无 shell、无 curl**（实测 `sh`/`which` 不可 exec），唯一 HTTP 客户端是 Node `fetch`。
- **联网根因（实测）**：distroless guest 内 Node `fetch`（undici）不读 `HTTP(S)_PROXY` → 直连 → guest internal 网络 DNS 被断 → `getaddrinfo EAI_AGAIN`。授权只解决 egress proxy 的 403，解决不了 guest 内部 DNS。空 grant 与已授权 grant 下结果**都是** `EAI_AGAIN`（对照实验确认）。
- **修复机制（实测可行）**：bootstrap 引导脚本经 `NODE_OPTIONS=--require` 注入，先触发一次 fetch 让 Node 填充 dispatcher，再用 **vendored undici** 的 `ProxyAgent(HTTPS_PROXY)` 直接赋值 `globalThis[Symbol.for('undici.globalDispatcher.1')]`（vendored 的 `setGlobalDispatcher` 不影响内置 fetch，必须直接赋值共享 Symbol）。实测：内置 fetch 透明走代理（`ECONNREFUSED <proxy>` 而非 `EAI_AGAIN`）。skill invoke.js 零改动。
  - 注意：`node:undici` 在 Node v22 非内置模块；`process.getBuiltinModule('undici')` 在 v22 返回 undefined；vendored undici 6.24.1 无运行时依赖（1.5M），可独立 vendor。
- 执行前置缺口（实测）：默认配置下任何 skill 都无法沙箱执行——`~/.agentoctopus/skills/weather` 无 `installationId`；`sandbox.runtimeProfiles` 默认 `{}` → `resolveRuntimeProfile` 抛 `no trusted runtime profiles configured`；`sandbox.docker.image`/`proxy.artifact` 默认未配。
- 沙箱遥测现状：`SandboxResultMeta = {isolationLevel, backend, degraded, degradationReasons}`（`types.ts:58`）**无 digest**；`bind()` 返回的 backend/meta 在 subprocess/http adapter 转 `AdapterResult` 时被丢弃（`subprocess-adapter.ts:122-139`）；`ExecutionResult`（`executor.ts:91`）无沙箱元数据。
- 路由语义：`RoutingResult = {skill, score(raw), confidence(0-1 normalized), reason}`（`router.ts:14-19`）；gateway 把 `routing.score` 放进名为 `confidence` 的响应字段（`agent-protocol.ts`）；LLM reranker 可有意选非 raw-score 最高的候选。

## 五个验证阶段 ↔ 证据来源（遥测语义见 Phase 3）

| 步骤 | 验证点 | 证据来源 |
|---|---|---|
| 1. 接入 Hermes | Hermes 成功调用 AgentOctopus tool | `debug/last-run?runId` 命中本次 runId 的记录 + Hermes 输出非空 |
| 2. 分析任务意图 | Router 做了非平凡路由 | `routing.intent` 非空 + `candidatesConsidered > 0` |
| 3. 路由到合适 skill | 选中 skill == 预期 | `skill` 字段 |
| 4. 按分数选择 | 见下方"评分遥测语义" | `selectedRawScore` / `normalizedConfidence` / `selectionMethod` / `selectedCandidateRank` |
| 5. 隔离环境执行 | 走了 **Docker** 沙箱 backend（full 隔离，非 host fallback），且**真实联网成功** | `sandbox.backend === 'docker'` + `sandbox.isolationLevel === 'full'` + 下层 skill 实际返回了外网数据 |

## 评分遥测语义（修复 review #4）

调试端点必须区分并分别暴露：

- `selectedRawScore` — Router 算出的 raw score（含 cosine×routingScore−penalty）。
- `normalizedConfidence` — 0-1 归一化置信度。
- `candidates[]` — 进入重排的候选（name + rawScore）。
- `selectionMethod` — `reranker | score-fallback`。
- `selectedCandidateRank` — 选中项在 raw-score 排序中的名次。

断言逻辑：当 `selectionMethod = score-fallback` 时，要求 `selectedCandidateRank === 0`（分数最高者被选中）且 `normalizedConfidence >= 阈值(默认0.5)`；当 `= reranker` 时，要求选中项 ∈ candidates 且 LLM 明确选择（允许非 rank 0）。**不再用单一 `confidence>=0.5` 冒充"按分数选择"。**

## 阶段划分（多阶段工程）

### Phase 0 — 沙箱可执行前置（让 skill 能在沙箱跑起来）

目标：消除"默认配置下任何 skill 都无法沙箱执行"的缺口。

- 提供一份**有效的本地 sandbox 配置**（写入 `~/.agentoctopus/octopus.json` 或由 CLI/onboard 生成）：
  - `sandbox.runtimeProfiles.node`：`{bins:[node], path, dockerImage:<pinned skill-runtime digest>}`。**注意**：默认 E2E 用例 weather 实际用 Node `fetch`，其 `requires.bins` 必须由 `[curl]` 修正为 `[node]`（见 Phase 2），否则 `resolveRuntimeProfile` 因 profile `[node]` 覆盖不了请求 `[curl]` 而在联网前就失败。
  - `sandbox.docker.image` = pinned runtime digest；`sandbox.proxy.artifact` = pinned proxy digest。
  - `defaultBackend:'docker'`、`minIsolationLevel:'full'`（本期仅 Docker，见 Phase 1）。
- 确保目标 skill 有 `installationId`：通过正式 install 路径（`ensureInstallationId` 只能由 install 调用，execution 永不生成）。
- 产出：`octopus doctor`（或新子命令）能报告"沙箱可执行就绪 / 缺哪一项"。

### Phase 1 — Docker 沙箱联网修复（方案 1，一步到位，固化进镜像）

目标：让 distroless guest 内的 Node `fetch` 透明走 egress proxy，skill 零改动，fail-closed 不破。

> **范围限定：本期仅修 Docker backend。** OS / VM backend 仍只注入代理环境变量、无 bootstrap，Node `fetch` 联网问题在那些 backend 上依旧存在——列入"明确不做"。因此 Phase 5 的隔离断言收紧为 `backend === 'docker' && isolationLevel === 'full'`。

- **A. 镜像构建**（`packages/sandbox/images/runtime/`）：
  - runtime Dockerfile 增加：把 `bootstrap.cjs` + vendored `undici/` COPY 进只读路径 `/opt/octopus-boot/`。**属主/权限必须与 backend 实际运行 uid 一致**：docker backend 强制 `--user 65534:65534`（`docker-backend.ts`），与镜像 `USER 65532` 不一致——本期统一以 **65534** 为准（修正镜像或使 boot 路径对 65534 只读可读、不可写）。
  - `scripts/build-security-images.mjs`：vendor undici（pinned 版本 + SHA-256 完整性校验）、把 bootstrap 打进 staging context。
  - `images.lock.json`：undici 版本/哈希入锁，可审计。
- **B. Docker backend**（`docker-backend.ts`）：
  - guest 启动注入 trusted env `NODE_OPTIONS=--require /opt/octopus-boot/bootstrap.cjs`（排在 `spec.env` 之后，Docker last-wins，skill 无法覆盖）。
- **C. bootstrap.cjs 内容**（按实测机制）：
  - 读 `HTTPS_PROXY||HTTP_PROXY`；空则跳过（保持无代理环境行为不变）。
  - 触发一次 fetch 初始化；require vendored undici 的 `ProxyAgent`；赋值 `globalThis[Symbol.for('undici.globalDispatcher.1')]`。
  - 失败要 fail-loud 到 stderr 但不 crash skill。**兜底边界要写准**：bootstrap 失效时，请求通常**到不了 proxy**（guest 在 Docker internal 隔离网络里直连被断 → `EAI_AGAIN`）；安全仍 fail-closed（不会漏出直连外网），只是表现从"egress 403"退化为"DNS 失败"。
- **D. 安全契约测试**（`image-contract.test.ts` + 新增）：
  - 更新：允许 `/opt/octopus-boot/` 存在；仍禁止 shell/curl/wget/npm/npx/compiler。
  - 新增契约断言：bootstrap 在只读路径、root 拥有、**uid 65534**（backend 实际运行 uid）不可写；`NODE_OPTIONS` 指向它；vendored undici 哈希匹配锁；镜像与 backend 的 uid 不一致已修正。
  - 新增联网行为测试：guest fetch 一个**已 grant** 的 host 走通（经 proxy）；**未 grant** 的 host 在 egress 层被拒（403 `host not granted`，请求确实到了 proxy）；并断言 guest **不再**出现 `EAI_AGAIN`（`EAI_AGAIN` 只代表 bootstrap 未生效的回归），证明 fail-closed 不破且导流机制有效。
- **安全边界**：bootstrap + undici 只能在镜像只读层（root 拥有），skill 不可篡改；"放行谁"仍由 egress proxy 的 host grant 把关，bootstrap 只解决"走代理"。不得引入任何允许 skill 绕过 host grant 的通道。

### Phase 2 — 配套 skill 修复（让默认用例真实可用）

- weather/ip-lookup SKILL.md 声明 `sandbox.hosts: [wttr.in]` / `[ip-api.com]`（或在正文写完整 URL，使 `requestedHosts()` 能提取）。
- **修正 `requires.bins`**：weather/ip-lookup 的 `requires.bins` 由 `[curl]` 改为 `[node]`——它们的 invoke.js 实际用 Node `fetch`，distroless runtime 镜像也无 curl。让 `sandbox.bins` 与实际程序一致，否则 `resolveRuntimeProfile`（P0 配的 `[node]` profile）覆盖不了 `[curl]` 请求而执行失败。
- 本地配置为它们添加 `sandbox.grants`（installationId+digest → hosts）。
- 选 **weather** 作为默认 E2E 用例（wttr.in，HTTPS，免费，限流相对宽松）。
- 公网可用性/限流风险：E2E 标记为"冒烟/手动"，断言失败时区分"沙箱拒绝"与"上游不可用"。

### Phase 3 — 调试端点 + 沙箱/路由遥测透传（修复 review #1/#2/#3/#4）

- **鉴权（#1）——两 key 分离，一次性 setup**：
  - 建**两个专用测试 key**，角色分离：
    - `AGENTOCTOPUS_E2E_ASK_KEY` — **free tier**，只给 Hermes 调 `POST /agent/ask`。注入到 Hermes 的 agentoctopus tool 配置（`Authorization: Bearer <key>`）。
      - **Hermes 配置示例（header 语法）**：当前仓库 `docs/integrations/hermes.md` 只有 endpoint、没写 header，需补上准确写法。Hermes 在 `~/.hermes/config.yaml` 的 `mcp_servers`（或对应 tool/skill 节）下用 `headers` 传字面 header、`env` 从 `~/.hermes/.env` 转发变量：
        ```yaml
        mcp_servers:
          agentoctopus:
            endpoint: "http://localhost:3002/agent/ask"
            headers:
              Authorization: "Bearer ${AGENTOCTOPUS_E2E_ASK_KEY}"
            env:
              AGENTOCTOPUS_E2E_ASK_KEY: "${env:AGENTOCTOPUS_E2E_ASK_KEY}"
        ```
        （确切节名以 Hermes 实际配置结构为准——`mcp_servers` vs skill 配置；实现时按本地 `~/.hermes/config.yaml` 现状对齐。）
    - `AGENTOCTOPUS_E2E_ADMIN_KEY` — **admin tier**，只给 run.mjs 查遥测（`/agent/debug/last-run`）。**绝不交给 Hermes**，只存在 run.mjs 读的本地 env。
  - 一次性 setup：用已有 admin key 调 `POST /agent/keys/create`（`/keys/create` 默认 tier `free`，admin 需显式 `tier:'admin'`）各建一个，写入两个 env。**不每次新建**——key 持久存在于 `auth.apiKeysPath`，测试只读 env。
  - 职责边界：Hermes 侧的 key **不能**是 admin（它只需发 query）；遥测查询的 key **必须**是 admin（debug 端点 admin-only）。两者分开是为了让 Hermes 永远拿不到能读遥测的凭证。
  - 文档明确状态码语义：**401**=未带/无效 key（提示配 key）、**403**=key 有效但 tier 不足（如用 ASK_KEY 访问 admin-only 的 debug 端点）、**404**=端点未启用（`debugEndpoints.enabled:false`）、**429**=限流。
- **调试端点（#2）**：
  - 命名 `GET /agent/debug/last-run?runId=<id>`：`last-run` 表示"返回匹配该 runId 的最近一次执行记录"（同一 runId 多次沙箱 run 时聚合为一条含 `runs[]` 的记录）；省略 `runId` 时返回全局最近一条（**仅 admin**，且默认不含 query 原文）。
  - **admin-only**（仅 admin tier key 可访问）。
  - **配置形状（统一为对象，不再混用布尔）**：`gateway.debugEndpoints` 是一个对象，不是布尔：
    ```json
    { "gateway": { "debugEndpoints": { "enabled": false, "includeQuery": false, "bufferSize": 10 } } }
    ```
    默认 `enabled:false` 关闭；`includeQuery` 控制是否返回 query 原文；`bufferSize` 是环形缓冲容量。
  - **响应语义（区分三种状态）**：
    - **端点关闭**（`enabled:false`）→ **404**（端点不存在）。
    - **端点开启但缓冲为空 / 无匹配 runId** → **200** `{success:true, run:null}`（**不是** 404）。这样 run.mjs 前置检查能区分"端点没开（404，要去开 config）"和"端点开了但还没有执行记录（200 run:null，正常，继续跑）"。
    - **命中** → **200** `{success:true, run:{...}}`。
  - 执行记录带 `runId`；按 runId 精确查询，避免并发混淆与跨调用者读取。
  - **runId 产生与关联机制（替代 `metadata:{runId}`）**：Hermes 的 tool 调用是模型驱动的，无法可靠携带任意 metadata，所以 runId **不能**靠 `/ask` 请求体里的 `metadata.runId` 传。改为关联键方案：
    1. run.mjs 生成一个**不可猜测的关联键** `oct-e2e-<uuid>`（非 runId 本身，仅作本次执行的关联标识）。
    2. run.mjs 把关联键**嵌入发给 Hermes 的 prompt/query 文本**（如 `"...查东京天气 [trace: oct-e2e-9f3a...]"`），并在 Hermes prompt 里**显式指令**：调用 agentoctopus tool，且把 query **逐字**（含 `[trace: ...]`）传给该 tool。这是 primary 关联路径——**它依赖 Hermes 模型逐字保留 trace，这一点必须承认**（见下"备用关联"）。
    3. **gateway 在 `/ask` handler 里、路由之前**，用正则从原始 query 提取 `oct-e2e-<uuid>` 模式，得到关联键（trusted side 提取）。
    4. **gateway 提取后，把 `[trace: ...]` 片段从 query 中剥除**，再送给 Router / skill——避免 trace 串污染意图提取（intent extraction）与评分。剥除是 gateway 侧的纯字符串操作，剥除失败不影响主流程（剥不掉就带着 trace 继续，仅可能轻微影响路由质量，不影响安全）。
    5. gateway 把关联键作为 **显式 `ExecutionContext.traceId`** 传给 `router.route()` / `executor.execute()` / `SandboxRunner` 的 telemetry sink；路由遥测、沙箱遥测、composed/MCP 的子执行都带这个 traceId 写入环形缓冲。
    6. run.mjs 用同一关联键查 `GET /agent/debug/last-run?runId=oct-e2e-<uuid>`，拿回这次执行聚合的记录。
    - query 内嵌的键对 Hermes/LLM 可见但**不是凭证**（真正的鉴权仍是 `AGENTOCTOPUS_E2E_ASK_KEY`）。
    - **备用关联（trace 被模型删掉/改写时区分失败模式）**：telemetry 记录除 `traceId` 外，还记录**调用者身份（ASK key 的 apiKey id）+ 请求开始时间（receivedAt）**。于是 run.mjs 查询 `?runId=<键>` 超时时，能进一步用"该 ASK key 在最近窗口内是否有执行记录"区分两种失败：
      - **窗口内无任何该 key 的记录** → Hermes 根本没调 tool（接线问题）。
      - **窗口内有该 key 的记录但无匹配 traceId** → tool 被调了，但 trace 被模型删掉/改写（prompt 指令不够强，或模型行为）。
      这把"trace 依赖模型保留"这一不可靠点变成**可诊断**，而不是默默超时。
    - `ExecutionContext` 是新增的内部传递对象（见"改动范围"），只承载 traceId 等遥测元数据，**不改变** `AdapterResult`/`ExecutionResult` 既有形状。
  - 记录**绑定调用者身份**（apiKey id）+ **请求开始时间**（receivedAt，供备用关联用）；**默认不保存/不返回 query 原文**（只返回 query 的哈希或长度 + 结构化遥测），需要时显式开 `gateway.debugEndpoints.includeQuery:true`。
  - 环形缓冲，容量由 `gateway.debugEndpoints.bufferSize` 决定（默认 10），按 runId 索引。
- **沙箱遥测透传（#3）**：
  - 采用**独立 execution-telemetry 回调**（而非改 `AdapterResult`/`ExecutionResult` 的既有形状，避免破坏 adapter 契约）：`SandboxRunner.bind().run()` 已有 `meta:{backend,isolationLevel,degraded,degradationReasons}`，runner 在执行完成时回调 engine 注册的 telemetry sink，gateway 写入环形缓冲。telemetry sink 接收的上下文里带 `ExecutionContext.traceId`（上面的关联键），记录按 traceId 索引。
  - **同时 instrument 一次性 `run()` 与持久 `spawn()` 两条路径**（review #P4——只挂 `run()` 会漏掉 MCP）：
    - **`run()` 完成路径**：执行返回时回调，带 `meta` + `traceId`。
    - **`spawn()` 创建路径**：`backend.spawn()` 成功后回调一条"session created"（带 `traceId`、backend、isolationLevel 初值）。
    - **`spawn()` 的 `close()`/`resultMeta` 完成路径**：MCP 经 `spawn()` 建持久会话，**最终 meta 只有在 `session.close()` 解析 `resultMeta` 后才确定**（`sandbox-runner.ts` 的 `doClose` 里 await `proc.exited` 拿 exitMeta，再叠加 cleanup 结果）。telemetry 在 `close()` 完成、`resultMeta` 解析后回调**最终 meta**。
    - **cleanup 降级后的最终 isolation metadata**：`doClose` 里 backend.cleanup() 抛 `ContainmentCleanupError` 会把 `isolationLevel` 降到 `'none'` 并 `degraded:true`。telemetry 记录的必须是这条**降级后**的 `finalMeta`，而不是 spawn 时的初值——否则会把一次 containment 破坏误报成 full isolation。
  - **执行结果字段（review #P2 阶段5——光有 meta 只能证明"起过 Docker"，不能证明"联网 skill 成功")**：现有 `/ask` 即便 `adapterResult.success===false` 外层仍返回 `success:true`（`agent-protocol.ts:252`），所以 telemetry 必须额外带**安全的执行结果**：
    - `sandboxRun.success`（bool）、`adapterSuccess`（bool，下层 adapter 真实成败）、`exitCode`（number|null）、`errorCode`（string|null，如 `EAI_AGAIN`/egress 403）。
    - 这些是结构化字段，**不含 query 原文、不含 skill 输出原文**（输出原文仍受 `includeQuery`/隐私边界约束）。阶段5 的"下层 skill 实际返回外网数据"用 `adapterSuccess:true` + `exitCode:0` 判定。
  - **digest 语义**：调试记录里的 `sandbox.digest` 指 **skill snapshot digest**（`identity.digest`，`sha256:<64hex>`，runner 在 prepare 前 verify 的那个），**不是** runtime image digest。文档写明。
  - 多次沙箱运行（MCP/composed）：每次 run/spawn 产生 telemetry 记录，都带同一 `traceId`，按 traceId 聚合为一条含 `runs[]` 的记录；composed skill 记录 composer 轨迹。
- **路由遥测（#4）**：按上文"评分遥测语义"暴露 `selectedRawScore`/`normalizedConfidence`/`candidates[]`/`selectionMethod`/`selectedCandidateRank`。另外补齐阶段2 所需的**意图遥测**（review #P2——光评分字段不够）：
  - **`intent`**：Router 实际用来 embed 的意图短语（`embedQuery`）。
  - **`intentSource`**：`llm` | `original-query-fallback`。Router 的 intent 提取有回退路径——非 Latin 走翻译+intent 合并调用（JSON 解析失败/LLM 调用失败都回退原 query），Latin 只在 trim 后短于原 query 时才用提取结果、否则也回退原 query（`router.ts:204-243`）。必须记录走的是哪条。
  - **`intentExtractionSucceeded`**（bool）：是否真正用上了 LLM 提取的 intent（区别于回退原 query）。
  - **`candidatesConsidered` 口径**：送入 LLM reranker 的候选数（cosine topK + keyword-boosted 名称匹配 + previousSkill 去重注入之后的 `candidates.length`，`router.ts:334-363`），**不是**索引总数、也不是 eligibility 过滤前的数量。文档写明。
  - 阶段2 的"Router 做了非平凡路由"用 `intent` 非空 + `intentSource`/`intentExtractionSucceeded` + `candidatesConsidered > 0` 判定。

### Phase 4 — Claude Code 测试 Skill（run.mjs，不入库）

位置 `~/.claude/skills/hermes-e2e-test/`（方案 B：run.mjs/SKILL.md 只在用户机器，不进仓库，仓库不写它的单测）。

- **SKILL.md**：name `hermes-e2e-test`；用户说"运行这个测试"时执行 `node run.mjs`，把 PASS/FAIL 读给用户，失败按排查提示引导。
- **run.mjs 逻辑**：
  1. 前置检查（任一失败给修复提示、非零退出）：`hermes --version`；`GET /agent/health`；`GET /agent/debug/last-run`（用 `AGENTOCTOPUS_E2E_ADMIN_KEY`）——**404**=端点没开（提示去开 `debugEndpoints.enabled`），**401/403**=key 问题，**200 `{run:null}`**=端点已开但缓冲为空（**正常**，继续）；两个测试 key 都存在于 env；Hermes tool 已指向 `/agent/ask` 且带 `AGENTOCTOPUS_E2E_ASK_KEY`。
  2. 生成不可猜测的**关联键** `oct-e2e-<uuid>`（crypto random），把它**嵌入 query 文本**，并在 Hermes prompt 里**显式指令逐字传递**（默认 `"What's the weather in Tokyo? [trace: oct-e2e-<uuid>]\n\nCall the agentoctopus tool and pass the query above VERBATIM, including the [trace: ...] token."`，`--query`/`--expect-skill` 可覆盖），`hermes -z "<含关联键与指令的 query>"`。带 `--timeout`（默认 90s）。**不在 request metadata 注入**——Hermes 的 tool 调用模型驱动，metadata 不可靠；关联键走 query 文本，由 gateway 端正则提取。
  3. 轮询 `GET /agent/debug/last-run?runId=oct-e2e-<uuid>`（用 `AGENTOCTOPUS_E2E_ADMIN_KEY`）直到 `run` 非空或超时。
  4. 按 5 阶段断言（评分断言按 Phase 3 语义）。
  5. 输出 5 行 PASS/FAIL + 总 verdict；`--json` 机器可读。
- **CLI 参数**：`--query`、`--expect-skill`、`--threshold`、`--timeout`、`--json`。

## 错误处理（run.mjs，每条给可操作提示）

| 失败场景 | 检测 | 提示 |
|---|---|---|
| Hermes 不在 PATH | `hermes --version` 非零 | 安装/登录 Hermes，确认 `~/.local/bin` 在 PATH |
| gateway 没起 | `/agent/health` 连接拒绝 | 先 `octopus start`（:3002） |
| 未带/无效 key | 401 | 设 `AGENTOCTOPUS_E2E_ASK_KEY`（Hermes tool 注入 Bearer）/ `AGENTOCTOPUS_E2E_ADMIN_KEY`（run.mjs 读） |
| key tier 不足 | 403 | 调试端点需 admin tier——确认 run.mjs 用的是 `AGENTOCTOPUS_E2E_ADMIN_KEY` 而非 ASK_KEY |
| 调试端点没开 | 404 | `octopus.json` 设 `gateway.debugEndpoints.enabled:true` 并重启 |
| 缓冲为空（非错误） | 200 `{run:null}` | 端点已开、还没执行记录——正常，继续跑，不要去改 config |
| 限流 | 429 | 降低频率或提 tier |
| Hermes 没接线（备用关联判定） | `?runId` 超时 且 最近窗口内该 ASK key **无任何**执行记录 | Hermes 没调 tool——按 `docs/integrations/hermes.md` 把 tool 指到 `/agent/ask` |
| trace 被模型丢掉（备用关联判定） | `?runId` 超时 但 最近窗口内该 ASK key **有**执行记录（无匹配 traceId） | tool 被调了但 `[trace:...]` 没逐字传到——加强 prompt 逐字指令后重试 |
| 调用超时 | 超 `--timeout` | 区分模型慢 vs 接线断，先手动 `hermes -z` |
| 路由选错 | `skill !== expected` | 显示实际命中 + candidates |
| host fallback | `isolationLevel` 缺/none | 查 `sandbox.defaultBackend`/`minIsolationLevel`（fail-closed 下不应出现） |
| 联网被拒（修复后） | 下层 skill 返回 egress 403 `host not granted` | 查该 skill 的 `sandbox.hosts` 声明与 `sandbox.grants` |
| 联网机制回归（修复失效） | 下层 skill 返回 `EAI_AGAIN`（guest DNS 被断，说明 bootstrap 没生效） | 查镜像是否含 bootstrap、`NODE_OPTIONS` 是否注入、契约测试是否过 |
| 上游不可用 | 下层 skill 返回 5xx/超时 | 公网限流/不可用，重试或换查询 |

## 测试策略

- **Phase 1（联网修复）**：`image-contract.test.ts` 更新 + 新增联网行为测试（grant 走通 / 未 grant 拒绝）；纳入既有 sandbox 安全套件（docker lane）。
- **Phase 3（端点+遥测）**：现有 vitest 覆盖——admin-only 鉴权、默认关闭、runId 精确查询、不默认返回 query 原文、沙箱/路由遥测字段正确、多次 run 按 runId 聚合。
- **真实 E2E（冒烟/手动）**：`node ~/.claude/skills/hermes-e2e-test/run.mjs`，依赖本地已配好的 Hermes + gateway + 联网修复，**不进仓库 CI**（run.mjs 本体不入库，断言正确性由冒烟保证）。`TEST_INSTRUCTIONS.md` 加说明。
- 次要问题（review #P2-2 自相矛盾）已解：**E2E 与 run.mjs 均不进仓库 CI**；`--json` 仅供用户在其自有环境/外部 CI 使用，个人 skill 的版本由用户自行维护。

## 文档与变更范围

- `docs/integrations/hermes.md`：加"端到端验证"（用测试 skill + 开 debugEndpoints + 配测试 key）。
- `docs/core-concepts/sandbox.md`：记录联网导流机制（HTTP(S)_PROXY + bootstrap）与 skill 联网前提（hosts 声明 + grant）。
- `docs/api-reference/agent-protocol.md`：记录 `/agent/debug/last-run`（admin-only、runId、遥测字段）+ `/ask` 的关联键提取行为（从 query 提取 `oct-e2e-<uuid>` 模式作为 traceId）。
- `CLAUDE.md`：更新 gateway/agent-protocol（debugEndpoints 对象配置、调试端点、关联键提取+trace 剥除）、core（`ExecutionContext.traceId` 传递）、sandbox（bootstrap 联网机制）、镜像构建（vendored undici）。
- `TEST_INSTRUCTIONS.md`：加测试行。
- **代码改动范围**：
  - `packages/gateway`：`agent-protocol.ts` `/ask` handler 在路由前从 query 提取 `oct-e2e-<uuid>` 关联键、**剥除 `[trace:...]` 后再送 Router**；telemetry 记录带 apiKey id + receivedAt（备用关联）；新增 `/agent/debug/last-run` admin-only 端点 + 环形缓冲 + `gateway.debugEndpoints` **对象配置**（`enabled`/`includeQuery`/`bufferSize`）；端点关闭→404、开启但无匹配→200 `{run:null}`；telemetry sink 注册。另补 `docs/integrations/hermes.md` 的 Authorization header 配置示例。
  - `packages/core`：新增内部 `ExecutionContext`（承载 `traceId` 等遥测元数据），在 `router.route()` / `executor.execute()` / `SandboxRunner` 间显式传递；`SandboxRunner` 在 **`run()` 完成 + `spawn()` 创建 + `spawn().close()/resultMeta` 完成** 三处回调 telemetry sink（带**降级后** `finalMeta` + `traceId` + 执行结果字段 `sandboxRun.success`/`adapterSuccess`/`exitCode`/`errorCode`）。**不改** `AdapterResult`/`ExecutionResult` 既有形状。
  - `packages/sandbox` + `images/runtime`：bootstrap 联网导流（P1）、uid 65534 统一、契约测试。
  - `apps/cli/skills/weather` + `ip-lookup`：`requires.bins` `[curl]`→`[node]` + `sandbox.hosts` 声明（P2）。
- changeset：`feat(sandbox)`（联网修复）、`feat(gateway)`（调试端点+遥测+关联键提取+对象配置）、`feat(core)`（ExecutionContext + 遥测透传 run/spawn/close）按实际触及包分别入。

## 风险与开放点

- **镜像 TCB 扩大**：vendored undici 进 runtime 镜像，需 pinned + 哈希入锁 + 契约测试守护；后续 undici 升级要走同一审计路径。
- **undici 内部 Symbol 依赖**：`Symbol.for('undici.globalDispatcher.1')` 是 undici 内部约定，Node 大版本升级可能变；契约测试需在目标 Node 版本上断言该机制有效（v22 已实测）。
- ** Hermes 自主决策随机性（review #P2-1）**：Hermes 是否调 AgentOctopus 由模型自主决定，单次有随机性。缓解：E2E 的 prompt 明确要求使用 agentoctopus tool（链路冒烟目标）；若要把"自主工具选择"也作为受测行为，需多次采样而非单次断言——本期不做（YAGNI）。
- **trace 依赖模型逐字保留（review #P1）**：关联键经 query 文本传递，若 Hermes 模型删掉/改写 `[trace:...]`，gateway 就提取不到。缓解：① Hermes prompt 显式指令逐字传递；② gateway 提取后剥除 trace 再送 Router（不污染意图/评分）；③ 备用关联（ASK key 身份 + receivedAt）让 run.mjs 能区分"没调 tool"vs"调了但 trace 丢了"，把不可靠点变成可诊断而非默默超时。

## 明确不做（YAGNI）

- 不把测试 skill 放进 AgentOctopus 沙箱执行（它是 Claude Code 侧编排者）。
- 不做多查询/参数化大批量测试。
- 不改沙箱 fail-closed 安全语义、路由评分算法。
- run.mjs 不入库、不写仓库内单测。
- 不做 Hermes 自主工具选择的统计采样测试。
- 不引入第三方 npm 依赖到 run.mjs。
