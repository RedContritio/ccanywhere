import { Button } from '@/components/ui/button';
import type { UserKind } from '../state/auth.js';
import { DialogBase } from './dialog-base.js';

interface Props {
  readonly reason: string | null;
  readonly onClose: () => void;
  readonly onOpenQuotaPanel?: () => void;
  /** B23: owner sees self-service title; limited user sees "联系管理员". */
  readonly userKind?: UserKind | null;
}

/**
 * surfaced when the server input gate drops a turn for
 * quota exhaustion. cc never received the user input — the conversation
 * stays clean. User can either close (and keep the session for read-only
 * inspection) or open the quota panel to see how far over.
 */
export function QuotaExhaustedDialog({
  reason,
  onClose,
  onOpenQuotaPanel,
  userKind,
}: Props): JSX.Element {
  // owner == self == admin; "联系管理员" makes no sense to them.
  const title =
    userKind === 'owner' ? '配额不足，请查看用量并调整' : '超出配额，请联系管理员';
  return (
    <DialogBase
      open={reason !== null}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={title}
      description="刚才的输入未发送给 cc。"
      size="sm"
      footer={
        <>
          {onOpenQuotaPanel !== undefined ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                onClose();
                onOpenQuotaPanel();
              }}
            >
              查看配额
            </Button>
          ) : null}
          <Button type="button" onClick={onClose}>
            知道了
          </Button>
        </>
      }
    >
      <p className="text-sm text-fg-muted">{reason ?? ''}</p>
    </DialogBase>
  );
}
