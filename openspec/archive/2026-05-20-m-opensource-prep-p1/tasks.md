# Tasks: m-opensource-prep-p1

## C1. README 重写 (含 badges, D1.A + D5)

- [x] T1.1 删 "## 状态 M1-M7 全部就绪" 段
- [x] T1.2 加 "## 跟同类的差异" 段 (4 行表格: ttyd / Tailscale+SSH /
      VSCode tunnel / ccanywhere)
- [x] T1.3 加 "## 安全模型" 段 (WebAuthn pairing + 单用户单服务 +
      不污染 cc 配置 + frpc TLS 终结在 mac)
- [x] T1.4 加 3 个 badges (License Apache-2.0 / Node >=20 / CI ci.yml)
- [x] T1.5 保留 L26+ Quick start / 关键文件 / 测试 / 文档 / 设计原则
      / License 段
- [x] T1.6 验证: pnpm lint:md 过. wc -l 139 (原 124 → +15)
- [x] T1.7 commit C1 — `65070eb`

## C2 + C3. CONTRIBUTING.md (D2.A) + SECURITY.md (D3.A) — 合并 commit

合并理由: CONTRIBUTING 引用 SECURITY (安全报告 channel section),
分开 commit 之间会出现 broken link window. 一笔 ship 避免.

- [x] T2.1 新建 CONTRIBUTING.md (OpenSpec 流程 + dev setup +
      commit 风格, ~105 行)
- [x] T2.2 README "## License" 节之前加 "## Contributing" 链接
- [x] T3.1 新建 SECURITY.md (GitHub Private Security Advisory channel
      + in/out of scope + disclosure timeline + acknowledgment)
- [x] T3.2 README "## License" 节之前加 "## Security" 链接
- [x] T2.3/T3.3 验证: pnpm lint:md 过
- [x] T2.4/T3.4 commit C2+C3 — `5d1789f`

## C4. commit-msg hook 放宽 (D4.A warning 模式)

- [x] T4.1 `.husky/commit-msg`:`exit 1` 改 不 exit (掉到末尾的
      `exit 0`). 输出消息从 "ERROR" 改为 "WARNING" + 重写文案说明
      "convention expects ... a maintainer will likely ask at review
      time". 顶部注释从 "No bypass" 改为 "warning mode" 解释为何
      不 block.
- [x] T4.2 验证: 代码 review — hook 仍 detect CODE_CHANGED > 0 &&
      SPEC_CHANGED == 0, 但不再 exit 1, fallthrough 到 末尾 exit 0.
      exec bit 保留 (chmod +x). 实际 src-only commit 等下次自然发生
      时观察 warning output (本 commit 改 .husky/, 不 trigger hook).
- [x] T4.3 CONTRIBUTING.md 已在 C2 同笔 commit 里描述了 "当前 warning
      模式", 跟 C4 hook 行为对齐 (broken-state window 0).
- [x] T4.4 commit C4 — `ea77bea`

## C5. Issue / PR templates (D6)

- [x] T5.1 `.github/ISSUE_TEMPLATE/bug.yml` — YAML form: ccanywhere
      version / macOS version / Node version / 复现步骤 / 期望 vs 实际
      / 日志 (`~/.config/ccanywhere/server.log`) / 其他上下文. 顶部
      markdown 提示安全问题走 Advisory 不开 public issue.
- [x] T5.2 `.github/ISSUE_TEMPLATE/feature.yml` — 场景 / 期望行为 /
      替代方案 / 额外上下文. 顶部提示 ccanywhere 设计边界 (单用户
      单服务, multi-tenant 不考虑).
- [x] T5.3 `.github/ISSUE_TEMPLATE/config.yml` — `blank_issues_enabled:
      false` + 2 个 contact_links (Security Advisory / Discussions).
- [x] T5.4 `.github/pull_request_template.md` — 描述 / OpenSpec
      reference (proposal.md link) / 改动类型 5 选 / 验证 checklist
      (typecheck + lint + lint:md + test + 测试覆盖) / 关联 issue.
- [x] T5.5 验证: pnpm lint:md 过
- [x] T5.6 commit C5 — `3f1b60f`

## C6. docs/deployment-frpc.md DNS provider 通用化 (D7)

- [x] T6.1 重写 B.3 申请证书段:
      - 顶部新增 DNS provider 总览 (Cloudflare / 阿里云 / 腾讯云 /
        Route53 + acme.sh 完整列表 link, 每 plugin 自己 env 变量
        见 wiki)
      - 明确说脚本默认腾讯云仅作 example, 换 provider 改脚本一处
        + 改 export 凭证
      - 加 Cloudflare 示例对比腾讯云示例 (显示如何切 plugin)
      - 例子 export 命令更新含 CCANYWHERE_ACME_EMAIL (跟 C2
        cert-issue.sh 删默认值 对齐)
      - 删除原 L103-105 后置的"不是腾讯云"段 (内容已 promoted
        to top)
- [x] T6.2 验证: pnpm lint:md 过. 腾讯云 references 仅作为 example
      留在新段内.
- [x] T6.3 commit C6 — `284391e`

## C7. e2e workflow README 注明 (D8)

- [x] T7.1 README "## 测试" 段:
      - 3 行 bash 注释删过时数字 (113 / 33 / 4) 改通用描述
      - 段后加一段 self-hosted only 说明 (vars.E2E_ENABLED gate +
        runner labels + 外部 fork 默认不跑, 引用 e2e.yml workflow)
- [x] T7.2 验证: pnpm lint:md 过
- [x] T7.3 commit C7 — `12ecc73`

## C8. Ship

- [x] T8.1 形式化保证最终验证: typecheck + lint + lint:md 全过.
      grep "redcontritio|recoco" 在 CONTRIBUTING/SECURITY/.github/ 0
      命中. grep README 内部进度词 (M1-M7 / 148 个测试 / 113 单测 /
      33 单测 / 4 个 playwright) 0 leftover. hook 代码 review: warning
      模式 (不 exit 1, fallthrough exit 0).
- [x] T8.2 mv openspec/changes/m-opensource-prep-p1 →
      openspec/archive/2026-05-20-m-opensource-prep-p1
- [x] T8.3 commit C8 archive + 6 笔 hash 回填 (T1.7 65070eb / T2.4-T3.4
      合并 5d1789f / T4.4 ea77bea / T5.6 3f1b60f / T6.3 284391e / T7.3
      12ecc73)
