import { describe, expect, it } from 'vitest';

import { buildResumeArgs, getCcSessionId } from './resume-args.js';

describe('getCcSessionId', () => {
  it('falls back to webId when resumeSessionId is null', () => {
    expect(getCcSessionId({ webId: 'w1', resumeSessionId: null })).toBe('w1');
  });

  it('falls back to webId when resumeSessionId is undefined', () => {
    expect(getCcSessionId({ webId: 'w1', resumeSessionId: undefined })).toBe('w1');
  });

  it('returns resumeSessionId when present (resume-mode session)', () => {
    expect(getCcSessionId({ webId: 'w1', resumeSessionId: 'cc_X' })).toBe('cc_X');
  });
});

describe('buildResumeArgs', () => {
  it('emits --resume <webId> for create-mode session (resumeSessionId null)', () => {
    expect(buildResumeArgs({ webId: 'w1', resumeSessionId: null })).toEqual([
      '--resume',
      'w1',
    ]);
  });

  it('emits --resume <ccJsonlId> for resume-mode session', () => {
    expect(buildResumeArgs({ webId: 'w1', resumeSessionId: 'cc_X' })).toEqual([
      '--resume',
      'cc_X',
    ]);
  });

  // Regression guard: cc rejects --resume X --session-id X as
  // conflicting. Asserting absence of --session-id keeps that bug from
  // sneaking back in.
  it('never emits --session-id flag', () => {
    const args1 = buildResumeArgs({ webId: 'w1', resumeSessionId: null });
    const args2 = buildResumeArgs({ webId: 'w1', resumeSessionId: 'cc_X' });
    expect(args1).not.toContain('--session-id');
    expect(args2).not.toContain('--session-id');
  });

  // Regression guard: web id and cc jsonl id diverge for
  // resume-mode sessions. The args must use the cc jsonl id, not the
  // web id (cc finds no jsonl named after the web id → auto-exit).
  it('uses cc jsonl id rather than web id when they differ', () => {
    const args = buildResumeArgs({ webId: 'ca8ede78', resumeSessionId: '3b3d0de0' });
    expect(args[1]).toBe('3b3d0de0');
    expect(args[1]).not.toBe('ca8ede78');
  });

  it('emits exactly two args', () => {
    expect(buildResumeArgs({ webId: 'w1', resumeSessionId: 'cc_X' })).toHaveLength(2);
  });
});
