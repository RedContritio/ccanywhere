import type { JSX, ReactNode } from 'react';

interface Props<T> {
  readonly items: ReadonlyArray<T>;
  readonly selectedId: string;
  readonly getId: (item: T) => string;
  readonly renderPrimary: (item: T) => ReactNode;
  readonly renderSecondary?: (item: T) => ReactNode;
  readonly onSelect: (id: string) => void;
  readonly ariaLabel?: string;
}

/**
 * Single-select list of `[primary, secondary]` rows. Used inside dialogs
 * for picking a project or resuming a session — both render the same
 * shape (label + relative time), so they share this component.
 *
 * Visuals: the list draws its own border + rounded corners; rows fill the
 * container edge-to-edge (no horizontal inset) so even-row striping reads
 * as alternating bands, not floating chips on a tinted card.
 */
export function SelectableList<T>({
  items,
  selectedId,
  getId,
  renderPrimary,
  renderSecondary,
  onSelect,
  ariaLabel,
}: Props<T>): JSX.Element {
  return (
    <div className="dialog-list" role="radiogroup" aria-label={ariaLabel}>
      {items.map((item) => {
        const id = getId(item);
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === selectedId}
            className={`dialog-list-row ${id === selectedId ? 'is-active' : ''}`}
            onClick={() => onSelect(id)}
          >
            <span className="dialog-list-primary">{renderPrimary(item)}</span>
            {renderSecondary !== undefined && (
              <span className="dialog-list-secondary">{renderSecondary(item)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
