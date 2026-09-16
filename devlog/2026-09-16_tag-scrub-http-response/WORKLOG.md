# WORKLOG — 2026-09-16 tag-scrub-http-response

## 最终结论

标签是**模型自己逐字生成的幻觉**，并且是**跨 SSE 事件分片**出现的：

```
content:"Ok"  content:"."  content:"\n\n"  content:"<"  content:"dc"  content:"p"  content:"-m"  content:"essage"  ...
```

模型在上下文里看到 ACP 给每条消息注入的 `<dcp-message-id tokens="N" type="...">mNNNNN</dcp-message-id>`，偶尔照抄一份；编号按"下一个"猜，所以经常正好猜中自己的编号（这也是最初误判成"ACP 注入"的原因）。

## 定位过程（关键弯路）

| 假设 | 验证方式 | 结论 |
| --- | --- | --- |
| ACP 注入后被落盘 | 统计存储：user 0/84 带标签，assistant 36/189 | 排除（ACP 对 user 也注入） |
| harness 落盘插件返回的上下文 | 上下文里打标记 | 排除（`mutated=0`） |
| `aisdk.hook("language")` 包装模型 | 探针记录钩子调用 | 钩子**从不被派发** → 旧方案作废 |
| `session.hook("http.response")` 换掉响应体 | 在响应体开头插 `ZZPROBE`，存储里出现 | 钩子链路成立 |
| 标签在响应流里 | 逐 chunk dump 原始字节 | **成立**（可见 `<` `dc` `p` `-m` … 逐字拼出） |

**核心教训**：最初几轮"流里没有标签"是因为探针**只截每个 chunk 的开头 240 字符**，而标签在 JSON 负载内部；且正则跑在**原始字节**上，而标签字符被 JSON 语法隔开——两边都不匹配。**必须按解码后的 `content` 累积判断。**

另一条教训（复用价值高）：**不能用"我读到的内容"判断标签是否存在**——ACP 输入侧 `stripHallucinations` 会把工具输出里的标签也剥掉。判定必须看存储/原始字节，或把 `<`/`>` 转写成 ‹›。

## 实现

- 新增 `lib/v2/http-response-filter.ts`：
  - `stripWireTags(text)` — 删成对标签（含中间内容）与游离标签。
  - `WireTagScrubber` — 增量剥离：完整标签对删除；可能长成标签的尾部**扣住**（`partialIndex()` / `unmatchedOpenerIndex()`），流结束时仍是残片则丢弃；`a < b` 这类普通文本不误扣。
  - `scrubProviderResponseBody(response)` — 仅处理 `text/event-stream`；`TransformStream` 逐块按行解析 `data:` → `JSON.parse` → 清洗 `choices[].delta.content` / `message.content` → 写回。
- `index.ts`：`await ctx.session.hook("http.response", (event) => { event.response = scrubProviderResponseBody(event.response) })`。
- 删除已失效的 `lib/v2/hallucination-filter.ts` 与 `tests/hallucination-filter.test.ts`。
- `lib/v2/context-handler.ts`：`event.messages.splice(...)` → `event.messages = imported.exportV2Messages()`（避免就地改写调用方数组）。

## 过程中的两个实现 bug（已修）

1. 第一版 scrubber 用**模块级共享实例**（并发流会串状态）——改为按响应传递。
2. `flush()` 先清空 `this.pending`，随后 `partialIndex()` 读的正是这个已清空的字段 → 永远判定"不是标签"，把残片原样吐出。改为 `partialIndex(text)` 接收待判定文本。

## 验证

- `npx tsc --noEmit` 干净。
- `tests/http-response-filter.test.ts` 17/17（含**按 7 字节切片喂入**的跨事件分片用例）。
- 全量 `npm run test`：1306 个用例，1305 通过；唯一失败 `tests/inactive-block-decompress.test.ts:193` 是既有的环境问题（测试写 `/tmp`，守卫只放行 `os.tmpdir()` 与 `~/.cache/opencode/`），与本次无关。
- **实机**：`/tmp/acp-probe` 新会话 pin `o/deepseek-v4.1-flash`，6 轮对话 → 全部无标签（`RESULT: CLEAN`）。修复前同样条件 8 轮里 6 轮泄露。

## 备注

- 注册 `http.response` 会使该 provider 禁用 websocket 传输（harness 行为）；本 provider 本就走 HTTP。
- 旧会话里已落盘的标签不会消失（仅显示层；发给模型前 ACP 仍会剥掉）。
- 为便于迭代，`~/.config/opencode/opencode.jsonc` 的插件路径暂时指向本仓库；发布前需改回 `github:paradox8599/opencode-acp`。
