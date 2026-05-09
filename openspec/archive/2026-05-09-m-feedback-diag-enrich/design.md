# Design: M-feedback-diag-enrich

## diag 数据结构

落盘 record 的新字段（在现有 `id`/`submittedAt`/`title`/`body`/`ops` 之外）：

```ts
interface FeedbackRecord {
  // ... 现有字段 ...

  // 客户端自动收集，请求 body 带过来：
  diag?: {
    activeSessionId?: string;
    // viewport
    viewport?: {
      cols?: number; rows?: number;     // xterm
      windowW: number; windowH: number;  // window.innerWidth/Height
      devicePixelRatio: number;
      orientation?: string;              // 'portrait-primary' | 'landscape-...'
    };
    // 网络
    net?: {
      online: boolean;
      effectiveType?: string;            // '4g' | '3g' | 'slow-2g' | ...
      downlink?: number;                 // Mbps
    };
    // 应用层
    app?: {
      activeSessionId?: string;
      sessionIds?: string[];
      theme?: string;                    // 'auto' / 'light' / 'dark'
      effectiveTheme?: string;           // 'light' / 'dark'
    };
    // ws 状态
    ws?: {
      readyState?: number;               // 0/1/2/3
      lastSeq?: number;
      retryIdx?: number;
      lastFrameTs?: number;              // epoch-ms
      lastFrameType?: string;            // 'snapshot' | 'output' | ...
      sinceLastFrameMs?: number;         // ts now - lastFrameTs
    };
    // 终端
    term?: {
      rendererKind?: string;             // 'dom' | 'canvas' | 'webgl'
      lastWriteTs?: number;
      // 行级纯文本，可见区 + 上方 ~20 行 scrollback
      screen?: string[];
    };
    // 内存（best-effort，仅 Chrome）
    memory?: {
      jsHeapSizeLimit?: number;
      totalJSHeapSize?: number;
      usedJSHeapSize?: number;
    };
  };

  // 服务端注入：
  serverSession?: {
    state: 'starting' | 'idle' | 'busy' | 'dead';
    headSeq: number;
    tailSeq: number;
    scrollbackBytes: number;
    lastDataAt: number | null;          // epoch-ms
    exitCode: number | null;
    deletedAt: number | null;
  };
  serverInfo?: {
    commitSha: string;
    uptimeMs: number;
  };
}
```

Optional 字段全部用 `?` 而不是 fallback 默认值——缺失即未收集（如非
Chrome 的 memory，或 `connection` API 不可用），不要用 0 / null 制造
"看似收到但实际为零"的假象。

## 客户端 diag 收集模块

新文件 `web/src/state/diag.ts`：

```ts
import type { Terminal } from '@xterm/xterm';
import type { TerminalSocket } from '../ws.js';

interface ActiveSlot {
  term: Terminal;
  ws: TerminalSocket;
  sessionId: string;
}

let active: ActiveSlot | null = null;

export function setActiveTerm(slot: ActiveSlot | null): void {
  active = slot;
}

export function collectDiag(extra: { allSessionIds?: string[]; theme?: string;
  effectiveTheme?: string }): Diag {
  // 收集 viewport / net / memory（无 active 也能收）
  // 若 active 非 null，再补 term/ws 部分
  ...
}
```

`setActiveTerm` 在 `terminal.tsx` 的 mount/unmount 调用。`collectDiag`
被 `feedback-dialog.tsx` 的 submit 与 `error-boundary.tsx` 的 submit
调用。`extra` 提供组件外部可拿但 diag 模块拿不到的 app 层信息（theme 等）。

## term.screen 收集

```ts
function captureScreen(term: Terminal, scrollbackRows: number = 20): string[] {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.viewportY - scrollbackRows);
  const end = buf.viewportY + term.rows;
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}
```

可见区 + 上方 20 行（如有 scrollback）。`translateToString(true)` 是
trimRight，去末尾空白让 JSON 体积可控。

## ws diag 暴露

`web/src/ws.ts` 加 `getDiag()`：

```ts
public getDiag(): { readyState: number; lastSeq: number; retryIdx: number;
  lastFrameTs: number; lastFrameType: string } {
  return {
    readyState: this.ws?.readyState ?? 3,  // CLOSED
    lastSeq: this.lastSeq,
    retryIdx: this.retryIdx,
    lastFrameTs: this.lastFrameTs,
    lastFrameType: this.lastFrameType,
  };
}
```

`lastFrameTs` / `lastFrameType` 是新字段，在 `dispatch(frame)` 入口更新。

## 服务端 inject

`registerFeedbackRoutes(app, manager)` 签名加 manager。body 解析后：

```ts
const activeSessionId = parsed.data.diag?.activeSessionId;
const session = activeSessionId ? manager.get(activeSessionId) : undefined;
const serverSession = session ? {
  state: session.state,
  headSeq: session.scrollback.headSeq,
  tailSeq: session.scrollback.tailSeq,
  scrollbackBytes: session.scrollback.bytes,
  lastDataAt: session.lastDataAt ?? null,  // 见下
  exitCode: session.exitCode ?? null,       // 见下
  deletedAt: session.info.deletedAt,
} : undefined;
const serverInfo = {
  commitSha: getCommitSha(),
  uptimeMs: Date.now() - serverStartedAt,
};
```

`Session` interface 需要暴露 `lastDataAt` 与 `exitCode`（当前 SessionImpl
内部已知，但没暴露 getter——本 change 加）。manager 不命中（session
被 GC 回收 / 客户端记错 id）时 serverSession 为 undefined，反馈仍正常落盘。

## commit sha 解析

新 `src/server/version.ts`：

```ts
let cached: string | null = null;
export function getCommitSha(): string {
  if (cached !== null) return cached;
  if (process.env.GIT_SHA) return (cached = process.env.GIT_SHA.slice(0, 12));
  try {
    cached = execSync('git rev-parse HEAD', { cwd: ... }).toString().trim().slice(0, 12);
    return cached;
  } catch {
    return (cached = 'unknown');
  }
}
```

启动时调一次缓存即可；运行期不会变。

## 隐私边界

term.screen 是用户终端的可见字符内容——**这就是反馈现场**——必然能看到。
但它属于"用户主动选择反馈时主动接受披露"——dialog 应在提示文字里说明
"提交时附最近 50 条操作记录与当前终端可见内容"，让用户在敏感场景下
（如显示着 secret key）主动取消。

落盘 mode 0600 已经存在；diag 与 record 同生命周期，不另写文件。

## 测试策略

- 客户端单元：`collectDiag` 的字段存在性测试（mock active slot + mock
  navigator/window 字段）。
- 服务端单元：`POST /api/feedback` 带 `diag.activeSessionId` 命中 manager
  时落盘含 `serverSession`；不命中时 `serverSession` 为 undefined。
- e2e：触发一次反馈，读落盘 JSON 验证字段齐全。
