import type { CatalogEntry } from './toolbar-key-catalog.js';

interface Props {
  readonly entry: CatalogEntry;
  readonly onClick: (entry: CatalogEntry) => void;
}

/**
 * Catalog key button in the toolbar editor picker. Small mono-font chip
 * styled to be a quick visual match for the actual cell that will be
 * placed. Hover state previews the brand-color accent the cell will
 * acquire when selected.
 */
export function ToolbarCatalogKey({ entry, onClick }: Props): JSX.Element {
  return (
    <button
      type="button"
      data-slot="toolbar-catalog-key"
      onClick={() => onClick(entry)}
      title={entry.template.title}
      className="rounded-sm border border-border bg-bg px-2 py-1 font-mono text-xs transition-colors hover:border-brand hover:text-brand"
    >
      {entry.template.label}
    </button>
  );
}
