# ccanywhere OpenSpec

本目录是 ccanywhere 的**契约存档**。`src/` 下的代码必须与本目录中的 spec 一致；
若不一致，要么改代码，要么改 spec——绝不能放任两边漂移。

## 目录结构

```
openspec/
├── AGENTS.md            ← 给 AI agent 的工作约定
├── README.md            ← 本文件
├── specs/               ← 当前生效的契约
│   ├── config/spec.md
│   ├── auth/spec.md
│   ├── sessions/spec.md
│   ├── rest-api/spec.md
│   ├── ws-protocol/spec.md
│   ├── hooks/spec.md
│   └── history/spec.md
├── changes/             ← 进行中的变更提案（一个变更一个目录）
│   └── <change-name>/
│       ├── proposal.md
│       ├── design.md
│       ├── tasks.md
│       └── specs/       ← delta spec（ADDED/MODIFIED/REMOVED Requirements）
└── archive/             ← 已应用的变更归档
    └── YYYY-MM-DD-<change-name>/
```

## 工作流

1. **提案（Propose）**：在 `changes/<short-kebab-name>/` 下创建 `proposal.md`
   （为什么 + 范围 + 思路）、`design.md`（技术决策）、`tasks.md`（实现清单）、
   `specs/` 子目录（针对现有 `openspec/specs/` 的 delta 描述）。
2. **实现（Implement）**：按 `tasks.md` 推进，代码与 delta 对齐。
3. **归档（Archive）**：上线后把 delta 合并进 `openspec/specs/`，把变更目录移到
   `archive/YYYY-MM-DD-<name>/`。

## Spec 文件格式

`openspec/specs/<capability>/spec.md` 用以下结构：

```markdown
# <能力名称>

## Purpose

<一段话：这个能力是什么、为什么存在>

## Requirements

### Requirement: <名称>

<纯文字描述；规范性陈述用 MUST / SHALL / MAY>

#### Scenario: <名称>

- GIVEN <前置条件>
- WHEN  <动作>
- THEN  <可观察结果>
```

`changes/<name>/specs/<capability>/spec.md` 用 delta 格式：

```markdown
## ADDED Requirements
### Requirement: <新增需求>
...

## MODIFIED Requirements
### Requirement: <已有需求>
<新文字>
(Previously: <旧文字>)

## REMOVED Requirements
### Requirement: <名称>
(<移除原因>)
```

## 真相优先级

当代码、测试、spec 三者不一致时：

1. **Spec** 描述契约。**测试**验证契约。**代码**实现契约。
2. 测试通过但与 spec 矛盾 → 测试错（spec 优先）。
3. spec 错 → 先写变更提案，不要悄悄改代码。
4. 只有 `archive/` 允许与 `src/` 不同步；`specs/` 必须始终反映当前事实。

## 关键字保留英文的约定

- OpenSpec 关键字：`Requirement`、`Scenario`、`GIVEN`、`WHEN`、`THEN`、
  `ADDED`/`MODIFIED`/`REMOVED Requirements`、`MUST`/`SHALL`/`MAY`
- 代码标识符、HTTP 字段名、状态值（如 `idle`、`busy`、`dead`）、错误 code
  （如 `invalid_resume`）、HTTP 状态码

其余描述性内容一律使用中文。
