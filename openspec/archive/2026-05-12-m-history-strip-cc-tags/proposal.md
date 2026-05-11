---
status: archived
date: 2026-05-12
---

# Proposal: m-history-strip-cc-tags — history preview 过滤 cc 内部 system tag

## 状态

已 ship。m-design-system-unify C3 dialog 重写后 user review history
list 视觉时发现 — 很多 preview 是 `<local-command-caveat>Caveat: ...`
开头。这是 cc CLI 内部 system tag（model-facing），不应作 user 看到
的 preview。

## Intent

`src/server/history.ts::readFirstUserMessage` extract preview 时按
**两类**处理 cc tag：
- **unwrap**（保留内部文本）：仅 `<command-name>` —— 反映 user 主动
  slash command 行为（"/clear" "/init" 等）
- **strip**（删整块）：其余 12 个 —— `command-message` /
  `command-args` 与 command-name 冗余；caveat / reminder / stdout /
  stderr / hook / bash-* 是模型面向噪音
若处理后剩余为空，skip 到下条 user line。

## 决策

D1. **仅 unwrap command-name**：初版三个 command-* 都 unwrap 导致
    `<command-name>/clear</...><command-message>clear</...>` →
    "/clear clear"（重复）。user review 后定：仅 command-name 保留
    斜杠命令本身；message/args 与 command-name 冗余，strip。

D2. **command + next user input 拼接**：单 `/clear` 作 preview 信息
    密度低（user 不知道这 session 后续问了啥）。user review 后定：
    收集 leading run of slash commands，拼接 first 非命令真 user 输
    入，用 ` · ` 分隔。例：`/clear · 如何实现 X`、`/clear · /init ·
    do the thing`。无后续真输入则停在最后一个 command（如 session
    被 `/clear` 后未续问）。

D2. **conservative allowlist**：仅 strip/unwrap 已知 cc tag 名（13
    个），不做 generic `<tag>...</tag>` 一刀切。理由：user 自己写
    HTML/markdown（如 `<div>real content</div>`）不应被误删。

D3. **skip 全空 line 找下一条**：若一条 user line 处理后 length ===
    0（纯 noise tag），skip 到下条 user line 找真 preview。理由：
    pure caveat/reminder line 是 cc 自动生成，下一条才是 user 真输入。

D4. **whitespace collapse**：unwrap 时给 tag 替换为 ` $1 `（前后
    加空格防止与外文本粘连），最后 collapse `/\s+/g` → 单空格 +
    trim。处理 `<command-name>/clear</command-name><command-args>
    </command-args>` → "/clear" 类干净输出。

## 形式化保证

F1. CC_UNWRAP_TAGS = 1 个：command-name
    CC_STRIP_TAGS = 12 个：command-message / command-args /
    local-command-caveat / command-stdout / command-stderr /
    local-command-stdout / local-command-stderr / system-reminder /
    user-prompt-submit-hook / bash-input / bash-stdout / bash-stderr

F2. `stripCcSystemTags` exported 可独立 test。9 个单测覆盖 noise-only
    strip / command-name unwrap / command-args unwrap / multi-line
    strip / unknown tag passthrough / 外部 user text 保留 / mixed
    unwrap+strip+text / whitespace collapse / surrounding trim。

F3. 集成 case：
    - `/clear`-only session preview = `/clear`（user 行为可见，无 message
      / args 冗余）
    - noise-only line skip 到下条找 real text
    - leading caveat tag strip 后 inner 真文本被保留

## 落地点

- `src/server/history.ts`：新 `stripCcSystemTags` export +
  `readFirstUserMessage` 改为 strip + skip empty
- `src/server/history.test.ts`：+ 2 集成 case + 6 unit case stripCcSystemTags

## 不做

- 不引入 generic HTML/markdown sanitizer（scope 限定 cc tag）
- 不改 cc CLI 自身行为（cc 用 tag 是 model API 设计需要，不能动）
- 不改 web 端 preview 渲染（server 已 strip，web 直接信任）

## 范围

~30 LOC delta（src/server/history.ts +35 / -8）+ ~85 LOC 新测试。

## 验证

- pnpm typecheck:all ✓
- pnpm test 顶层 301 → 309 pass（+8 new history.test cases）
- pnpm build:all ✓
- launchctl kickstart ccanywhere ✓
- curl /healthz → {"ok":true} ✓
- user 浏览器 reopen new-session resume dialog 验真实 cc session preview
  不再含 `<local-command-caveat>...` 前缀 [user confirm pending]

## 关联

- 触发：m-design-system-unify C3 dialog 重写后视觉 review
- 与 m-design-system-unify 不同 scope（web client vs server）→ 分开
  commit
