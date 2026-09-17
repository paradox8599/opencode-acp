# REQ — 修复宿主 catalog API 漂移导致的模型窗口丢失

## 问题

ACP 在 OpenCode V2 下**永远读不到模型的 context window**,每次都退回 `compress.contextLimitFallback`(默认 128000)。于是所有百分比阈值都按 12.8 万计算:

- emergency = 98% × 128000 ≈ **125440**
- 上下文预算守卫 = 128000 − 32768 = **96531**

用户实际使用 `limit.context = 1000000` 的模型,上下文一过 12.5 万就被持续判定"严重超限",每轮强制要求压缩;而真实占用才 12%,没有值得压缩的内容,于是压缩失败并报"没有可压缩内容"。最终用户只能关掉插件。

## 根因

`@opencode/plugin` **2.0.4** 起移除了 `ctx.catalog` 域,成员提升为顶层域:

|            | 2.0.3(ACP 编译依据)           | 2.0.4 / 2.0.5(实机运行) |
| ---------- | ----------------------------- | ----------------------- |
| 模型目录   | `ctx.catalog.model.list()`    | `ctx.model.list()`      |
| 提供者目录 | `ctx.catalog.provider.list()` | `ctx.provider.list()`   |

ACP 的 devDependency 锁在 `2.0.3`,类型检查通过;但运行在 opencode 2.0.5 上时 `ctx.catalog` 是 `undefined`,调用抛 `TypeError`,又被 `catch { return 0 }` 吞掉,表现为"目录里没有记录"。

## 证据

- **数据是好的**:`opencode api GET /api/model` 返回 `o/deepseek-v4.1-flash limit.context=1000000`,20 个模型齐全;换三种 `location` 参数结果一致。
- **结构性失败,非时序**:插件初始化日志与 `Model limit catalog seeding recorded no entries` 落在**同一毫秒**;5 个 workspace、61 次初始化、连续 3 天零成功。且 `requestModel` 有值(日志 `model=o/deepseek-v4.1-flash`),证明请求期的懒重试确实执行过——在服务早已就绪、目录数据完整的情况下仍返回 0。
- **版本边界**:从 npm 取 `@opencode/plugin` 2.0.4 与 2.0.5 的 tarball,`dist/promise/catalog.d.ts` 均不存在;2.0.5 的 `Context` 第 38/42 行为 `readonly model` / `readonly provider`,而 2.0.3 第 30 行为 `readonly catalog`。
- **第二个调用点**:`index.ts` 的 `detectBiliProxy` 用 `ctx.catalog.provider.list()`,同样抛异常并被 `catch { return false }` 吞掉 → bili-proxy 探测长期静默失效。

## 验收标准

1. 在 opencode 2.0.5 下重启后,日志出现 `index: Model limit catalog seeded from provider catalog`(INFO),不再出现 `seeding recorded no entries`(WARN)。
2. 会话状态 `contextLimitSource=model`,`contextLimit` 等于配置值(1000000)。
3. 宿主目录不可用或调用抛错时**必须留下错误日志**,不再静默返回 0 / false。
4. `npm run typecheck` 干净;`npm run test` 除既有的 `/tmp` 环境性失败外全绿。
5. 新增回归测试:喂一个**只有顶层 `model`、没有 `catalog`** 的宿主 ctx,断言能记录到窗口值。该测试在修复前必须失败。

## 约束

- 运行环境是 opencode 2.0.5;`@opencode/plugin` devDependency 升到 2.0.5,让类型检查今后能拦住这类宿主 API 漂移。
- 测试 fixture 必须照搬真实宿主形状,不能照抄生产代码的假设——本次 1314 个用例没拦住,正是因为 fixture 自证。

## 非目标

- 不为 2.0.3 保留兼容分支(AGENTS.md 零兼容原则)。
- 不改阈值语义、不改 emergency / 预算守卫的计算方式。
- 不修改用户的 `~/.config/opencode/*` 配置(仅提示需放开被注释的插件行)。
