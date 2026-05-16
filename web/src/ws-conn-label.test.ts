import { describe, expect, it } from 'vitest';
import { wsConnLabel } from './ws-conn-label.js';

describe('wsConnLabel', () => {
  it('connecting / connected / reconnecting are reason-agnostic', () => {
    expect(wsConnLabel('connecting', null)).toBe('连接中…');
    expect(wsConnLabel('connected', null)).toBe('已连接');
    expect(wsConnLabel('reconnecting', null)).toBe('重连中…');
    // reason carries no meaning before terminal state — even if a stale
    // value lingers, label still reflects the live connection state
    expect(wsConnLabel('connecting', 'session-deleted')).toBe('连接中…');
  });

  it('dead branches by reason', () => {
    expect(wsConnLabel('dead', 'cc-exit')).toBe('会话已结束');
    expect(wsConnLabel('dead', 'session-gone')).toBe('会话不存在');
    expect(wsConnLabel('dead', 'session-deleted')).toBe('已被删除');
  });

  it('dead with null reason falls back to cc-exit copy', () => {
    // Defensive default — if reason got dropped somewhere upstream the
    // chip should still say something useful, not blank.
    expect(wsConnLabel('dead', null)).toBe('会话已结束');
  });

  it('connected + awaitingData=true shows "等待 cc 输出" hint', () => {
    expect(wsConnLabel('connected', null, true)).toBe('已连接，等待 cc 输出…');
  });

  it('connected + awaitingData=false (or omitted) stays plain "已连接"', () => {
    expect(wsConnLabel('connected', null, false)).toBe('已连接');
    expect(wsConnLabel('connected', null)).toBe('已连接');
  });

  it('awaitingData only affects connected — other conn states ignore it', () => {
    expect(wsConnLabel('connecting', null, true)).toBe('连接中…');
    expect(wsConnLabel('reconnecting', null, true)).toBe('重连中…');
    expect(wsConnLabel('dead', 'cc-exit', true)).toBe('会话已结束');
  });
});
