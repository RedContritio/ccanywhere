---
status: planned
---

# Proposal: m-new-session-dialog-steps — NewSessionDialog 步骤组件拆分

## 状态

planned。`web/src/components/new-session-dialog.tsx` 当前 411 行单组件：

- 9 个 useState (`:51-67`)
- 3 个 useEffect (`:72-86` reset on open / `:90-96` stale projectId /
  `:99-120` load history on step 2)
- 1 个 useMemo (sortedProjects, `:122-131`)
- 200+ 行 JSX 含 step1 (`:263-376`) 嵌套 sort buttons + project list +
  new-project inline form + mode tabs；step2 (`:378-400`) history picker

单文件可读，但 step1 / step2 分支耦合在同一 form 内，加新 step 或改步骤
逻辑都要改大段嵌套。

## Intent

主组件保留 state machine + submit + reset 逻辑，把 step1 / step2 JSX 各
抽一个 props-driven 子组件：

- `<Step1ProjectPicker>` — sortedProjects + projectAction (idle / new) +
  mode (create / resume) UI
- `<Step2HistoryPicker>` — history + resumeId UI

## 形式化保证

子组件 MUST 是受控组件：

- 不持有 state（所有 state 留在父组件）
- 不直接访问 zustand store（projects / history 通过 props 传入）
- 不写 useEffect（reset / history load 在父组件）

## 落地点

- 新建 `web/src/components/new-session-step1-picker.tsx` (~150 LOC)
- 新建 `web/src/components/new-session-step2-history.tsx` (~80 LOC)
- 改 `web/src/components/new-session-dialog.tsx`：减到 ~200 行（state
  + reset + submit + footer 按钮）

## 范围

~120 LOC 主文件减 / +230 新文件 / 净 +110 但分模块。

## 决策点（启动前定）

- 是否一并抽 stepTitle 渲染：当前 5 行三元，**不抽**
- new-project inline form 抽不抽 `<NewProjectInline>`：**不抽**（仅
  ~50 行，与 step1 sort + list UI 紧耦合）
- ProjectSortField / ProjectSortDir / ProjectAction / Step 类型挪到
  哪：picker 内部类型挪 step1 picker 文件，Step 类型留 dialog

## 不做

- 不动 DialogBase / ListBase / SortButton 接口
- 不重新设计 step 流程（仍是 1 → 2 单向）
- 不动 fmtRelative helper

## 关联

- 出处：本评审 B3
- 依赖：无
