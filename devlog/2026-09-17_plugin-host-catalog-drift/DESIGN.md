# DESIGN - 修复宿主 catalog API 漂移导致的模型窗口丢失

- Task ID: `2026-09-17_plugin-host-catalog-drift`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?**
  ACP 在 OpenCode V2 上**从未成功读取过任何模型的 context window**。每次 seeding 都返回 0 条,于是 `state.modelContextLimit` 恒为 `undefined`,`resolveEffectiveContextLimit` 退回 `compress.contextLimitFallback`(默认 128000)。所有百分比阈值随之失真:emergency 落在 98% × 128000 ≈ 125440,上下文预算守卫的 `budget` 落在 128000 − 32768 = 96531。用户使用 `limit.context = 1000000` 的模型,上下文刚过 12.5 万就被持续判定严重超限,每轮强制要求压缩;真实占用仅约 12%,没有合格候选,压缩失败并回报"没有可压缩内容"。

- **Why now?**
  该缺陷使 ACP 在实际使用中不可用(用户已因此禁用插件),且**静默**——日志只表现为"目录里没有记录",与"用户没配 limit"完全同形,无法自证。

## 2. Goals & Non-Goals

- **Goals**:
    - ACP 在 opencode 2.0.5 下能读到模型的真实窗口,`contextLimitSource=model`。
    - 类型检查今后能拦住同类宿主 API 漂移。
    - 目录调用失败必须留痕,不再静默降级。
- **Non-Goals**:
    - 不保留 2.0.3 兼容分支。
    - 不改阈值语义(emergency / 预算守卫的计算方式)。
    - 不引入配置项让用户手工声明窗口(那是绕过,不是修复)。

## 3. Current Architecture (if applicable)

- **How it works today**:

    ```
    index.ts setup(ctx)
          │
          ├─ registry.hydrateModelLimitsFromClient(host.client)   ← 初始化，fire-and-forget
          │        └─ catalog.hydrateFromClient(client)
          │              └─ client.config.providers()             ← lib/v2/host.ts 的门面
          │                    └─ buildProvidersPayload(ctx)
          │                          └─ ctx.catalog.model.list()  ← ✗ 2.0.4 起不存在
          │
          └─ ctx.session.hook("context", …)
                └─ lib/hooks.ts 请求期补偿
                      └─ registry.hydrateAndResolve(client, providerID, modelID)  ← 每进程一次
    ```

    `V2HostContext` 是 ACP 与宿主之间的接缝(模块边界):ACP 不引用宿主的类型,只声明自己需要的那部分结构,由 `index.ts` 把真实的 `ctx` 传进 `createAcpHost`。

- **Pain points**:
    - `ctx.catalog` 在 `@opencode/plugin` 2.0.4 被移除,成员提升为顶层 `ctx.model` / `ctx.provider`。ACP 的 devDependency 锁在 2.0.3,**类型检查通过而运行时抛 `TypeError`**。
    - `hydrateFromClient` 的 `catch { return 0 }` 与 `detectBiliProxy` 的 `catch { return false }` 把异常与"确实没有数据"合并成同一种可观测结果。
    - `tests/v2-setup.test.ts` 的 fixture 手写 `catalog: { provider, model }`,**照抄了生产代码的错误假设**,使测试替 bug 背书。

## 4. Proposed Architecture

- **Overview**: 接缝本身不动,只把宿主侧的域路径改成 2.0.4+ 的真实形状,并让失败可见。

    ```
    buildProvidersPayload(ctx) → ctx.model.list()
    detectBiliProxy(ctx, logger) → ctx.provider.list()
    hydrateFromClient → catch(error) → logger.warn("Model limit catalog hydration failed", …)
    ```

- **Key components**:
    - `lib/v2/host.ts` — `V2HostContext` 声明顶层 `model`;`buildProvidersPayload` 用 `ctx.model.list()`。返回信封仍是 `{ location, data: ModelInfo[] }`,已有的 `Array.isArray(payload) || Array.isArray(payload.data)` 容错保持不变。
    - `index.ts` — `detectBiliProxy` 声明顶层 `provider`,并把 `logger` 传进去记录失败。
    - `lib/state/model-limits.ts` — `createModelLimitCatalog(logger?)` 接收可选 logger,在 catch 中记录错误。工厂保持"永不抛出"的契约,但不再"永不发声"。
    - `lib/state/state.ts` — `SessionStateRegistry` 在构造函数体内创建 catalog 并注入 `this.logger`(改为构造函数赋值,避开类字段初始化顺序不确定的问题)。

- **Data flow**: 不变。目录 → `client.config.providers()` → `hydrateFromClient` → `modelLimits: Map<"provider/model", number>` → `resolveModelLimit` → `state.modelContextLimit` → `resolveEffectiveContextLimit`。

- **API / interface changes**:
    - `V2HostContext.catalog.model` → `V2HostContext.model`
    - `createModelLimitCatalog()` → `createModelLimitCatalog(logger?: Logger)`
    - `detectBiliProxy(ctx)` → `detectBiliProxy(ctx, logger)`

## 5. Design Decisions & Rationale

| Decision                     | Options Considered                                                                                | Chosen | Why                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主域路径                   | (a) 直接改成顶层 `ctx.model` / `ctx.provider`; (b) 运行时探测 `ctx.catalog ?? ctx.model` 双路兼容 | (a)    | 运行环境是 2.0.5;双路兼容会让同一处接缝长期携带两套假设,并把"哪条路生效"变成新的隐式状态。AGENTS.md 零兼容原则。                                                    |
| devDependency 版本           | (a) 升到 2.0.5; (b) 继续锁 2.0.3 并靠测试守卫                                                     | (a)    | 版本锁是这次能蒙混过关的**根本原因**:类型检查对着已不存在的 API 说"没问题"。升级后 `Property 'catalog' does not exist on type 'Context'` 会直接报错(已用探针验证)。 |
| 失败可观测性                 | (a) 在 catch 里记日志; (b) 让 `hydrateFromClient` 抛出,由调用方处理                               | (a)    | 该函数是 fire-and-forget 的最佳努力路径,"永不抛出"是其契约;破坏契约会牵连 `index.ts` 与 `registry.hydrateAndResolve` 两处调用方。记录日志足以消除"静默"。           |
| 是否新增配置项让用户声明窗口 | (a) 新增 `compress.modelContextWindow`; (b) 不新增                                                | (b)    | 用户已在 `opencode.json` 正确声明;再加一份 ACP 私有副本是把宿主的真相分裂成两份,属于绕过。                                                                          |
| 测试 fixture                 | (a) 改成 2.0.5 顶层形状; (b) 保留 `catalog` 形状                                                  | (a)    | fixture 必须照搬**真实宿主 API**,而不是照搬生产代码的假设。它照抄假设,正是这次 1314 个用例全绿的原因。                                                              |

## 6. Impact Analysis

- **Backward compatibility**: 不再支持 `@opencode/plugin` 2.0.3(及 opencode ≤ 2.0.3)。这是刻意的:2.0.3 与 2.0.4+ 的插件上下文形状不兼容,维持两者需要兼容层,而 ACP 的实际运行环境是 2.0.5。持久化状态格式、配置 schema、`dcp-*` 内部标签均无变化。
- **Performance**: 无变化。seeding 仍是一次 fire-and-forget 调用;失败时多一次 `logger.warn`。
- **Security**: 无影响。
- **Dependencies**: `@opencode/plugin` devDependency 2.0.3 → 2.0.5。它会带入 `@opencode/client` / `@opencode/schema` / `@opencode/protocol` / `effect` 等,`package-lock.json` 因依赖提升与去重产生约 546 行变动(新增顶层条目、删除嵌套副本),均为该升级的必然结果。仅 devDependency:发布产物与运行时依赖图不受影响(`npm run verify:package` 通过)。

## 7. Migration Plan (if applicable)

- **Steps**:
    1. 合并本改动并重启 OpenCode。
    2. 确认日志出现 `index: Model limit catalog seeded from provider catalog`(INFO),且不再出现 `seeding recorded no entries`(WARN)。
    3. 确认会话状态 `contextLimitSource=model`、`contextLimit` 等于模型配置值。
- **Feature flags / gradual rollout**: 无。修复是路径纠正,不引入行为开关。

## 8. Open Questions

- [ ] `index.ts` 中另有一处历史注释"verified in 2.0.3"(关于 `aisdk` language hook 从不派发)。该结论是否在 2.0.5 下仍然成立未验证——与本修复无关,但同属宿主 API 漂移的观察面,值得后续单独确认。
- [ ] 2.0.4 是否还有其他被移除/重命名的域未被 ACP 触达(当前 ACP 只用到 `location` / `session` / `tool` / `command` / `event` / `model` / `provider`,已逐个核对存在)。
