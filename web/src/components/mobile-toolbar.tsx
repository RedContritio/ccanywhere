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

export function MobileToolbar({ onKey }: Props): JSX.Element {
  // Sticky Ctrl: when set, the next key emits its Ctrl-modified byte.
  // Tapping Ctrl again toggles it off.
  const [pendingCtrl, setPendingCtrl] = useState(false);

  const sendPlain = (data: string) => {
    if (pendingCtrl) {
      // Ctrl + another control key (Esc/Tab/arrows) is rare and undefined
      // for our use; still emit the original sequence so users aren't
      // stuck and clear the modifier.
      onKey(data);
      setPendingCtrl(false);
      return;
    }
    onKey(data);
  };

  /**
   * For a printable ASCII byte (a-z), emit Ctrl+letter as `byte & 0x1f`.
   * Other inputs ignore the modifier and pass through.
   */
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

  // Common Ctrl+letter shortcuts a phone user can't otherwise hit easily.
  const ctrlShortcuts: ReadonlyArray<{ letter: string; label: string }> = [
    { letter: 'c', label: '^C' },
    { letter: 'd', label: '^D' },
    { letter: 'l', label: '^L' },
    { letter: 'z', label: '^Z' },
  ];

  return (
    <div className="mobile-toolbar" role="toolbar" aria-label="virtual keys">
      <button type="button" className="mt-key" onClick={() => sendPlain('\x1b')}>
        Esc
      </button>
      <button type="button" className="mt-key" onClick={() => sendPlain('\t')}>
        Tab
      </button>
      <button
        type="button"
        className={`mt-key mt-ctrl ${pendingCtrl ? 'is-active' : ''}`}
        onClick={onCtrlClick}
        aria-pressed={pendingCtrl}
        title="按一下 Ctrl，下一键发 Ctrl+key"
      >
        Ctrl
      </button>
      {ctrlShortcuts.map(({ letter, label }) => (
        <button
          key={letter}
          type="button"
          className="mt-key mt-shortcut"
          onClick={() => sendCtrlLetter(letter)}
        >
          {label}
        </button>
      ))}
      <span className="mt-spacer" />
      <button type="button" className="mt-key mt-arrow" onClick={() => sendPlain(ARROW_UP)}>
        ↑
      </button>
      <button type="button" className="mt-key mt-arrow" onClick={() => sendPlain(ARROW_DOWN)}>
        ↓
      </button>
      <button type="button" className="mt-key mt-arrow" onClick={() => sendPlain(ARROW_LEFT)}>
        ←
      </button>
      <button type="button" className="mt-key mt-arrow" onClick={() => sendPlain(ARROW_RIGHT)}>
        →
      </button>
    </div>
  );
}
