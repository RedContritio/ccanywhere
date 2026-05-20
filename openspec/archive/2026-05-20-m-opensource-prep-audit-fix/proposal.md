# Proposal: m-opensource-prep-audit-fix — post-ship audit 发现的占位符风格 cleanup

## Intent

m-opensource-prep ship 后 user 触发 subagent 独立审计脱敏完整性。报告
"开源阻断 0 / 中度 1 / 低度 1",其他维度全 clean。本 change 修两点。

## 已落 (sed 替换)

- **中度** `docs/deployment.md:53` `# /Users/you/.local/bin/claude` 注释
  里 `you` 裸名 → `<you>` 占位风格 (跟 README:49 / examples/config.json
  / 其他 docs 一致)
- **低度** 5 处 `ccanywhere.example.com` 统一改 `cc.example.com`:
  - `README.md:47` (config 配置示例)
  - `docs/deployment.md:42` (config 字段表)
  - `examples/config.json:8` (webOrigin 默认值)
  - `openspec/specs/config/spec.md:184` (spec 字段 example)
  
  统一原因: examples/frpc.toml + docs/deployment-frpc.md 用 `cc.<your-domain>`
  / `cc.example.com`. 之前 webOrigin 例子用 `ccanywhere.example.com`,
  user 跟 README 配完之后看 frpc 模板会撞两种命名 — 现在统一为
  `cc.example.com`. 外部用户跟 quick-start 走完到 frpc 配置时占位符
  semantic 一致.

## 决策

- **D1**: 选 `cc.example.com` 不选 `ccanywhere.example.com` — frpc
  模板已经写 `cc.<your-domain>` (拓扑里 `cc.` 是惯例短前缀, 域名节省
  字符), README 改对齐 frpc 比 frpc 改对齐 README 影响面小.
- **D2**: 不动 archive 历史里的域名 reference — archive 是历史快照,
  不为风格 retrospectively 改写.

## 形式化保证

- `grep -rn "ccanywhere\.example\.com"` 在 src/web/docs/examples/specs
  + README 范围 0 命中 (archive 不动)
- `grep -rn "/Users/you/"` 0 命中 (只剩 `/Users/<you>/`)
- `pnpm lint:md` 过

## Phases

- **C1** (已落, 待 commit): sed 两组替换 + 验证 + spec delta (config
  spec.md webOrigin 例子值)
- **C2**: archive + hash 回填

## 不做

- archive 历史 retrospective 域名 update — 见 D2
- 其他 README 重写 (P1)
