# Tasks: m-touch-scroll-one-line (planned)

## Phase 1: trace（~20 LOC）

- [ ] T1. terminal-touch.ts touchmove 加 ops-log `touch.scroll.tick`
- [ ] T2. stall reset 路径加 `touch.stall.reset`
- [ ] T3. 状态机切换加 `touch.mode.transition`
- [ ] T4. 单测 helpers (mock cellHeight / time) 验 ops 字段

## Phase 2: 用户复现（等数据）

- [ ] T5. 用户触发"只滑一行" + 反馈
- [ ] T6. feedback show 看 ops 序列 → 定 root cause 假设 A/B/C/D

## Phase 3: 修（依赖 Phase 2，~30 LOC）

- [ ] T7. 按假设改对应路径
- [ ] T8. 单测覆盖边界
- [ ] T9. dogfood 验证不再发生
- [ ] T10. spec delta terminal.spec.md "触摸滚动" Requirement 补
- [ ] T11. archive
