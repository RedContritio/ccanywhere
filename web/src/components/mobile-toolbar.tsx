import { useState, type MouseEvent } from 'react';

interface Props {
  /**
   * Receive raw bytes to send to the PTY (escape sequences for arrows,
   * Esc, Tab, or Ctrl-modified characters when sticky Ctrl is active).
   */
  readonly onKey: (data: string) => void;
}

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_LEFT = '\x1b[D';
const ARROW_RIGHT = '\x1b[C';
const SHIFT_TAB = '\x1b[Z';

export function MobileToolbar({ onKey }: Props): JSX.Element {
  // Sticky Ctrl: when set, the next key emits its Ctrl-modified byte.
  // Tapping Ctrl again toggles it off.
  const [pendingCtrl, setPendingCtrl] = useState(false);

  const sendPlain = (data: string) => {
    if (pendingCtrl) {
      onKey(data);
      setPendingCtrl(false);
      return;
    }
    onKey(data);
  };

  const sendCtrlLetter = (letter: string) => {
    const code = letter.toLowerCase().charCodeAt(0);
    if (code >= 0x60 && code <= 0x7a) {
      onKey(String.fromCharCode(code & 0x1f));
    } else {
      onKey(letter);
    }
    setPendingCtrl(false);
  };

  const onCtrlClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setPendingCtrl((p) => !p);
  };

  /**
   * Block default mousedown so xterm keeps focus and the on-screen
   * keyboard doesn't dismiss when a shortcut is tapped.
   */
  const keepXtermFocus = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
  };

  // Two grids side-by-side:
  //   left:  4×2 controls (auto-stretch each cell across available width)
  //   right: 2×2 arrows  (fixed width per cell, layout pairs vertical/horizontal axes)
  return (
    <div className="mobile-toolbar" role="toolbar" aria-label="virtual keys">
      <div className="mt-controls-grid">
        <button
          type="button"
          className="mt-key"
          onMouseDown={keepXtermFocus}
          onClick={() => sendPlain('\x1b')}
        >
          Esc
        </button>
        <button
          type="button"
          className="mt-key"
          onMouseDown={keepXtermFocus}
          onClick={() => sendPlain('\t')}
        >
          Tab
        </button>
        <button
          type="button"
          className="mt-key"
          onMouseDown={keepXtermFocus}
          onClick={() => sendPlain(SHIFT_TAB)}
          title="cc 切换 plan / accept 模式"
        >
          ⇧Tab
        </button>
        <button
          type="button"
          className={`mt-key mt-ctrl ${pendingCtrl ? 'is-active' : ''}`}
          onMouseDown={keepXtermFocus}
          onClick={onCtrlClick}
          aria-pressed={pendingCtrl}
          title="按一下 Ctrl，下一键发 Ctrl+key"
        >
          Ctrl
        </button>
        <button
          type="button"
          className="mt-key"
          onMouseDown={keepXtermFocus}
          onClick={() => sendCtrlLetter('c')}
        >
          ^C
        </button>
        <button
          type="button"
          className="mt-key"
          onMouseDown={keepXtermFocus}
          onClick={() => sendCtrlLetter('d')}
        >
          ^D
        </button>
        <button
          type="button"
          className="mt-key"
          onMouseDown={keepXtermFocus}
          onClick={() => sendCtrlLetter('l')}
        >
          ^L
        </button>
        <button
          type="button"
          className="mt-key"
          onMouseDown={keepXtermFocus}
          onClick={() => sendCtrlLetter('r')}
          title="cc verbose toggle"
        >
          ^R
        </button>
      </div>
      <div className="mt-arrows-grid">
        <button
          type="button"
          className="mt-key mt-arrow"
          onMouseDown={keepXtermFocus}
          onClick={() => sendPlain(ARROW_UP)}
        >
          ↑
        </button>
        <button
          type="button"
          className="mt-key mt-arrow"
          onMouseDown={keepXtermFocus}
          onClick={() => sendPlain(ARROW_DOWN)}
        >
          ↓
        </button>
        <button
          type="button"
          className="mt-key mt-arrow"
          onMouseDown={keepXtermFocus}
          onClick={() => sendPlain(ARROW_LEFT)}
        >
          ←
        </button>
        <button
          type="button"
          className="mt-key mt-arrow"
          onMouseDown={keepXtermFocus}
          onClick={() => sendPlain(ARROW_RIGHT)}
        >
          →
        </button>
      </div>
    </div>
  );
}
