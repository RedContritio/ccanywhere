# Tasks: m-new-session-dialog-steps

## 实现

- [ ] `web/src/components/new-session-step1-picker.tsx`：props
      (`sortedProjects`, `projectId`, `projectAction`, `sortField`,
      `sortDir`, `mode`, `newProjectName`, `newProjectBusy`, `onSelect
      Project`, `onToggleSort`, `onProjectAction`, `onSetNewProjectName`,
      `onSubmitNewProject`, `onModeChange`)。含 sort buttons + list +
      new-project inline + mode tabs
- [ ] `web/src/components/new-session-step2-history.tsx`：props
      (`history`, `resumeId`, `historyLoading`, `onSelectResumeId`)
- [ ] 改 `new-session-dialog.tsx`：
  - 保留 state + reset effect + stale-projectId effect + history-load
    effect + sortedProjects memo + submit handlers
  - form 内 step1 / step2 替换为 `<Step1.../>` / `<Step2.../>`

## 测试

- [ ] step1 picker 单测：smoke render + sort toggle 行为 + 切 mode
- [ ] step2 picker 单测：smoke render + history 选中变化
- [ ] 现有 dialog 测试全过；如缺，补 1 个 "选 project → create" + 1 个
      "选 project → resume → 选 history → create" 集成 case

## Spec delta

- [ ] 无 — 内部 UI refactor

## Ship

- [ ] typecheck:all + lint + lint:md + test pass
- [ ] e2e new-session-dialog 流程 (playwright) 跑通
- [ ] commit hash:
