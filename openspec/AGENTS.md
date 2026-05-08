# ccanywhere agent 工作约定

给在本仓库工作的 AI 编程助手（Claude Code、Cursor 等）的约定。
开始之前请先阅读 `openspec/README.md` 了解工作流。

## 写代码之前

1. **找到对应的 spec**。任何行为变更都必须落在某个 `openspec/specs/<capability>/spec.md`
   下。如果没有合适的 capability，说明这是新能力——先提案新建 capability，再写代码。
2. **重读 spec，不要凭记忆复述**。spec 通过变更提案演进，磁盘上的文件才是真相。
3. **跨契约的改动必须先提案**。涉及 REST 状态码、WS 帧形状、hook 事件语义、
   config schema 的变更，必须先在 `openspec/changes/<short-kebab-name>/`
   下写提案，不要把契约变更和代码实现塞进同一个 commit。

## 写代码时

- 严格匹配 spec 的 MUST / SHALL。spec 已排除的不可能分支不要写防御代码——那是死代码。
- 新增的 `raise` / `throw` 必须配一个能命中它的测试。
- 不要写复述 spec 的注释。代码不直观时只引用 Requirement 名称即可。

## 完成变更时

1. `changes/<name>/tasks.md` 全部勾掉。
2. 测试通过。
3. **归档**：把 `changes/<name>/specs/` 下每个 delta 合并到对应的
   `openspec/specs/<capability>/spec.md`（MODIFIED 替换、ADDED 追加、REMOVED 删除），
   再把变更目录移到 `archive/YYYY-MM-DD-<name>/`。
4. `openspec/specs/` 是人读"当前行为"的唯一入口，保持精炼。

## 信息归属

| 写在 spec 里 | 写在代码里 | 写在测试里 |
|---|---|---|
| 可观察的外部契约（HTTP 状态码、帧形状、env 变量、文件路径） | 内部数据结构、命名、性能策略 | 每条 Scenario 一个测试；跨 capability 流程的集成测试 |
| 生命周期状态与转换 | 状态机的实现 | 状态转换的覆盖 |
| 错误 envelope 与 code | 错误如何在内部传播 | 每个文档化的错误 code 都能在测试中触达 |

## 风格

- Requirement 用祈使语气（"服务端 MUST..."，不要写"服务端应该..."）。
- Scenario 用 GIVEN / WHEN / THEN 列表，每个 THEN 一行只写一件可观察事。
- 不写"等等"——要么列全要么拆 Requirement。
- Scenario 内不要写超过三行的散文段落。
- 描述性内容一律中文；OpenSpec 关键字、代码标识符、enum 值保留英文。
