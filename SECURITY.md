# Security Policy

ccanywhere 暴露本机 cc 会话给浏览器,涉及 WebAuthn 配对 + PTY spawn,
安全漏洞影响面比一般 web 应用大。请负责任地披露。

## Supported versions

ccanywhere 目前是 0.x (单用户单服务 LaunchAgent),没有正式 SLA。
但 `main` 分支应该始终保持安全。

## Reporting a vulnerability

**请不要**在 public issue 报告安全漏洞。

走 GitHub Private Security Advisory:

<https://github.com/RedContritio/ccanywhere/security/advisories/new>

会在仅维护者 + 你能看到的 advisory 里讨论。维护者会:

1. 24-72 小时内 acknowledge
2. 评估 severity (含 CVSS 分数)
3. 跟你一起准备 fix + advisory 文本
4. 协调发布 (security release + public advisory + CVE if applicable)

## In scope

- **认证 / 授权绕过**: WebAuthn pairing 绕过、token 伪造、CSRF
- **PTY 逃逸**: 通过 web 输入触发 ccanywhere 之外的命令执行
- **frpc 链路**: cert 验证、TLS 终结、`hostHeaderRewrite` 误配
- **配额 / 沙箱**: limited user 突破 `guestProjectsRoot` 边界
- **session 接管**: 重连 / Resume 路径下其他设备的状态泄漏

## Out of scope

- 你本机 mac 已经被攻陷 (ccanywhere 默认信任本机 `~/.claude/` + cli-token)
- frps 本身的漏洞 (上游 [frp](https://github.com/fatedier/frp) 项目)
- DNS-01 cert 申请用的第三方 DNS provider 凭证泄漏
- 物理访问 mac 后的攻击

## Disclosure timeline

合理时间内:

- 90 天内修复 + 公开 advisory
- 严重 (CVSS >= 9.0) 优先,力争 30 天内
- 跟报告人协调 disclosure date

## Acknowledgment

负责任披露的 reporter 会在 advisory + release notes 列名 (除非你要求匿名)。
