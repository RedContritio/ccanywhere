# Tasks: m-share-export-cleanup

## 准备 / 决策对齐

- [x] D1-D3 决策点对齐（见 proposal）：D1 去重 / D2 保留 details /
      D3 用 last-prompt.leafUuid 回溯
- [ ] fixture 采集：把 `~/.claude/projects/-Users-redcontritio-Projects-
      philosophy-journey/56b957d7-b9c4-4250-8c8d-445a33070e88.jsonl`
      复制到 `fixtures/share-export-rewind.jsonl`（用户授权后再做）

## 实现

- [ ] `src/share/render.ts` parseJsonl 重构两阶段：
      - 第一遍：扫所有行，build `Map<uuid, JsonlRow>` + 收集所有
        `type==='last-prompt'` 行；取最后一行的 `leafUuid` 作为 active
        tip
      - 第二遍：从 leafUuid 沿 parentUuid 回溯到 root，得到 active
        uuid set
      - 仅 active set 中的 user/assistant 行进入渲染
      - 边界：若 jsonl 完全没有 last-prompt 行（旧 cc 客户端写的
        session）→ fallback 到顺序渲染（即现行行为，向后兼容）
- [ ] `src/share/render.ts` 渲染层：
      - assistant message 内联 tool_use（保留 `<details>` 默认折叠）
      - 合并后续 synthetic-user 的 tool_result 到当前 assistant message
      - message 底部加 `.tools-footer` `<div>` 显示 `{N} tools used`
        (按 tool_use_id 去重)
      - 纯 tool_result 的 user message 不再单独渲染
      - 混含 text + tool_result 的 user message：text 部分照渲染，
        tool_result 移到前一条 assistant
- [ ] `src/share/render-assets.ts` 加 `.tools-footer` CSS（小字 muted
      底部右对齐 or 居中）

## 测试

- [ ] `src/share/render.test.ts` 新增：
      - rewind 过滤：构造含 dead 分支的 jsonl fixture，断言输出只含
        active path 行
      - tool 折叠：assistant 含 2 个 tool_use → 1 个 message block +
        footer "2 tools used"
      - tool_result 合并：synthetic user-role tool_result 不出现独立
        block；并到前 assistant footer
      - 混合：user 文本 + tool_result → 分两段（text 留 user，result 上
        移到前 assistant）
      - 计数去重：1 个 tool_use_id 配对 1 个 tool_result，N = 1（不是 2）

## Spec delta

- [ ] `openspec/specs/share/spec.md` 加 Requirement "导出渲染 rewind
      过滤 + tool 折叠"：
      - Scenario "rewind 后的 dead 分支不出现在 share view"
      - Scenario "tool_use / tool_result 合并到上一条 assistant 消息底部"
      - Scenario "纯 tool_result 的 synthetic user message 不独立显示"

## Ship

- [ ] 必跑序列：typecheck + lint + lint:md + test + build:all +
      launchctl kickstart + curl /healthz 200
- [ ] 用真实带 rewind 的 jsonl mint 一个 share，浏览器验视觉
- [ ] commit + 归档 `openspec/archive/<date>-m-share-export-cleanup/`
