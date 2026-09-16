# DESIGN — 在 provider 响应流上剥离标签

## 根因

标签是**模型自己写出来的**（幻觉），并且是**逐字流式生成**的：模型看到 ACP 给每条消息追加的 `<dcp-message-id …>`，偶尔照抄一个，编号按"下一个"猜，所以经常猜对。

关键点在于**它不是连续文本**——字符被拆散在相邻的 SSE 事件里，中间隔着 JSON 语法：

```
data: {"choices":[{"delta":{"content":"Ok"}}]}
data: {"choices":[{"delta":{"content":"."}}]}
data: {"choices":[{"delta":{"content":"\n\n"}}]}
data: {"choices":[{"delta":{"content":"<"}}]}
data: {"choices":[{"delta":{"content":"dc"}}]}
data: {"choices":[{"delta":{"content":"p"}}]}
data: {"choices":[{"delta":{"content":"-m"}}]}
...
```

因此：
- 对**原始字节/单行**做正则永远匹配不到 `<dcp-message-id`；
- 只用"当前 chunk"判断也不行（要跨事件累积）。

## 方案

`lib/v2/http-response-filter.ts`，挂在 `ctx.session.hook("http.response")`（V2 唯一的输出侧钩子）。

1. `scrubProviderResponseBody(response)`：只处理 `content-type: text/event-stream`；用 `TransformStream` 逐块解码，**按行**处理，保留未成行的尾巴。
2. 每个 `data:` 行 → `JSON.parse` → 把 `choices[].delta.content`（以及 `choices[].message.content`）交给 `WireTagScrubber` → 写回 JSON。
3. **每个响应一个 scrubber 实例**（并发流不共享状态）。
4. `WireTagScrubber` 增量剥离：
   - 已完成的开闭标签对 → 连同中间内容一起删；
   - 不完整、但**仍可能长成标签**的尾部 → 扣住不发（`partialIndex` / `unmatchedOpenerIndex`）；流结束时仍未闭合 → 丢弃；
   - 普通文本（如 `a < b`）不匹配标签前缀 → 正常发出。
5. 非 `data:` 行、`[DONE]`、解析失败的负载 → 原样透传。

## 为什么不用 `ctx.aisdk.hook("language")`

先前的实现（`lib/v2/hallucination-filter.ts`）包装语言模型实例。实测在 OpenCode 2.0.3 下该钩子**从不被派发**，模型实例也拿不到，属于死代码 —— 已连同其测试一并删除。

## 代价

一旦注册了 `http.request`/`http.response`，harness 会禁用该 provider 的 websocket 传输（改走 HTTP 流）。本 provider（`@ai-sdk/openai-compatible`）本来就走 HTTP。

## 测试

`tests/http-response-filter.test.ts`：单元（scrubber 增量 / 前缀判定）+ SSE 管线（**按 7 字节切片喂入**，覆盖分片与跨事件累积），并断言 `[DONE]`、`usage`、`finish_reason` 等事件不受影响。
