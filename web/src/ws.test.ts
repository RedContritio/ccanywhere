import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSocket, type WebSocketFactory } from './ws.js';

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSED = MockWebSocket.CLOSED;

  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string) {}

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

interface TestRig {
  current: MockWebSocket | null;
  history: MockWebSocket[];
  factory: WebSocketFactory;
}

function makeRig(): TestRig {
  const rig: TestRig = {
    current: null,
    history: [],
    factory: (url: string) => {
      const m = new MockWebSocket(url);
      rig.current = m;
      rig.history.push(m);
      return m as unknown as WebSocket;
    },
  };
  return rig;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'http:', host: 'localhost:5173' },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalSocket', () => {
  it('builds ws URL with sessionId encoded; auth via cookie not query', () => {
    const rig = makeRig();
    new TerminalSocket('a/b 1', {}, rig.factory);
    expect(rig.current?.url).toBe('ws://localhost:5173/ws/sessions/a%2Fb%201');
  });

  it('uses wss:// when location.protocol is https', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'https:', host: 'example.com' },
      configurable: true,
    });
    const rig = makeRig();
    new TerminalSocket('s', {}, rig.factory);
    expect(rig.current?.url.startsWith('wss://example.com/')).toBe(true);
  });

  it('dispatches snapshot/output/status/error frames; ignores pong', () => {
    const rig = makeRig();
    const handlers = {
      onSnapshot: vi.fn(),
      onOutput: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn(),
    };
    new TerminalSocket('s', handlers, rig.factory);
    rig.current!.open();
    rig.current!.receive(JSON.stringify({ type: 'snapshot', upToSeq: 2, data: 'hi' }));
    rig.current!.receive(JSON.stringify({ type: 'output', seq: 7, data: 'world' }));
    rig.current!.receive(JSON.stringify({ type: 'status', state: 'busy' }));
    rig.current!.receive(JSON.stringify({ type: 'error', message: 'oops' }));
    rig.current!.receive(JSON.stringify({ type: 'pong' }));
    expect(handlers.onSnapshot).toHaveBeenCalledWith('hi');
    expect(handlers.onOutput).toHaveBeenCalledWith('world');
    expect(handlers.onStatus).toHaveBeenCalledWith('busy');
    expect(handlers.onError).toHaveBeenCalledWith('oops');
  });

  it('ignores malformed JSON without throwing', () => {
    const rig = makeRig();
    const onError = vi.fn();
    new TerminalSocket('s', { onError }, rig.factory);
    rig.current!.open();
    expect(() => rig.current!.receive('not json')).not.toThrow();
    rig.current!.receive(JSON.stringify({ type: 'output', seq: 10, data: 'still-fine' }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('reconnects with 250ms delay on first close', () => {
    const rig = makeRig();
    const onConnected = vi.fn();
    const onReconnecting = vi.fn();
    new TerminalSocket('s', { onConnected, onReconnecting }, rig.factory);
    rig.current!.open();
    expect(onConnected).toHaveBeenCalledTimes(1);

    rig.current!.close();
    expect(onReconnecting).toHaveBeenCalledTimes(1);
    expect(rig.history).toHaveLength(1);

    vi.advanceTimersByTime(250);
    expect(rig.history).toHaveLength(2);
    rig.current!.open();
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it('escalates backoff up to 8s and stays there', () => {
    const rig = makeRig();
    new TerminalSocket('s', {}, rig.factory);
    const expectedDelays = [250, 500, 1000, 2000, 4000, 8000, 8000];
    for (const delay of expectedDelays) {
      rig.current!.open();
      rig.current!.close();
      vi.advanceTimersByTime(delay);
    }
    // 1 initial + 7 reconnects
    expect(rig.history.length).toBe(8);
  });

  it('stops reconnecting after status=dead', () => {
    const rig = makeRig();
    const onDead = vi.fn();
    const onReconnecting = vi.fn();
    new TerminalSocket('s', { onDead, onReconnecting }, rig.factory);
    rig.current!.open();
    rig.current!.receive(JSON.stringify({ type: 'status', state: 'dead' }));
    expect(onDead).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(10_000);
    expect(rig.history).toHaveLength(1);
    expect(onReconnecting).not.toHaveBeenCalled();
  });

  it('send() routes to ws when OPEN', () => {
    const rig = makeRig();
    const sock = new TerminalSocket('s', {}, rig.factory);
    rig.current!.open();
    sock.send({ type: 'input', data: 'abc' });
    expect(rig.current!.sent).toEqual([JSON.stringify({ type: 'input', data: 'abc' })]);
  });

  it('send() drops when not OPEN', () => {
    const rig = makeRig();
    const sock = new TerminalSocket('s', {}, rig.factory);
    sock.send({ type: 'input', data: 'abc' });
    expect(rig.current!.sent).toHaveLength(0);
  });

  it('close() prevents future reconnects', () => {
    const rig = makeRig();
    const onReconnecting = vi.fn();
    const sock = new TerminalSocket('s', { onReconnecting }, rig.factory);
    rig.current!.open();
    sock.close();
    rig.current!.close();
    vi.advanceTimersByTime(10_000);
    expect(onReconnecting).not.toHaveBeenCalled();
    expect(rig.history).toHaveLength(1);
  });
});
