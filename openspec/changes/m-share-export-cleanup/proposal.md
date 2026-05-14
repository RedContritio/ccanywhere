---
status: planned
---

# Proposal: m-share-export-cleanup — 导出过滤 rewind 分支 + 合并 tool 调用到消息底部

## 状态

planned。源自用户 2026-05-15 反馈：

1. share 导出 jsonl → HTML 时未过滤 rewind 跳过的消息，被回滚的对话片段
   仍出现在分享链接里
2. tool_use / tool_result 当前作为独立 `<details>` block 渲染（见
   `archive/2026-05-13-m-share-static-export/`），打散对话节奏。期望：
   tool 调用过程合并到**最近的上一条 user/assistant 消息**中，在该消息
   底部用小字标注 "x tools used"

## Intent

`src/share/render.ts` 解析层 + 渲染层两处改动：

1. **rewind-aware 过滤**：jsonl 行带 `parentUuid` 形成 tree。rewind 后 cc
   会写新分支接到旧 parent，旧的下游行变 dead 分支。cc 同时在 jsonl 里
   写 `{"type":"last-prompt", "leafUuid":"..."}` 行——每次 rewind / 新
   prompt 后追加一条新 last-prompt。**最后一个 last-prompt 的 leafUuid
   就是 active tip**，沿 parentUuid 链回溯到 root 即为 active path，
   dead 分支不渲染。
2. **tool 折叠到上一条消息**：tool_use（assistant role 内） + tool_result
   （cc 写在 synthetic user role）都不再产生独立 message block。改为：
   - tool_use 合并到本条 assistant message 内（保持 details 元素 OR
     完全 inline）
   - tool_result 合并到**前一条** assistant message 内（synthetic user
     role 整条不渲染）
   - 该 assistant message 底部加 small font footer: `{N} tools used`，
     N = 合并进来的 tool_use + tool_result 总数

## 现状（已确认）

- `src/share/render.ts:130-170` 当前 renderUserMessage / renderAssistantMessage
  把 tool_use / tool_result 各自变成独立 `<details>` block
- `src/share/render.ts:179-200` parseJsonl 顺序遍历 jsonl 每行，无
  parentUuid tree 处理 — 包含 dead 分支

## 实施落地点

- `src/share/render.ts`:
  - `parseJsonl` 改为两阶段：
    1. 第一遍构建 `Map<uuid, JsonlRow>` + 找 latest leaf（最新 timestamp
       且无 child reference）
    2. 第二遍从 leaf 回溯 parentUuid 链得到 active uuids set
    3. 仅渲染 active uuids 对应的 rows
  - tool 折叠：
    - assistant message render 时把 tool_use 内联到 message 末尾，但
      `<details>` 默认 collapsed；底部加 `<div class="tools-footer">N
      tools used</div>`
    - user role 若 content 仅含 tool_result（无 text）→ 整条不输出，把
      tool_result 队列附加到上一条 assistant message
    - user role 若 content 混含 text + tool_result → 拆开：text 进新
      user message，tool_result 队列附加到上一条 assistant
- `src/share/render-assets.ts`: 加 `.tools-footer` 样式（小字 muted）
- `src/share/render.test.ts`: 新增 case
  - rewind: 构造 dead 分支 jsonl，断言只渲染 active path
  - tool 折叠: assistant 含 2 个 tool_use 渲染应只产生 1 个 message block
    + footer "2 tools used"
  - tool_result 合并到前 assistant: 不出现 standalone user-role tool
    result block

## 形式化保证

- **active path 完整性**：active uuids set 从最新 leaf 沿 parentUuid 一直
  回溯到 root；rewind 之后的 dead 分支永远不出现在输出
- **顺序保持**：active path 内部按 jsonl 原始顺序渲染（即 timestamp 升序，
  parentUuid tree 是单链，无歧义）
- **tool footer 计数**：N tools used 的 N = 该 assistant message 实际触
  发的 tool_use 数 + 后续 synthetic user 内的 tool_result 数（成对计数
  一次，避免重复——决策点 D1）

## 决策点（已定 2026-05-15）

- **D1 = 去重**. tools used 计数按 tool_use_id pair 计 1（同一 tool 不
  双计 use + result）
- **D2 = 保留 details**. tool_use / tool_result 默认 collapsed，接收方可
  点开看 input / result，不打扰对话节奏
- **D3 = last-prompt.leafUuid 回溯**. 真实 jsonl sample 显示 cc 自己
  写 `{"type":"last-prompt", "leafUuid":"...", ...}` 行，每次 rewind /
  新 prompt 后追加一行新 last-prompt 行。**最后一个 last-prompt 行的
  `leafUuid` 就是 active tip**，沿 parentUuid 链回溯到 root 即为 active
  path。fixture sample: `~/.claude/projects/.../56b957d7-...jsonl`（含
  13 个 last-prompt 行，明确的 rewind 记录）

## 范围（估）

~80-130 LOC + 测试 ~35 LOC：

- render.ts parseJsonl 重构（~50-80）
- render.ts 渲染 tool 折叠 + footer（~30-50）
- render-assets.ts CSS（~5）
- render.test.ts new cases（~35）

## 不做

- **cc 客户端那边的 rewind 元数据扩充** — 完全依赖现有 jsonl parentUuid
  字段（cc 已有），不要求 cc 改格式
- **支持用户自行选择"是否在 share 里隐藏 tool"** — 始终折叠 + footer
  计数，不加配置
- **rewind 之外的"分支选择"** — cc 通常单一分支，不支持显示多分支选择
  器
- **多 leaf 决议**（如果 jsonl 中真的有多 leaf 同时存在）— 先用 latest
  timestamp，未来如出现混乱再处理

## 关联

- 出处：用户 2026-05-15 反馈
- 依赖：`archive/2026-05-13-m-share-static-export/` 已 ship 的 v1
- spec delta：`openspec/specs/share/spec.md` 加 Requirement "导出仅含
  active path" + "tool 调用合并展示"
