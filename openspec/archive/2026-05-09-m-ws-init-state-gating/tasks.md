# Tasks: M-ws-init-state-gating

## 实施

- [ ] T1. `src/ws/server.ts` `SessionBundle` 接口加
  `pendingClients: Map<WebSocket, ServerFrame[]>`。
- [ ] T2. 实现 `deliver(bundle, c, frame)` 包装：pending 期间 push queue，
  否则 sendFrame；data/status listener 内的 `for (const c of bundle.clients)
  sendFrame(c, frame)` 改为 `deliver(c, frame)`。
- [ ] T3. ws upgrade handler 内：`bundle.clients.add(sock)` 同时
  `bundle.pendingClients.set(sock, [])`。
- [ ] T4. `sendInitialState` 末尾 drain：先 `pendingClients.delete(sock)`
  再遍历 queue，按 `frame.type === 'output' && frame.seq <= snapshotUpToSeq`
  drop output、`frame.type === 'status'` drop status，剩余 sendFrame。
- [ ] T5. `sock.on('close')` 加 `bundle.pendingClients.delete(sock)`。
- [ ] T6. `teardown(bundle)` 清空 pendingClients map（与 clients set 一并 clear）。

## 测试

- [ ] T7. `src/ws/server.test.ts` 加 test: connect 后立即从 PTY 灌大量 data
  （`yes` 命令或长 echo），验证 client 收到的第一帧 type 是 'snapshot'，
  期间不会出现 type='output' 抢先。helper：sock.on('message') 把全部 frame
  按到达顺序记录，断言 `frames[0].type === 'snapshot'`。
- [ ] T8. 加 test: 多 client 场景下，client B 在 client A 已经 active 后才
  connect，B 仍走 gate 路径——A 收到的实时 output 不被 B 的 gate 影响，
  B 的第一帧仍是 snapshot。
- [ ] T9. 加 test: connect 后立即 close（不发 resize），验证 sendInitialState
  最终（1.5s 兜底）跑完不抛异常 / 不残留 pendingClients entry。

## 验证

- [ ] T10. `pnpm tsc --noEmit` 干净。
- [ ] T11. `pnpm vitest run src/ws/server.test.ts` 全绿，含新 3 个 case。
- [ ] T12. `pnpm vitest run` 整套绿（防止 regression）。

## Spec delta

- [ ] T13. `specs/ws-protocol/spec.md` 加 Requirement "initial-state gating"，
  含 4 scenarios（snapshot 是第一 broadcast 帧 / 中途 close 不残留 /
  多 client 独立 gate / pre-snapshot status 被 drain 丢）。

## 应用 spec delta

- [ ] T14. 把 T13 delta 合并到 `openspec/specs/ws-protocol/spec.md`。

## 归档

- [ ] T15. `mv openspec/changes/m-ws-init-state-gating openspec/archive/<date>-m-ws-init-state-gating`。
- [ ] T16. 用户确认后 commit。
