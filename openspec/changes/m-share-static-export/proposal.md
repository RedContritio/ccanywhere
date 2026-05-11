---
status: planned-v1+
---

# Proposal: m-share-static-export — programmatic session 静态 HTML 导出

## 状态

**v1+ deferred**。源自 m-multi-user proposal §Share 段（cc 子进程 LLM
渲染 HTML 方案被风险评审否决；programmatic 路径作为 v1 实施目标）。
当前没启动；本 proposal 是占位 stub，启动 v1 时补完决策 + 落地细节。

## Intent（粗框）

用户在 web 端把某次 cc session 的对话历史（jsonl）导出成静态 HTML 公开
URL，与 user / device / token 鉴权层**完全解耦**，可分享给未登录的访问
者查看。

## 范围（粗估）

约 600 LOC，含：

- 服务端 `src/share/render.ts` programmatic jsonl→HTML renderer（按 cc
  message format 解析 user/assistant/tool 三类 entry，渲染 markdown +
  code block + tool call summary，主题切换 light/dark）
- REST: `POST /api/share/<sessionId>` 颁短码 + `GET /share/<code>` 公开
  访问（无鉴权层）+ caching headers（公开 URL 长 cacheable）
- 服务端 sweeper（过期 share 清理；ttl 配置项）
- 前端 dialog（用户从 session 上下文菜单点 share → 选范围 / TTL → 拿 URL）
- 前端 list view（管理自己创建的 shares）
- 前端 view 页面（用户访问公开 URL 看到的渲染结果；主题切换可保留）
- spec delta: `openspec/specs/share/spec.md` 新建 + `rest-api/spec.md`
  share endpoints 段

## 启动条件

- #44 m-multi-user 已 ship ✓
- m-fit-cols-off-by-one 关闭（不阻塞，但优先级低于 user-facing bug 修复）
- 用户明确说"启动 v1 share"

## 关联

- 上下文出处：`openspec/archive/2026-05-11-m-multi-user/proposal.md`
  §Share + §未来工作
- v0 cc 子进程方案被否决的反向证据见同 archive

## 不做（先标，启动 v1 时再确认）

- cc 子进程 LLM 渲染（v0 砍掉的方案）
- 自定义模板 / 主题（v1 仅默认 light/dark）
- share view 评论 / 互动（始终是 read-only export）
