import { describe, expect, it } from 'vitest';
import { buildHookSettings, type HookEndpoint } from './hooks.js';

const ep: HookEndpoint = {
  host: '127.0.0.1',
  port: 62275,
  internalToken: 'h'.repeat(32),
};

describe('buildHookSettings', () => {
  it('emits a hooks object covering all known events', () => {
    const settings = buildHookSettings('sess-1', ep);
    const events = Object.keys(settings.hooks);
    expect(events).toEqual(
      expect.arrayContaining([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Notification',
        'Stop',
        'SubagentStop',
      ]),
    );
  });

  it('embeds sessionId, internalToken, and event name in the curl command', () => {
    const settings = buildHookSettings('abc-123', ep);
    const stop = settings.hooks['Stop']?.[0]?.hooks[0]?.command ?? '';
    expect(stop).toContain('abc-123');
    expect(stop).toContain(ep.internalToken);
    expect(stop).toContain('/Stop');
    expect(stop).toContain(`http://${ep.host}:${ep.port}/api/hook/`);
    expect(stop).toMatch(/curl/);
  });

  it('uses a 2-second curl timeout and swallows errors so cc never blocks', () => {
    const settings = buildHookSettings('s', ep);
    const cmd = settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command ?? '';
    expect(cmd).toContain('-m 2');
    expect(cmd).toContain('|| true');
  });

  it('UserPromptSubmit keeps stdout (no >/dev/null) so quota-block JSON reaches cc', () => {
    const settings = buildHookSettings('s', ep);
    const cmd = settings.hooks['UserPromptSubmit']?.[0]?.hooks[0]?.command ?? '';
    // stderr redirected, but stdout MUST stream through to cc's hook-result reader
    expect(cmd).toContain('2>/dev/null');
    expect(cmd).not.toContain('>/dev/null 2>&1');
  });

  it('non-UserPromptSubmit events discard stdout (state-machine fire-and-forget)', () => {
    const settings = buildHookSettings('s', ep);
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']) {
      const cmd = settings.hooks[event]?.[0]?.hooks[0]?.command ?? '';
      expect(cmd).toContain('>/dev/null 2>&1');
    }
  });

  it('url-encodes the sessionId path component', () => {
    const settings = buildHookSettings('a/b c', ep);
    const cmd = settings.hooks['Stop']?.[0]?.hooks[0]?.command ?? '';
    expect(cmd).toContain('a%2Fb%20c');
  });
});
