export interface HookEndpoint {
  readonly host: string;
  readonly port: number;
  readonly internalToken: string;
}

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
] as const;

export function buildHookSettings(sessionId: string, ep: HookEndpoint): {
  hooks: Record<string, Array<{ hooks: Array<{ type: 'command'; command: string }> }>>;
} {
  const url = (event: string): string =>
    `http://${ep.host}:${ep.port}/api/hook/${encodeURIComponent(sessionId)}/${event}`;
  const hooks: Record<string, Array<{ hooks: Array<{ type: 'command'; command: string }> }>> = {};
  for (const event of HOOK_EVENTS) {
    // #46 quota: UserPromptSubmit's stdout MUST pipe through to cc so the
    // server's quota-block decision (cc hook protocol JSON) reaches cc.
    // Other events are pure state-machine notifications — their bodies
    // are empty and stdout discarded to avoid noise. `2>/dev/null` is
    // kept on UserPromptSubmit so curl's own progress chatter doesn't
    // leak into cc's hook-result parser, but stdout is preserved.
    const cmd =
      event === 'UserPromptSubmit'
        ? `curl -fsS -m 2 -X POST -H "Authorization: Bearer ${ep.internalToken}" "${url(event)}" 2>/dev/null || true`
        : `curl -fsS -m 2 -X POST -H "Authorization: Bearer ${ep.internalToken}" "${url(event)}" >/dev/null 2>&1 || true`;
    hooks[event] = [
      {
        hooks: [{ type: 'command', command: cmd }],
      },
    ];
  }
  return { hooks };
}

