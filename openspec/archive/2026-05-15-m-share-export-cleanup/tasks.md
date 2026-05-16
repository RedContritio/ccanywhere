# Tasks: m-share-export-cleanup (shipped 2026-05-15)

## 实施轨迹

scope 在 ship 期间被 user 反馈两次收紧 — 从原 "tool 折叠到 details
collapsed" 演化为 "tool body 完全不进 HTML，仅 footer count"。

## 决策对齐

- [x] D1 = 去重（tool_use_id pair 算 1）
- [x] D2 → 完全不渲染 tool body（推翻原"保留 details collapsed"）
- [x] D3 = last-prompt.leafUuid 回溯（sample 自含 13 个 last-prompt 的
      philosophy-journey session）

## 实现

- [x] `src/share/render.ts` 拆 `src/share/render-parse.ts`（避免超
      300-line lint cap）。render.ts 保留 renderShareHtml + page chrome
      + format helpers；render-parse.ts 含 parseJsonl + helpers + types
- [x] `computeActiveUuids`：扫 jsonl 找最后一个 `last-prompt` 行，从
      其 leafUuid 沿 parentUuid 回溯到 root，得 active uuid set；无
      last-prompt → null（fallback 顺序渲染）
- [x] parseJsonl 重构：以 user real-text 为段边界。维护 `open`
      assistant bucket：assistant rows 累积，synthetic user-role
      tool_result 仅追加 tool_use_id 到 bucket，real user text 触发
      flush + push 新 user article + 关 bucket
- [x] partitionUserContent / partitionAssistantContent 不再生成 tool
      body html；仅返 textHtml + toolUseIds
- [x] composeMessageHtml：`{textHtml}{footer}`，footer 显示
      `{N} tool[s] used`
- [x] `src/share/render-assets.ts` 删 `.tool-use` / `.tool-result` 全部
      CSS（不再需要）；保留 `.tools-footer`

## 测试

- [x] `src/share/render.test.ts` 留 v1 行为（page chrome / text / XSS /
      truncate / 系统行跳过）共 10 case
- [x] `src/share/render-rewind.test.ts` 新文件含 m-share-export-cleanup
      9 case：lone tool_use → footer only / synthetic user-role
      tool_result 行整条不渲染 / errored tool_result body 也不漏 /
      混合 user text + tool_result 拆分（text 留 user，tool body 丢弃）
      / 多 assistant rows 段内合并 / footer 去重 / active path 过滤 /
      multi last-prompt 取最后 / 无 last-prompt fallback
- [x] vitest root 422 / share 共 46 cases pass

## Spec delta

- [x] `openspec/specs/share/spec.md` 加 Requirement「导出仅含 active
      path + tool 调用 footer 化」+ 6 个 Scenario：last-prompt
      active path / 多 last-prompt 取最后 / 无 last-prompt fallback /
      synthetic user-role tool_result 整行不渲染 / 多 assistant 合并 /
      混合 user 拆分 / footer 去重

## Ship

- [x] 必跑序列：typecheck + lint + lint:md + test (root 422 + share
      46) + build:all + launchctl kickstart + curl /healthz 200
- [x] 用真实 philosophy-journey jsonl mint 新 share：
      `c412a1a6-2ff6-4568-99f7-639e7e4184ec`，确认 0 个 `<details>` +
      footer 显示 "1 tool used" / "2 tools used"
- [x] commit + archive

## Commits

- ef656a7 feat(share): m-share-export-cleanup — rewind 过滤 + tool 调用 footer 化
- be2777d plan: m-share-export-cleanup — rewind 过滤 + tool 折叠 footer
