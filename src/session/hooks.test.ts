import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHookSettings,
  cleanupHookConfigDir,
  createHookConfigDir,
  type HookEndpoint,
} from './hooks.js';

const ep: HookEndpoint = {
  host: '127.0.0.1',
  port: 7878,
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

  it('url-encodes the sessionId path component', () => {
    const settings = buildHookSettings('a/b c', ep);
    const cmd = settings.hooks['Stop']?.[0]?.hooks[0]?.command ?? '';
    expect(cmd).toContain('a%2Fb%20c');
  });
});

describe('createHookConfigDir / cleanupHookConfigDir', () => {
  it('creates a tmp dir with settings.json and removes it on cleanup', () => {
    const dir = createHookConfigDir('s1', ep);
    try {
      expect(existsSync(dir)).toBe(true);
      const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
        hooks: Record<string, unknown>;
      };
      expect(Object.keys(settings.hooks)).toContain('Stop');
    } finally {
      cleanupHookConfigDir(dir);
    }
    expect(existsSync(dir)).toBe(false);
  });

  it('cleanup on a non-existent dir does not throw', () => {
    expect(() => cleanupHookConfigDir('/tmp/__never_existed_ccanywhere__')).not.toThrow();
  });
});
