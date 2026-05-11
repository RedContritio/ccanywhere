# Tasks: m-share-static-export (planned-v1+)

启动 v1 share 时补完此 task list。当前仅占位。

## Phase 1: 服务端 renderer + REST endpoints

- [ ] T1. `src/share/render.ts` jsonl→HTML programmatic renderer
- [ ] T2. share store（持久化 share-code → sessionId + ttl）
- [ ] T3. POST /api/share/<sessionId>（owner / limited 权限规则待定）
- [ ] T4. GET /share/<code> 公开路由（无鉴权层）
- [ ] T5. caching headers（Cache-Control long max-age + immutable）
- [ ] T6. 服务端 sweeper 过期清理

## Phase 2: 前端 dialog + list + view

- [ ] T7. session 上下文菜单加 "Share" 入口
- [ ] T8. share-create-dialog（范围 / TTL 选择）
- [ ] T9. share-list 视图（管理已创建）
- [ ] T10. share-view 页面（公开 URL 渲染）

## Phase 3: spec + 测试 + 归档

- [ ] T11. `openspec/specs/share/spec.md` 新建
- [ ] T12. rest-api/spec.md 加 share endpoints Requirement
- [ ] T13. server tests + e2e
- [ ] T14. archive
