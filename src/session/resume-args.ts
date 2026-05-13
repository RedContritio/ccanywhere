// m-resume-args-helper: cc spawn args for resume path. Pulled out of
// sessions-resume.ts route so the args shape is unit-testable without a
// real cc binary. Two prod bugs (P7 + P8 of m-session-persistence) slipped
// past sh-fixture integration tests because sh-on-bad-flags happens to
// exit similarly to cc-panic-then-exit — this helper exists so the
// regression guards stay sharp.

export interface ResumeArgsInput {
  /** ccanywhere web session id (= cc jsonl filename for create-mode
   *  sessions; ≠ jsonl filename for resume-mode sessions). */
  readonly webId: string;
  /** cc jsonl id this session originally resumed from, if any. For
   *  create-mode sessions this is null/undefined and `webId` doubles as
   *  the cc jsonl filename. */
  readonly resumeSessionId: string | null | undefined;
}

/** cc identifies the conversation jsonl by its own session id. When a
 *  ccanywhere session was born in resume mode, the cc jsonl filename is
 *  `resumeSessionId`, NOT the web id. Falling back to `webId` covers the
 *  create-mode case where the two coincide. */
export function getCcSessionId(opts: ResumeArgsInput): string {
  return opts.resumeSessionId ?? opts.webId;
}

/** Build the cc CLI args for spawning a resume PTY. cc rejects the combo
 *  `--resume X --session-id X` as conflicting (panic + immediate exit),
 *  so we pass only `--resume`. */
export function buildResumeArgs(opts: ResumeArgsInput): string[] {
  return ['--resume', getCcSessionId(opts)];
}
