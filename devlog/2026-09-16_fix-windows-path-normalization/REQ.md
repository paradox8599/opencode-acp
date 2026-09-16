# REQ — 修复 protectedFilePatterns 在 Windows 上的路径分隔符归一化

- 来源：上游 `ranxianglei/opencode-acp` commit `5035d366`（Fixes upstream #402，端口自 DCP commit `5f8f33b`）
- 本 fork 状态：**该 bug 仍存在**

## 背景与问题

`protectedFilePatterns` 通过把工具参数里的路径与 glob 模式做匹配来保护文件。`lib/protected-patterns.ts` 的 `normalizePath()` 负责在匹配前把路径分隔符统一成 `/`，好让 Windows 路径也能工作。

实际代码写成了：

```ts
return input.replaceAll("\\\\", "/")   // 这是「两个反斜杠」的字符串
```

源码里 `"\\\\"` 是**两字符**的字符串 `\\`，而真实的 Windows 路径只有**单个**反斜杠分隔符 —— 于是归一化在唯一需要它的平台上完全是空操作。

## 影响

静默的安全/隐私绕过：Windows 上用户明确配置要保护的文件，在所有 `isFilePathProtected` 调用点（protected-content、sweep、deduplication、purge-errors）都**没有被保护**。只有 `**/*.ts` 这类模式碰巧还能用，因为 `*` 编译成 `[^/]*`，本来就能跨过反斜杠。

## 验收标准

- `normalizePath` 把每个单反斜杠转成 `/`。
- Windows 路径 + 正斜杠模式 → 被保护；正斜杠路径 + Windows 分隔符模式 → 被保护。
- `*` 仍然**不跨越**分隔符（不允许过度匹配）。
- read / multiedit / apply_patch 三种参数形态都覆盖。
- 全量测试通过。

## 非目标

- 不改变 glob 语义。
- 不改变其他调用点。
