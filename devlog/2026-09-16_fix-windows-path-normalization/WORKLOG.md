# WORKLOG — fix-windows-path-normalization

## 决策

上游自我们上次合并点（`c6066c4`）起只有 2 条新提交，其中 1 条是合并 PR；实质变更只有本条。本 fork 已与上游分叉（V2 迁移），**不做整分支合并**，只把这一个修复端口过来。

## 改动

| 文件 | 说明 |
| --- | --- |
| `lib/protected-patterns.ts` | `normalizePath` 的一行修复 + 解释性注释 |
| `tests/protected-patterns.test.ts` | 新增回归测试（8 例，端口自上游） |
| `devlog/2026-09-16_fix-windows-path-normalization/` | 本 devlog |

核心 diff：

```diff
 function normalizePath(input: string): string {
-    return input.replaceAll("\\\\", "/")
+    // A single backslash. In source, "\\" is the one-character string; the
+    // previous "\\\\" was a *two*-character string, so it only ever matched a
+    // doubled separator -- which a real Windows path does not contain. The
+    // normalisation was therefore a no-op on the only platform that needs it.
+    return input.replaceAll("\\", "/")
 }
```

## 实现要点

- 分隔符是**转换**而不是删除，所以 `*` 仍然编译成 `[^/]*`，不会跨目录。
- 测试用 `String.fromCharCode(92)` 构造反斜杠 —— 被钉住的正是"字符串字面量转义写错"这一类 bug，测试本身不能再手写转义把人绕进去。
- 模式侧也归一化：用户从资源管理器复制出来的 Windows 路径当模式用，结果与文档写法一致。

## 验证

- `npx tsc --noEmit` 干净。
- `tests/protected-patterns.test.ts` 8/8 通过。
- 全量 `npm run test` 通过（唯一失败为既有环境问题 `tests/inactive-block-decompress.test.ts:193`）。
- 上游报告：修前 5/8 失败，修后 8/8 通过（同类回归已被本测试钉住）。

## 备注

- 影响面仅限 Windows。本 fork 的维护者使用 macOS，实际不会触发，端口过来主要是为了与上游行为一致、并消除一个静默的"保护失效"路径。
