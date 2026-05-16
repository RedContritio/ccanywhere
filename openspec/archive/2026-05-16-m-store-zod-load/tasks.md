# Tasks: m-store-zod-load

## 决策对齐

- [ ] 仅覆盖 share + registry（不扩 device / user / token / project /
      persist）
- [ ] helper warn 输出含 zod issue 列表

## 实现

- [ ] `src/lib/load-json-record.ts`：通用 helper
      `loadJsonRecord<T>(path: string, schema: z.ZodType<T>): T | undefined`
- [ ] `src/share/store.ts`：
  - 顶端 `const ShareRecordSchema = z.object({...})`
  - `load(code)` 改用 helper
  - `loadAllSync()` 删 :179-189 重复段，走 helper
  - 删 `ShareRecordJson` interface
- [ ] `src/session/registry.ts`：
  - 顶端 `const PersistedRecordSchema = z.object({...})`
  - `loadAllSync()` 改用 helper
  - 删 `PersistedJson` interface

## 测试

- [ ] `src/lib/load-json-record.test.ts`：
  - 不存在文件 → undefined，不 warn
  - JSON 非法 → undefined + warn
  - schema 不通过 → undefined + warn
  - 合法 → typed T
- [ ] 现有 `src/share/store.test.ts` + `src/session/registry.test.ts`
      全过（corrupt fixture 触发的 warn-and-skip 行为不变）

## Spec delta

- [ ] 无 — internal refactor，store API 不变

## Ship

- [ ] typecheck:all + lint + lint:md + test pass
- [ ] build:all + launchctl kickstart + healthz 200
- [ ] commit hash:
