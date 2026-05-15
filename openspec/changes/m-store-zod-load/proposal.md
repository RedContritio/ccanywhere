---
status: planned
---

# Proposal: m-store-zod-load — store JSON 加载用 zod schema 替代手写 typeof

## 状态

planned。两处 store 加载 JSON 时手写多字段 typeof 校验，重复 + drift 风险：

- `src/share/store.ts:114-124` (load) 和 `:179-189` (loadAllSync) 写了
  **同一组 5 字段校验两次** — 加新字段必须改两处
- `src/session/registry.ts:155-171` 写 6 字段校验一次

项目已经 dep `zod` (config schema 全用)，但 store 持久化层没用。

## Intent

把两处 `JSON.parse + typeof check` 替换为 `RecordSchema.safeParse`：

- 每个 store 顶端定义 `const RecordSchema = z.object({...})`
- 公共 `loadJsonRecord<T>(path, schema)` helper 吃掉 read + parse + 校验
  + warn-and-skip 样板

## 形式化保证

`loadJsonRecord<T>(path, schema): T | undefined` MUST：

- 文件不存在 → undefined（不 warn — 正常 boot 路径）
- 文件读取失败 (permission / IO) → undefined + warn
- JSON 非法 → undefined + warn (含 path)
- schema 校验失败 → undefined + warn (含 path + zod issue 简化串)
- 合法 → 返回 typed T

## 落地点

- 新建 `src/lib/load-json-record.ts` (~30 LOC)
- 改 `src/share/store.ts`：
  - 顶端定义 `ShareRecordSchema = z.object({...})`
  - `load(code)`：换 `loadJsonRecord(path, ShareRecordSchema)`
  - `loadAllSync()`：每个文件走同一 helper，删 :179-189 重复段
  - 删 `ShareRecordJson` 中间 interface (z.infer 反推)
- 改 `src/session/registry.ts`：
  - 顶端 `PersistedRecordSchema = z.object({...})`
  - `loadAllSync()` 走 helper（screen.txt 单独 readFileSync 不变）
  - 删 `PersistedJson` interface

## 范围

~70 LOC：+30 helper / +20 两 store schema / -50 两处手写 typeof / +1
测试文件

## 决策点（启动前定）

- helper warn 是否输出完整 zod error 列表：默认是（一行 path + issue
  list），定位 corrupt file 哪个字段坏更快
- 扩到 users/tokens/devices/persist/projects 其他 store：**不扩**。
  这些是单字段 `Array.isArray + typeof string` 弱校验，重写 zod ROI 低，
  保持现状

## 不做

- 不重写 DeviceStore (走 persist.ts 单独 helper)
- 不重写 UserStore / TokenStore / ProjectStore
- 不引入 zod migration / schema version 化

## 关联

- 出处：本评审 A2（缩窄范围版）
- 依赖：可与 m-write-queue-extract 并行做
