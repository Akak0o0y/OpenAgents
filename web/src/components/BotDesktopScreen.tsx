import { useState } from 'react';
import { Modal } from './ui/Overlay.js';

/** Operator-only: enlarging reconnects the viewer, not the Chrome/login session. */
export function BotDesktopScreen({ agentId }: { agentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const frame = <iframe title="Bot desktop — Chrome" className="oh-desktop-frame"
    src={`/api/desktop/${encodeURIComponent(agentId)}/viewer.html`} />;
  return <div className="oh-desktop-screen">
    <button type="button" onClick={() => setExpanded(true)}>Enlarge desktop</button>
    {!expanded && frame}
    {expanded && <Modal label="Bot desktop" className="oh-desktop-expanded" onClose={() => setExpanded(false)}>
      <header className="oh-desktop-expanded-bar"><strong>Bot desktop · Chrome</strong>
        <button type="button" onClick={() => setExpanded(false)}>Return to chat</button>
      </header>
      {frame}
    </Modal>}
  </div>;
}
