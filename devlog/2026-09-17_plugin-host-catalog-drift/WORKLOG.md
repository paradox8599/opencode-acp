# WORKLOG - 修复宿主 catalog API 漂移导致的模型窗口丢失

- Task ID: `2026-09-17_plugin-host-catalog-drift`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-17 13:00

## 1. Summary

- **What was done**: 把 ACP 读取宿主模型目录的路径从 `@opencode/plugin` 2.0.3 的 `ctx.catalog.model` / `ctx.catalog.provider` 改为 2.0.4+ 的顶层 `ctx.model` / `ctx.provider`,并把 devDependency 升到 2.0.5;同时消除两处 `catch` 静默吞异常。
- **Why**: `ctx.catalog` 自 2.0.4 起不存在,ACP 每次取模型窗口都抛 `TypeError` 并被吞掉,导致模型窗口永远读不到、所有百分比阈值按 128000 兜底计算,用户在 100 万窗口的模型上被持续误报"上下文超限"。
- **Behavior / compatibility changes**: 是。不再支持 `@opencode/plugin` ≤ 2.0.3。持久化状态格式、配置 schema、`dcp-*` 内部标签无变化。
- **Risk level**: Low(路径纠正 + 日志;无阈值语义变更)。

## 2. Change Log

### Commits

| Commit   | Description                                                      |
| -------- | ---------------------------------------------------------------- |
| (待提交) | `fix: read model catalog from the 2.0.4+ top-level host domains` |

### Key Files

- `lib/v2/host.ts` — `V2HostContext` 的 `catalog: { model }` 改为顶层 `model`;`buildProvidersPayload` 改调 `ctx.model.list()`。返回信封 `{ location, data: ModelInfo[] }` 未变,已有容错解析无需调整。
- `index.ts` — `detectBiliProxy` 的 `catalog: { provider }` 改为顶层 `provider`,改调 `ctx.provider.list()`;签名加 `logger`,`catch` 由 `return false` 改为记录警告。
- `lib/state/model-limits.ts` — `createModelLimitCatalog(logger?)` 接收可选 logger;`hydrateFromClient` 的 `catch { return 0 }` 改为记录 `Model limit catalog hydration failed` 后返回 0。更新了文件头关于 FIX #312 的说明(原文写"seeded from /config/providers",是 V1 措辞)。
- `lib/state/state.ts` — `SessionStateRegistry` 改为在构造函数体内 `createModelLimitCatalog(this.logger)`。改为构造函数赋值是因为 `useDefineForClassFields`(target ES2022)下字段初始化与参数属性赋值的顺序不宜依赖。
- `package.json` — devDependency `@opencode/plugin` 2.0.3 → 2.0.5。
- `package-lock.json` — 依赖提升/去重产生的连带变动(顶层新增 `@opencode/client`、`effect`、`@effect/*`、`ini`、`isexe`、`which`、`undici`;移除各包下的嵌套副本)。
- `tests/v2-setup.test.ts` — fixture 由 `catalog: { provider, model }` 改为顶层 `provider` / `model`;`app.version` 2.0.3 → 2.0.5。
- `tests/v2-model-catalog.test.ts` — 新增,2 条用例。

## 3. Design & Implementation Notes

见同目录 `DESIGN.md`。要点:

- **Entry point / key function**: `buildProvidersPayload`(`lib/v2/host.ts`)是唯一读取宿主目录的地方;它通过 `client.config.providers()` 暴露给既有的 `hydrateFromClient`。
- **接缝不变**: ACP 仍然不 import 宿主类型,`V2HostContext` 是自行声明的结构化契约,由 `index.ts` 把真实 `ctx` 传入。因此这次漂移**不会**被编译器发现——除非 devDependency 指向真实版本。这正是把版本从 2.0.3 升到 2.0.5 的原因。

### 定位过程(证据链)

| 假设                               | 验证方式                                                                                                               | 结论                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户的模型没配 `limit`             | 读 `~/.config/opencode/opencode.jsonc`                                                                                 | **排除**。`provider.o.models["deepseek-v4.1-flash"].limit.context = 1000000`,且 `git diff` 显示该段在 commit 里早就有,不是刚加的                                |
| 目录接口本身取不到数据             | `opencode api GET /api/model` 直连运行中的服务                                                                         | **排除**。返回 20 个模型,`o/deepseek-v4.1-flash limit.context=1000000`                                                                                          |
| 目录按 location 作用域返回不同结果 | 用 `/Users/para`、仓库目录、`.config/opencode` 三种 location 各取一次                                                  | **排除**。三次都是 20 个模型、limit 一致                                                                                                                        |
| 时序问题(seeding 早于服务就绪)     | 核对日志时间戳 + `requestModel` 是否有值                                                                               | **排除**。初始化与失败同毫秒;且 `hooks.ts` 的请求期补偿确实执行过(`requestModel` 有值,日志 `model=o/deepseek-v4.1-flash`),在目录数据完整时仍返回 0 → 结构性失败 |
| ref 分配 / 状态持久化              | 前一阶段已排除(与压缩死锁无关)                                                                                         | 排除                                                                                                                                                            |
| 宿主 API 形状变了                  | 读 `@opencode/plugin` 2.0.5 的 `dist/promise/plugin.d.ts`;并从 npm 拉 2.0.4/2.0.5 tarball 核对 `catalog.d.ts` 是否存在 | **成立**。2.0.4 与 2.0.5 均无 `dist/promise/catalog.d.ts`;`Context` 第 38/42 行为顶层 `model` / `provider`,而 2.0.3 第 30 行为 `catalog`                        |

**关键教训(复用价值高)**:判定"宿主 API 不存在"不能靠**日志语义**。原日志把三种情况——调用抛异常、返回信封形状不符、目录确实为空——压成同一句 `recorded no entries`,与"用户没配 limit"完全同形。**静默降级的日志必须能区分"失败"与"空"。**

**第二条教训**:`tests/v2-setup.test.ts` 的 fixture 手写 `catalog: { provider, model }`,等于把生产代码的错误假设写进了测试。**fixture 要照搬真实宿主类型,而不是照搬自己的调用代码。**

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
npm run verify:package
npm test
npx prettier --write <touched files>

# 定向运行
node --import tsx --test tests/v2-model-catalog.test.ts tests/v2-setup.test.ts
```

### Test Coverage

- New/modified test files: `tests/v2-model-catalog.test.ts`(新增,2 条)、`tests/v2-setup.test.ts`(fixture 改形)
- Test count: **1316 total, 1315 pass, 1 fail**。失败项为改动前就存在的环境问题(`tests/inactive-block-decompress.test.ts:206`,测试硬编码 `/tmp`,而 ACP 的守卫只放行 `os.tmpdir()`),与本改动无关。改动前基线为 1314 / 1313 / 1,新增 2 条全部通过。
- Key scenarios verified:
    1. `hydrates model limits from the top-level host model domain` — 走真实的 `createAcpHost` 门面 + `SessionStateRegistry.hydrateModelLimitsFromClient`,断言记录到 1 条且 `resolveModelLimit("o","deepseek-v4.1-flash") === 1000000`。
    2. `hydration failure is logged instead of silently returning 0` — 让 `config.providers` 抛错,断言返回 0 **且**恰好产生一条 `Model limit catalog hydration failed` 警告。
    3. `setup stays off when a /bili/ proxy provider is configured`(既有用例)→ 现在走顶层 `ctx.provider`,同时守卫了 bili 路径的改动。

### 回归验证(AGENTS.md 要求:复现 bug 时测试必须失败)

把 `lib/v2/host.ts` 的调用临时改回 `ctx.catalog.model.list()` 后运行 `tests/v2-model-catalog.test.ts`:

```
✖ hydrates model limits from the top-level host model domain
  AssertionError: the host model domain must be readable (pre-2.0.4 `ctx.catalog.model` throws)
ℹ pass 1  ℹ fail 1
```

恢复修复后 2/2 通过。**已确认该测试针对 bug 有效,而非恒真。**

另外用一次性探针文件验证版本锁确实提供保护(验证后已删除):

```ts
// lib/__drift_probe.ts
setup(ctx) { void ctx.catalog.model.list() }
```

在 `@opencode/plugin@2.0.5` 下 `npm run typecheck` 报:

```
error TS2339: Property 'catalog' does not exist on type 'Context'.
```

### Results

- **PASS**: `npm run typecheck` 干净;`npm run verify:package` 通过(tarball 103 entries);`npm test` 1315/1316(唯一失败为既有环境问题)。
- **Key logs/data**: 期望实机重启后出现 `index: Model limit catalog seeded from provider catalog`(INFO),取代 `Model limit catalog seeding recorded no entries`(WARN)。

## 5. Risk Assessment & Rollback

- **Risk points**:
    - 若仍在使用 `@opencode/plugin` ≤ 2.0.3 的宿主,本次改动会让模型目录读取抛错(但会**记日志**,不再静默)。实机环境为 opencode 2.0.5。
    - `package-lock.json` 变动较大,复核确认全部为依赖提升/去重,归因于 2.0.3 → 2.0.5。
- **Rollback method**:
    - Revert commit(s): `(待提交)`
    - Rollback impact: 恢复为静默失效(模型窗口永远退回 128000 兜底)。若需临时缓解可设 `compress.contextLimitFallback` 为真实窗口,但这是缓解不是修复。
- **Compatibility notes**: 不支持 ≤ 2.0.3。持久化状态、配置 schema 无变化,无需迁移。

## 6. Lessons Learned

- **What went well**: 坚持用运行时证据逐条排除假设(直连服务端 `/api/model`、核对 location 无关性、确认 `requestModel` 有值),最终把范围收敛到"数据是对的、调用方是坏的",再顺着依赖版本找到删掉的域。
- **What could be improved**:
    - 这次同一根因还**同时**解释了两个此前被当作独立问题调查的现象:12.5 万起的 emergency 误报(以及由此产生的"频繁触发 compress 且失败"),和 362 条 `ACP hard guard` 报错。定位时应更早把"阈值失真"与"窗口来源"两条线并起来看。
    - 依赖 devDependency 的版本锁定,会让类型检查对着已不存在的 API 通过——对**结构化契约的接缝**尤其危险。
- **Reusable conclusions**:
    - ACP 与宿主的接缝是结构化(鸭子类型)契约,编译器不会替你验证;**devDependency 版本必须跟随实机宿主版本**,这是该接缝唯一的自动化保护。
    - 任何"best-effort + 返回默认值"的路径都必须记日志,否则失败与空数据不可区分。

## 7. Follow-ups

- [ ] 实机验证:重启 OpenCode 后确认 `seeded from provider catalog` 与 `contextLimitSource=model`。
- [ ] 复核 `index.ts` 中"`aisdk` language hook 从不派发(verified in 2.0.3)"的结论在 2.0.5 下是否仍成立。
- [ ] 复核 `tests/inactive-block-decompress.test.ts` 硬编码 `/tmp` 的既有失败(与本改动无关,但会长期污染测试结论)。
