# Hermes ↔ AgentOctopus 端到端测试 + 沙箱联网修复 — 设计（v3）

日期：2026-08-02（v3 接线更正，吸收 code review 第 3 轮 3 项阻塞问题）
状态：已确认方向，待写实现计划

> v3 说明：v2 假设"Hermes 直接 POST `/agent/ask` 带 Bearer header"。**实地核查本机 `~/.hermes/` 后推翻**：Hermes 的 agentoctopus 是一个 **skill**（`~/.hermes/skills/openclaw-imports/agentoctopus/SKILL.md`），SKILL.md 是知识文档，agent 读它后用终端 toolset 跑 `octopus ask` CLI 子进程——**不是** HTTP 调 `/agent/ask`，也没有给任意 REST endpoint 注入 Bearer header 的机制（`mcp_servers` 是 MCP 协议、顶层 `tools` 是内置工具开关，都接不上 `/agent/ask`）。v3 采用**路线 A（用户拍板）**：**run.mjs 直接调 gateway `/agent/ask`** 承担"受遥测的 AgentOctopus 执行"，**Hermes 用真实 CLI 路径（`octopus ask`）** 触发 agent 流程。关联键由 run.mjs 放进 `/ask` 的 query，gateway 提取是**确定性**的（不再依赖 Hermes 逐字保留，原"备用关联"机制取消）。Hermes 侧零凭证。

## 目标

让用户能对 Claude Code 说"运行这个测试"，端到端验证其所期望的完整链路：

1. 接入 Hermes（真实的 NousResearch `hermes-agent`，本地已运行于 `/Users/sam/.local/bin/hermes`）。
2. 在 Hermes 调用中分析任务意图。
3. 路由到合适的 skill。
4. 通过分数等指标选择合适的 skill。
5. 在隔离的环境（AgentOctopus SandboxRunner 沙箱）中运行。

链路方向（路线 A——两条腿共用同一 Router/Executor/SandboxRunner）：

```
用户（对 Claude Code 说"运行这个测试"）
  └─ Claude Code 命中 skill 库里的 hermes-e2e-test
       └─ 执行 run.mjs（编排脚本，仅在用户机器 ~/.claude/skills/，不入库）
            ├─ [0] 前置检查（hermes CLI / octopus CLI / gateway 存活 / 调试端点已开(admin key) / 两个 key 齐备）
            │
            ├─ [1a] Hermes 腿（验证"接入 Hermes + 触发 agent 流程"）
            │        hermes -z "<查询>"（无需关联键、无凭证）
            │        └─ Hermes 读 agentoctopus skill → 用终端跑 `octopus ask "<查询>"`
            │             └─ CLI 内: 意图分析→路由→评分→SandboxRunner 沙箱执行（与 gateway 同代码路径）
            │        → 断言: hermes 退出码 0 且 stdout 非空
            │
            ├─ [1b] 受遥测腿（验证"路由 + 评分 + 沙箱联网"，产出结构化证据）
            │        生成关联键 oct-e2e-<uuid>，嵌入 query
            │        run.mjs 直接 POST http://localhost:3002/agent/ask
            │          {query: "…[trace: oct-e2e-<uuid>]"}  —— header: Authorization Bearer AGENTOCTOPUS_E2E_ASK_KEY(free)
            │          └─ gateway 从 query 确定性提取关联键→剥除 [trace:...]→ExecutionContext.traceId
            │               └─ AgentOctopus: 意图分析→路由→评分→SandboxRunner 沙箱执行（联网）
            │
            ├─ [2] GET /agent/debug/last-run?runId=oct-e2e-<uuid>（AGENTOCTOPUS_E2E_ADMIN_KEY，admin）
            └─ [3] 对 5 个阶段逐一断言（阶段1 用 [1a]，阶段2/3/4/5 用 [1b] 遥测），输出 PASS/FAIL
```

**为什么两条腿**：阶段 1 要证明的是"接入 Hermes、由 Hermes 触发 AgentOctopus"，这只能用真实 Hermes（`hermes -z` → `octopus ask`）证明；阶段 2–5 要的是结构化遥测证据（intent/评分/沙箱 meta/执行结果），只有 gateway 的 debug 端点能提供。CLI 与 gateway **共用同一 `Router`+`Executor`+`createDefaultSandboxRunner`**（`apps/cli/src/index.ts:11,197-198`），所以 [1a] 与 [1b] 走的是同一份路由/沙箱代码，[1b] 的遥测结论对 [1a] 的底层机制同样成立。

## 关键事实（全部经实测/读码核实）

- **Hermes 接线（实地核查本机 `~/.hermes/`）**：AgentOctopus 是 Hermes 的一个 **skill**（`~/.hermes/skills/openclaw-imports/agentoctopus/SKILL.md`），**不是** HTTP tool。SKILL.md 是知识文档，写明 "All interaction is through the `octopus` CLI"；Hermes 加载它后，agent 用终端 toolset（`hermes-cli`）**跑 `octopus ask "<query>"` 子进程**。`mcp_servers`（当前 `{}`）是 MCP 协议端点、顶层 `tools` 是内置工具开关、`skills` 是全局 skill 加载配置——**没有任何"给任意 REST endpoint 声明 HTTP tool 并注入 Bearer header"的机制**。`docs/integrations/hermes.md` 里写的 `"tools":[{endpoint}]` JSON 是**过时/虚构**的，需更正。
- **CLI 与 gateway 同代码路径**：CLI `ask` 直接 `new Router(...)`+`new Executor(..., createDefaultSandboxRunner(...))`（`apps/cli/src/index.ts:11,197-198,270,319`），**不经过 HTTP gateway**。因此 Hermes 跑 `octopus ask` 时，意图分析/路由/评分/沙箱执行都会真实发生（只是没有 gateway 的遥测落点）。
- Hermes 非交互调用：`hermes -z "<prompt>"`（one-shot，最终响应打 stdout，工具/记忆启用）。等价 `hermes chat -q "<q>" -Q`。
- 鉴权：`auth.enabled` 默认 `true`（`config-types.ts:54`），公开路径仅 `/health`、`/register`（`auth-middleware.ts:198`），其余（含 `/agent/ask`、新调试端点）一律要 API key，未带 key 返回 **401**。run.mjs 直接调 `/agent/ask` 用 `AGENTOCTOPUS_E2E_ASK_KEY`。
- 沙箱是 **fail-closed**：`resolvePolicy` 只放行 `requested ∩ granted`（`policy.ts:71-98`）；egress `policy-engine.ts:161-163` 对无 grant 的 host 返回 `{allow:false,'host not granted'}` → 403。
- 沙箱导流：docker backend 只注入 `HTTP_PROXY`/`HTTPS_PROXY`/`SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`（`docker-backend.ts:50-54`），**无任何让 Node fetch 走代理的机制**（全仓库无 `NODE_OPTIONS`/dispatcher/global-agent 注入）。
- runtime 镜像是 **distroless**（`images/runtime/Dockerfile`）：仅 COPY node 二进制 + `USER 65532` + 无 ENTRYPOINT/CMD；**无 shell、无 curl**（实测 `sh`/`which` 不可 exec），唯一 HTTP 客户端是 Node `fetch`。
- **联网根因（实测）**：distroless guest 内 Node `fetch`（undici）不读 `HTTP(S)_PROXY` → 直连 → guest internal 网络 DNS 被断 → `getaddrinfo EAI_AGAIN`。授权只解决 egress proxy 的 403，解决不了 guest 内部 DNS。空 grant 与已授权 grant 下结果**都是** `EAI_AGAIN`（对照实验确认）。
- **修复机制（实测可行）**：bootstrap 引导脚本经 `NODE_OPTIONS=--require` 注入，先触发一次 fetch 让 Node 填充 dispatcher，再用 **vendored undici** 的 `ProxyAgent(HTTPS_PROXY)` 直接赋值 `globalThis[Symbol.for('undici.globalDispatcher.1')]`（vendored 的 `setGlobalDispatcher` 不影响内置 fetch，必须直接赋值共享 Symbol）。实测：内置 fetch 透明走代理（`ECONNREFUSED <proxy>` 而非 `EAI_AGAIN`）。skill invoke.js 零改动。
  - 注意：`node:undici` 在 Node v22 非内置模块；`process.getBuiltinModule('undici')` 在 v22 返回 undefined；vendored undici 6.24.1 无运行时依赖（1.5M），可独立 vendor。
- 执行前置缺口（实测）：默认配置下任何 skill 都无法沙箱执行——`~/.agentoctopus/skills/weather` 无 `installationId`；`sandbox.runtimeProfiles` 默认 `{}` → `resolveRuntimeProfile` 抛 `no trusted runtime profiles configured`；`sandbox.docker.image`/`proxy.artifact` 默认未配。
- 沙箱遥测现状：`SandboxResultMeta = {isolationLevel, backend, degraded, degradationReasons}`（`types.ts:58`）**无 digest**；`bind()` 返回的 backend/meta 在 subprocess/http adapter 转 `AdapterResult` 时被丢弃（`subprocess-adapter.ts:122-139`）；`ExecutionResult`（`executor.ts:91`）无沙箱元数据。`/ask` 即便 `adapterResult.success===false` 外层仍返回 `success:true`（`agent-protocol.ts:252`）。
- 路由语义：`RoutingResult = {skill, score(raw), confidence(0-1 normalized), reason}`（`router.ts:14-19`）；gateway 把 `routing.score` 放进名为 `confidence` 的响应字段（`agent-protocol.ts`）；LLM reranker 可有意选非 raw-score 最高的候选。

## 五个验证阶段 ↔ 证据来源（遥测语义见 Phase 3）

| 步骤 | 验证点 | 证据来源 |
|---|---|---|
| 1. 接入 Hermes | 真实 Hermes 触发了 AgentOctopus 的 agent 流程 | **Hermes 腿 [1a]**：`hermes -z` 退出码 0 + stdout 非空（skill 触发 `octopus ask` 走 CLI 路径）。此阶段**不用** debug 遥测——它证明的是"接入 Hermes"，不是遥测。 |
| 2. 分析任务意图 | Router 真正做了意图提取（**不接受** original-query-fallback） | **受遥测腿 [1b]**：`routing.intent` 非空 + `intentSource === 'llm'` + **`intentExtractionSucceeded === true`** + `candidatesConsidered > 0`。允许 fallback 通过只能证明 Router 收到非空 query，证明不了"意图分析"（review #次要-2）。 |
| 3. 路由到合适 skill | 选中 skill == 预期 | 受遥测腿 [1b]：`skill` 字段 |
| 4. 按分数选择 | 见下方"评分遥测语义" | 受遥测腿 [1b]：`selectedRawScore` / `normalizedConfidence` / `selectionMethod` / `selectedCandidateRank` |
| 5. 隔离环境执行 | 走了 **Docker** 沙箱 backend（full 隔离，非 host fallback），且**真实联网并返回了有效外网数据** | 受遥测腿 [1b]：`sandbox.backend === 'docker'` + `sandbox.isolationLevel === 'full'` + **`adapterSuccess === true`** + **`outputValidated === true`**（结果验证，见下） |

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
    - `AGENTOCTOPUS_E2E_ASK_KEY` — **free tier**，**run.mjs 自己**用来 POST `/agent/ask`（受遥测腿 [1b]），以 `Authorization: Bearer <key>` 放在**请求 header**（run.mjs 是可信本地脚本，直接控制 header）。
    - `AGENTOCTOPUS_E2E_ADMIN_KEY` — **admin tier**，只给 run.mjs 查遥测（`/agent/debug/last-run`）。**绝不离开 run.mjs**，只存在 run.mjs 读的本地 env。
  - **Hermes 侧零凭证**：Hermes 腿 [1a] 走 `octopus ask` CLI 子进程，不碰 gateway、不需要任何 key。这消解了"如何把 Bearer 注入 Hermes"的伪需求——Hermes 根本没有给任意 REST endpoint 配 HTTP header 的机制（见"关键事实"）。
  - 一次性 setup：用已有 admin key 调 `POST /agent/keys/create`（`/keys/create` 默认 tier `free`，admin 需显式 `tier:'admin'`）各建一个，写入两个 env。**不每次新建**——key 持久存在于 `auth.apiKeysPath`，测试只读 env。
  - 职责边界：调 `/ask` 的 key **不能**是 admin（它只需发 query）；遥测查询的 key **必须**是 admin（debug 端点 admin-only）。两者分开是为了让发起执行的凭证永远读不到遥测。
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
  - **runId 产生与关联机制（路线 A——确定性提取，不再依赖 Hermes）**：关联键由 **run.mjs** 放进 `/ask` 的 query，不经过 Hermes，所以 gateway 提取是**确定性**的。原"备用关联"机制（依赖 Hermes 逐字保留 trace）随路线 A **取消**——关联键不再经 Hermes 传递。
    1. run.mjs 生成关联键 `oct-e2e-<uuid>`，嵌入受遥测腿 [1b] 发给 `/ask` 的 query（如 `"What's the weather in Tokyo? [trace: oct-e2e-9f3a...]"`）。
    2. **gateway 在 `/ask` handler 里、路由之前**，用正则从原始 query 提取 `oct-e2e-<uuid>` 模式，得到关联键（run.mjs 直接控制 query 文本，提取可靠）。
    3. **gateway 提取后，把 `[trace: ...]` 片段从 query 中剥除**，再送给 Router / skill——避免 trace 串污染意图提取（intent extraction）与评分。剥除是 gateway 侧的纯字符串操作。
    4. gateway 把关联键作为 **显式 `ExecutionContext.traceId`** 传给 `router.route()` / `executor.execute()` / `SandboxRunner`；路由遥测、沙箱遥测、composed/MCP 的子执行都带这个 traceId 写入环形缓冲。
    5. run.mjs 用同一关联键查 `GET /agent/debug/last-run?runId=oct-e2e-<uuid>`，拿回这次执行聚合的记录。
    - 关联键不是凭证（真正鉴权是 header 里的 `AGENTOCTOPUS_E2E_ASK_KEY`）；即使 query 里没有可提取的键，gateway 就只记一条无 traceId 的普通执行，run.mjs 查询返回 `run:null`，**不影响安全**。
    - `ExecutionContext` 是新增的内部传递对象（见"改动范围"），只承载 traceId 等遥测元数据，**不改变** `AdapterResult`/`ExecutionResult` 既有形状。
  - 记录**绑定调用者身份**（apiKey id）+ **请求开始时间**（receivedAt）；**默认不保存/不返回 query 原文**（只返回 query 的哈希或长度 + 结构化遥测），需要时显式开 `gateway.debugEndpoints.includeQuery:true`。
  - 环形缓冲，容量由 `gateway.debugEndpoints.bufferSize` 决定（默认 10），按 runId 索引。
- **沙箱遥测透传（#3）**：
  - 采用**分层遥测事件**（review #P0——`adapterSuccess` 只有 adapter 返回后 Executor 才知道，SandboxRunner 在 adapter 下层、判断不了 adapter 是否成功解析响应）。**不把 adapter 成败塞进 SandboxRunner**。两类事件由不同层发出，gateway 按 `traceId + executionId` 聚合：
    - **`sandbox.completed`**（**SandboxRunner** 发出）：`executionId`、`traceId`、`meta:{backend,isolationLevel,degraded,degradationReasons}`、`exitCode`（number|null）、`sandboxSuccess`（bool，沙箱进程本身是否跑完——不含 adapter 语义）。
    - **`adapter.completed`**（**Executor** 发出，adapter 返回后）：`executionId`、`traceId`、`adapterSuccess`（bool，`adapterResult.success`——下层 adapter 真实成败）、`errorCode`（string|null，规范化，如 `EAI_AGAIN`/egress 403/HTTP 状态）。
    - 现有 `/ask` 即便 `adapterResult.success===false` 外层仍返回 `success:true`（`agent-protocol.ts:252`），所以阶段5 必须读 `adapter.completed` 的 `adapterSuccess`，不能只看外层响应。
    - 这些是结构化字段，**不含 query 原文、不含 skill 输出原文**（输出原文仍受 `includeQuery`/隐私边界约束）。
  - **`outputValidated`（review #P0——`adapterSuccess:true + exitCode:0` 仍证明不了"返回了有效外网数据")**：weather 可以正常退出却返回 "No weather data"。增加**不泄露原文的结果验证**：
    - gateway 侧有一个**按 skill 注册的 E2E validator**（如 weather 检查输出符合预期结构——含地点/温度字段、非错误占位文本），它在 `adapter.completed` 后产出 `outputValidated:true|false`。
    - validator 只输出布尔 + 结构化校验结果，**不把原文写进遥测**。阶段5 用 `adapterSuccess === true` + `outputValidated === true` 判定"真实联网并返回有效外网数据"。
  - **`executionId` 合并规则（review #次要-1）**：一次逻辑执行（一次 `run()`，或一次 `spawn()` 会话）分配一个稳定 `executionId`。`spawn()` 的 created 与 final 两条**不追加为两个元素**，而是**按 `executionId` 合并更新同一个 `runs[]` 元素**；`sandbox.completed`/`adapter.completed` 也按 `executionId` 归并到同一 run。**断言只读 final 状态**（`resultMeta` 解析后的 `finalMeta`），防止把 spawn 创建时的 `full` 误当清理降级后的最终隔离结果。
  - **同时 instrument 一次性 `run()` 与持久 `spawn()` 两条路径**（review #P4——只挂 `run()` 会漏掉 MCP）：
    - **`run()` 完成路径**：执行返回时发 `sandbox.completed`（同一 `executionId` 随后由 Executor 发 `adapter.completed`）。
    - **`spawn()` 创建路径**：`backend.spawn()` 成功后记录"session created"（带 `executionId`、`traceId`、backend、isolationLevel 初值）。
    - **`spawn()` 的 `close()`/`resultMeta` 完成路径**：MCP 经 `spawn()` 建持久会话，**最终 meta 只有在 `session.close()` 解析 `resultMeta` 后才确定**（`sandbox-runner.ts` 的 `doClose` 里 await `proc.exited` 拿 exitMeta，再叠加 cleanup 结果）。telemetry 在 `close()` 完成、`resultMeta` 解析后，把**最终 meta** 合并进该 `executionId` 的 run 并发 `sandbox.completed`。
    - **cleanup 降级后的最终 isolation metadata**：`doClose` 里 backend.cleanup() 抛 `ContainmentCleanupError` 会把 `isolationLevel` 降到 `'none'` 并 `degraded:true`。`sandbox.completed` 记录的必须是这条**降级后**的 `finalMeta`，而不是 spawn 时的初值——否则会把一次 containment 破坏误报成 full isolation。
  - **digest 语义**：调试记录里的 `sandbox.digest` 指 **skill snapshot digest**（`identity.digest`，`sha256:<64hex>`，runner 在 prepare 前 verify 的那个），**不是** runtime image digest。文档写明。
  - 多次沙箱运行（MCP/composed）：每次 run/spawn 分配独立 `executionId`，都带同一 `traceId`，按 `traceId` 聚合为一条含 `runs[]`（按 `executionId` 区分）的记录；composed skill 记录 composer 轨迹。
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
  1. 前置检查（任一失败给修复提示、非零退出）：`hermes --version`；`octopus --version`（Hermes 腿要靠它）；`GET /agent/health`；`GET /agent/debug/last-run`（用 `AGENTOCTOPUS_E2E_ADMIN_KEY`）——**404**=端点没开（提示去开 `debugEndpoints.enabled`），**401/403**=key 问题，**200 `{run:null}`**=端点已开但缓冲为空（**正常**，继续）；两个测试 key 都存在于 env。
  2. **Hermes 腿 [1a]**：`hermes -z "<query>"`（默认 `"What's the weather in Tokyo?"`，`--query` 可覆盖），带 `--timeout`（默认 90s）。**无关联键、无凭证**——它触发 agentoctopus skill 跑 `octopus ask`。记录退出码 + stdout。
  3. **受遥测腿 [1b]**：生成关联键 `oct-e2e-<uuid>`（crypto random），嵌入 query；run.mjs **自己** `POST /agent/ask`（header `Authorization: Bearer AGENTOCTOPUS_E2E_ASK_KEY`，body `{query:"…[trace: oct-e2e-<uuid>]"}`）。
  4. 轮询 `GET /agent/debug/last-run?runId=oct-e2e-<uuid>`（用 `AGENTOCTOPUS_E2E_ADMIN_KEY`）直到 `run` 非空或超时。
  5. 按 5 阶段断言：阶段1 用 [1a]（退出码 0 + stdout 非空）；阶段2/3/4/5 用 [1b] 遥测（评分/意图/沙箱/结果断言按 Phase 3 语义；阶段5 需 `adapterSuccess===true` + `outputValidated===true`）。
  6. 输出 5 行 PASS/FAIL + 总 verdict；`--json` 机器可读。
- **CLI 参数**：`--query`、`--expect-skill`、`--threshold`、`--timeout`、`--json`。

## 错误处理（run.mjs，每条给可操作提示）

| 失败场景 | 检测 | 提示 |
|---|---|---|
| Hermes 不在 PATH | `hermes --version` 非零 | 安装/登录 Hermes，确认 `~/.local/bin` 在 PATH |
| gateway 没起 | `/agent/health` 连接拒绝 | 先 `octopus start`（:3002） |
| 未带/无效 key | 401 | 设 `AGENTOCTOPUS_E2E_ASK_KEY`（run.mjs POST /ask 的 Bearer）/ `AGENTOCTOPUS_E2E_ADMIN_KEY`（run.mjs 读遥测） |
| key tier 不足 | 403 | 调试端点需 admin tier——确认 run.mjs 用的是 `AGENTOCTOPUS_E2E_ADMIN_KEY` 而非 ASK_KEY |
| 调试端点没开 | 404 | `octopus.json` 设 `gateway.debugEndpoints.enabled:true` 并重启 |
| 缓冲为空（非错误） | 200 `{run:null}` | 端点已开、还没执行记录——正常，继续跑，不要去改 config |
| 限流 | 429 | 降低频率或提 tier |
| Hermes 没触发 agentoctopus | `hermes -z` 退出码非 0 / stdout 空 | 确认 Hermes 已加载 agentoctopus skill（`~/.hermes/skills/openclaw-imports/agentoctopus`）且 `octopus` CLI 在 PATH；先手动 `octopus ask "<query>"` 验证 CLI 路径 |
| 受遥测腿没记录 | `?runId` 超时 `run:null` | 确认 run.mjs 的 `/ask` POST 成功（看 HTTP 状态）且 query 里带了 `[trace: oct-e2e-<uuid>]`，gateway 才提取得到 |
| 调用超时 | 超 `--timeout` | 区分模型慢 vs 接线断，先手动 `hermes -z` 与 `curl /agent/ask` 分别验证 |
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

- `docs/integrations/hermes.md`：**更正过时接线**——删掉虚构的 `"tools":[{endpoint}]` JSON，改写为真实形态（Hermes 的 agentoctopus 是 `~/.hermes/skills/` 下的 skill，经 `octopus ask` CLI 调用）；加"端到端验证"（用测试 skill + 开 debugEndpoints + 配两个测试 key，由 run.mjs 直连 `/ask`）。
- `docs/core-concepts/sandbox.md`：记录联网导流机制（HTTP(S)_PROXY + bootstrap）与 skill 联网前提（hosts 声明 + grant）。
- `docs/api-reference/agent-protocol.md`：记录 `/agent/debug/last-run`（admin-only、runId、遥测字段）+ `/ask` 的关联键提取行为（从 query 提取 `oct-e2e-<uuid>` 模式作为 traceId）+ 分层遥测事件（`sandbox.completed`/`adapter.completed`/`outputValidated`）。
- `CLAUDE.md`：更新 gateway/agent-protocol（debugEndpoints 对象配置、调试端点、关联键提取+trace 剥除、分层遥测聚合）、core（`ExecutionContext.traceId` 传递、Executor `adapter.completed`、按 `executionId` 合并）、sandbox（bootstrap 联网机制）、镜像构建（vendored undici）。
- `TEST_INSTRUCTIONS.md`：加测试行。
- **代码改动范围**：
  - `packages/gateway`：`agent-protocol.ts` `/ask` handler 在路由前从 query 提取 `oct-e2e-<uuid>` 关联键、**剥除 `[trace:...]` 后再送 Router**；telemetry 记录带 apiKey id + receivedAt；新增 `/agent/debug/last-run` admin-only 端点 + 环形缓冲 + `gateway.debugEndpoints` **对象配置**（`enabled`/`includeQuery`/`bufferSize`）；端点关闭→404、开启但无匹配→200 `{run:null}`；telemetry sink 注册 + 按 `traceId+executionId` 聚合两类事件；**按 skill 注册的 E2E validator**（weather 结构校验）产出 `outputValidated`。
  - `packages/core`：新增内部 `ExecutionContext`（承载 `traceId`/`executionId`），在 `router.route()` / `executor.execute()` / `SandboxRunner` 间显式传递。**分层发事件**：`SandboxRunner` 在 `run()` 完成 + `spawn()` 创建 + `spawn().close()/resultMeta` 完成发 `sandbox.completed`（带**降级后** `finalMeta` + `exitCode` + `sandboxSuccess`）；`Executor` 在 adapter 返回后发 `adapter.completed`（带 `adapterSuccess` + 规范化 `errorCode`）。**不改** `AdapterResult`/`ExecutionResult` 既有形状。
  - `packages/sandbox` + `images/runtime`：bootstrap 联网导流（P1）、uid 65534 统一、契约测试。
  - `apps/cli/skills/weather` + `ip-lookup`：`requires.bins` `[curl]`→`[node]` + `sandbox.hosts` 声明（P2）。
  - **CLI（`apps/cli`）不改遥测**：Hermes 腿走 `octopus ask`（CLI 路径），它共用 core 的 Router/Executor/SandboxRunner 故沙箱/路由真实发生，但遥测落点只在 gateway——CLI 侧无需新增遥测。阶段1 的判定依据是 `hermes -z` 的退出码 + stdout，不是遥测。
- changeset：`feat(sandbox)`（联网修复）、`feat(gateway)`（调试端点+分层遥测+关联键提取+对象配置+validator）、`feat(core)`（ExecutionContext + sandbox.completed/adapter.completed 分层事件）按实际触及包分别入。

## 风险与开放点

- **镜像 TCB 扩大**：vendored undici 进 runtime 镜像，需 pinned + 哈希入锁 + 契约测试守护；后续 undici 升级要走同一审计路径。
- **undici 内部 Symbol 依赖**：`Symbol.for('undici.globalDispatcher.1')` 是 undici 内部约定，Node 大版本升级可能变；契约测试需在目标 Node 版本上断言该机制有效（v22 已实测）。
- **Hermes 自主决策随机性（阶段1 判定边界）**：Hermes 是否触发 agentoctopus skill、以及 skill 触发后是否真去跑 `octopus ask`，由 Hermes 模型自主决定，单次有随机性。阶段1 用 `hermes -z` 退出码 0 + stdout 非空作为**冒烟判定**——它能确认 Hermes 跑通了一次 agent 流程并给出输出，但**不能**逐次保证内部一定走了 `octopus ask`（模型可能直接答而不调 skill）。缓解：prompt 明确要求用 agentoctopus；若要把"自主工具选择"也作为受测行为，需多次采样而非单次断言——本期不做（YAGNI）。
- **阶段1 与阶段2–5 证据分离**：阶段1（接入 Hermes）由 Hermes 腿（CLI 路径）证明，阶段 2–5（路由/评分/沙箱）由受遥测腿（run.mjs 直连 `/ask`）证明。两腿共用同一份 Router/Executor/SandboxRunner 代码，故受遥测腿的底层结论对 Hermes 腿的机制成立；但**严格说**，阶段 2–5 的遥测证据来自 run.mjs 直接触发的执行，不是 Hermes 那次执行本身。这是路线 A 为换取确定性遥测而接受的边界，文档明示。

## 明确不做（YAGNI）

- 不把测试 skill 放进 AgentOctopus 沙箱执行（它是 Claude Code 侧编排者）。
- 不做多查询/参数化大批量测试。
- 不改沙箱 fail-closed 安全语义、路由评分算法。
- run.mjs 不入库、不写仓库内单测。
- 不做 Hermes 自主工具选择的统计采样测试。
- **不给 Hermes 建直接 HTTP tool 到 `/agent/ask`**：本机 Hermes 无"任意 REST endpoint + Bearer header"的声明机制，且真实接线是 CLI skill。关联键也不经 Hermes 传递（由 run.mjs 放进 `/ask` query），故取消原"备用关联"机制。
- **不在 CLI（`apps/cli`）加遥测**：遥测落点只在 gateway；阶段1 用 `hermes -z` 退出码 + stdout 判定，不需要 CLI 遥测。
- 不引入第三方 npm 依赖到 run.mjs。
