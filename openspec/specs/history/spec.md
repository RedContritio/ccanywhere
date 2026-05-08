# History

## Purpose

cc 把每次会话都记成 jsonl 写在 `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`。
ccanywhere 读这些文件给前端展示"可 resume 的历史 session"列表，并在
`POST /api/sessions mode=resume` 时校验目标 sessionId 是否真存在过。

## Requirements

### Requirement: 项目 cwd 编码

`encodeProjectCwd(cwd)` MUST 先用 `path.resolve(cwd)` 获得绝对路径，再把每个
`/` 替换为 `-`。这与 cc 自身的命名约定一致——目录名形如 `-Users-foo-bar`。

#### Scenario: 标准编码

- GIVEN cwd `"/Users/foo/proj"`
- WHEN  调用 `encodeProjectCwd(cwd)`
- THEN  返回 `"-Users-foo-proj"`

### Requirement: history 根目录

`defaultHistoryRoot()` MUST 返回 `${HOME}/.claude/projects`。
`listHistory(cwd, historyRoot?)` 接受可选根目录覆盖，便于测试用 tmp 目录注入。

### Requirement: 列举与排序

`listHistory(cwd, root)` MUST：

1. 解析项目目录 `${root}/${encodeProjectCwd(cwd)}`。
2. 若该目录不存在（`ENOENT`），MUST 返回 `[]`，不抛错。其它读错误 MUST 向上抛。
3. 枚举其下所有 `*.jsonl` 文件；非 jsonl 文件 MUST 忽略。
4. 对每个文件提取摘要 `{ sessionId, modifiedAt, preview }`：
   - `sessionId` 是去掉 `.jsonl` 后缀的文件名。
   - `modifiedAt` 是文件 `stat().mtimeMs`。
   - `preview` 是该文件第一条 `type == "user"` 行的 message 文本，截到 200 字符。
5. 按 `modifiedAt` 倒序返回（最新在前）。

#### Scenario: 项目目录不存在

- GIVEN 一个不存在的 cwd 与一个临时 root
- WHEN  调用 `listHistory(cwd, root)`
- THEN  返回 `[]`

#### Scenario: 按 mtime 倒序

- GIVEN 项目目录下两个 jsonl，mtime 一旧一新
- WHEN  调用 `listHistory(cwd, root)`
- THEN  返回数组首项 sessionId 是 mtime 较新的那个

### Requirement: preview 提取

`preview` 必须从该 jsonl 第一条满足 `type == "user"` 的行中取，规则：

- 若 `message.content` 是字符串，preview 是该字符串截到 200 字符。
- 若 `message.content` 是数组，遍历每个元素，找到第一个 `type == "text"`
  的元素，preview 是其 `text` 字段截到 200 字符。
- 若没有 `type == "user"` 行或都不符合上述形状，preview 是空字符串。
- 任何 JSON parse 错误的行 MUST 跳过，不影响后续行解析。

#### Scenario: 字符串 content

- GIVEN 第一行 `{"type":"user","message":{"content":"hello there"}}`
- WHEN  提取 preview
- THEN  得 `"hello there"`

#### Scenario: 数组 content 中的 text part

- GIVEN 第一行 user 的 `content` 数组中混合 `tool_result` 与 `text`
- WHEN  提取 preview
- THEN  取出第一个 `text` part 的内容，忽略其它

#### Scenario: 跳过 assistant 行

- GIVEN jsonl 的第一行是 assistant、第二行才是 user
- WHEN  提取 preview
- THEN  preview 是第二行的内容

#### Scenario: 没有 user 行

- GIVEN jsonl 全是 assistant 行
- WHEN  提取 preview
- THEN  preview 为空字符串

#### Scenario: 容错损坏行

- GIVEN jsonl 第一行是损坏 JSON、第二行是合法的 user 行
- WHEN  提取 preview
- THEN  跳过损坏行，使用第二行的内容
