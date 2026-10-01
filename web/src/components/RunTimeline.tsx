/**
 * The selected run's events, newest last, each tagged with the layer it proves.
 *
 * Each event's layer badge is drawn in the colour that layer has on the galaxy,
 * so the list and the bands it lit read as the same thing.
 */

import { type CSSProperties } from 'react';
import { UI_LOCALE } from '../lib/numbers.js';
import { useCortex } from '../store.js';
import { Icon } from './ui/icons.js';
import { CortexEmpty, layerColor } from './CortexKit.js';
import { describeEvent } from '../lib/describeEvent.js';

export function RunTimeline({ onOpenFleet }: { onOpenFleet?: () => void }) {
  const events = useCortex((s) => s.events);
  const selectedRunId = useCortex((s) => s.selectedRunId);

  if (!selectedRunId) {
    return (
      <CortexEmpty
        icon="detail"
        title="No run selected"
        action={
          onOpenFleet && (
            <button type="button" className="cx-btn primary" onClick={onOpenFleet}>
              <Icon name="group" size={14} />
              Pick a run
            </button>
          )
        }
      >
        Choose a run to see every event it produced, each tagged with the layer it proves.
      </CortexEmpty>
    );
  }

  if (events.length === 0) {
    return (
      <CortexEmpty icon="busy" title="No events recorded">
        This run has not reported any events.
      </CortexEmpty>
    );
  }

  return (
    <ol className="cx-timeline">
      {events.map((event, index) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(event.payload_json);
        } catch {
          /* keep the row, drop the detail */
        }
        // In words, as the node details say it; the event's own name stays as a tooltip.
        const described = describeEvent(event);
        const detail = described.detail ?? payload.executor ?? payload.source ?? payload.messageCount ?? payload.outcome;
        return (
          <li
            key={event.id ?? index}
            className="cx-event"
            style={{ '--i': Math.min(index, 24), '--layer': layerColor(event.layer) } as CSSProperties}
          >
            <span className="cx-event-node" title={event.layer ? `Layer ${event.layer}` : 'No layer'}>
              {event.layer ?? '·'}
            </span>
            <div className="cx-event-body">
              <strong title={event.event_type}>{described.title}</strong>
              {detail !== undefined && detail !== null && detail !== '' && <small>{String(detail).slice(0, 200)}</small>}
            </div>
            <time>{new Date(event.timestamp).toLocaleTimeString(UI_LOCALE)}</time>
          </li>
        );
      })}
    </ol>
  );
}
