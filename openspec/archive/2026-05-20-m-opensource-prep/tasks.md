# Tasks: m-opensource-prep

## C1. License + package.json metadata + README license 段(已落,待 commit)

- [x] T1.1 `LICENSE` — Apache-2.0 canonical 文本(curl from apache.org,
      SHA-256 verified)+ 末尾 `Copyright 2026 RedContritio`
- [x] T1.2 `package.json` — 删 `private: true`,加 `license` /
      `author` / `repository` / `bugs` / `homepage`
- [x] T1.3 `README.md` — License 段从「(待补)」改成 Apache-2.0 + LICENSE 链接
- [x] T1.4 commit C1 — `1676b85`

## C2. cert-issue.sh 删默认值(D1)

- [x] T2.1 `scripts/cert-issue.sh:13-14` — 删 `${CCANYWHERE_DOMAIN:-cc.recoco.xyz}`
      / `${CCANYWHERE_ACME_EMAIL:-redcontritio@gmail.com}` 默认值
- [x] T2.2 加未 export 时 exit 2 + 错误信息"export
      CCANYWHERE_DOMAIN / CCANYWHERE_ACME_EMAIL"
- [x] T2.3 验证: `bash -n` 语法 OK + grep 确认默认值 0 命中(静态替代
      `unset` 跑 — 实际跑会撞外部 API)
- [x] T2.4 commit C2 — `ac51da8`

## C3. e2e fallback throw(D2)

- [x] T3.1 `web/playwright.config.ts:19` — `?? 'https://cc.recoco.xyz'`
      改 const + if undefined throw
- [x] T3.2 `web/e2e/smoke.spec.ts:76` — 同上(test fn 内 throw)
- [x] T3.3 `web/e2e/global-setup.ts:165` — `config.webOrigin` 同款 throw
- [x] T3.4 `web/e2e/smoke.spec.ts:4` 注释 → "Smoke against prod ccanywhere
      instance (URL via CCANYWHERE_TEST_URL)"
- [x] T3.5 `web/e2e/global-setup.ts:23` 注释 → "from your ccanywhere
      config.webOrigin"
- [x] T3.6 验证: `pnpm typecheck:all` + `pnpm lint` 过. grep recoco.xyz /
      redcontritio 在 web/ 树 0 命中.
- [x] T3.7 commit C3 — `7fe00aa`

## C4. loader.test.ts 用 os.tmpdir()(D3)

- [x] T4.1 `src/config/loader.test.ts:121,124` — `/Users/redcontritio/Projects`
      改 `join(tmpdir(), 'projects')` (tmpdir/join 已 import,新增本地
      `ownerWorkspace` 变量供 write + assertion 复用)
- [x] T4.2 验证: `pnpm test --run src/config/loader.test.ts` 20/20 全过
- [x] T4.3 commit C4 — `ee9b862`

## C5. README 拓扑图(D4)

- [x] T5.1 `README.md:9` 拓扑图 `recoco.xyz` → `cc.example.com`
- [x] T5.1b 顺手修图标注:`cc.example.com` 标 DNS,`frpc on host` 下方
      加 "TLS 终结 + cert (acme.sh on mac)" — 原图把域名标在 frps
      下方暗示 cert 在 frps,跟实际 (frpc 持 cert via https2http plugin)
      不符
- [x] T5.2 验证: `pnpm lint:md` 过
- [x] T5.3 commit C5 — `9b445d6`

## C6. CLAUDE.md 移出仓库(D5,改自原 "删私域三节")

- [x] T6.1 `git rm --cached CLAUDE.md` — 从 git index 删,working tree
      保留(139 行原版仍在文件系统)
- [x] T6.2 `.gitignore` append `CLAUDE.md` + 注释说明(本地副本 user 自己
      管,可放 `~/.claude/projects/<encoded-cwd>/CLAUDE.md` 让 claude
      code per-project 自动加载)
- [x] T6.3 验证: `git status` 显示 `D CLAUDE.md` + `M .gitignore`,
      `ls CLAUDE.md` 仍在 + `wc -l CLAUDE.md` 仍是 139 行
- [x] T6.4 commit C6 — `77bfdf1`

## C6b. CLAUDE.template.md (脱敏副本,user follow-up)

user 在 C6 之后补建议:"对应的,我们可以给一个 CLAUDE.template.md,
将数据脱敏后放一份".

- [x] T6b.1 `cp CLAUDE.md CLAUDE.template.md`
- [x] T6b.2 脱敏:launchd label `com.redcontritio.ccanywhere` →
      `com.<you>.ccanywhere` (本文件唯一私域引用)
- [x] T6b.3 顶部加 header 提示模板用法(cp 到本地 CLAUDE.md 或
      `~/.claude/projects/<encoded-cwd>/CLAUDE.md`)
- [x] T6b.4 验证: grep redcontritio/recoco 在 CLAUDE.template.md 0
      命中, `pnpm lint:md` 过. .gitignore 是精确匹配 `CLAUDE.md`,
      不影响 template 入仓库
- [x] T6b.5 commit C6b — `5af3a5b`

## C7. archive sed 替换(D6)

- [x] T7.1 `find openspec/archive -name "*.md" -exec sed -i '' -e
      's/recoco\.xyz/example.com/g' -e 's/redcontritio/<you>/g' {} +`
      (合并两个 sed expr 单次 find 跑)
- [x] T7.2 验证: grep -rn 在 openspec/archive 0 命中
- [x] T7.3 `pnpm lint:md` 过
- [x] T7.4 git diff --stat: 6 文件 / 10 替换 (e2e-backbone proposal 2,
      staging-env tasks 1, session-persistence tasks 1, user-symmetric
      proposal 3, auth-routes-split tasks 1, host-credentials-share
      tasks 2)
- [x] T7.5 commit C7 — `6f63661`

## C8. Ship

- [x] T8.1 形式化保证验证: `git grep -nE "redcontritio|recoco\.xyz"` 命中
      仅出现在本 epic 的 changes/proposal.md + changes/tasks.md (描述
      脱敏决策本身), src/web/scripts/docs/examples/README/CLAUDE.template
      0 leftover. archive 已 C7 清扫.
- [x] T8.2 `git grep -nE "/Users/[a-z]"` 命中均为 placeholder username
      (`me`/`you`/`foo`/`test`), 不指向具体 user. 符合 D 决策原则.
- [x] T8.3 `mv openspec/changes/m-opensource-prep
      openspec/archive/2026-05-20-m-opensource-prep`
- [x] T8.4 commit C8 archive + 前 8 笔 hash 回填 (T1.4 1676b85 / T2.4
      ac51da8 / T3.7 7fe00aa / T4.3 ee9b862 / T5.3 9b445d6 / T6.4
      77bfdf1 / T6b.5 5af3a5b / T7.5 6f63661)
