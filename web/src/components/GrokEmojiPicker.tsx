/**
 * Reaction picker.
 *
 * A compact anchored panel: search field, category heading, scrollable grid.
 * The catalogue is small and local on purpose - a reaction picker that has to
 * reach the network before it can show a smiley is a worse picker, and there is
 * no emoji service in this stack to reach.
 *
 * Opening the picker does not react. A reaction is applied only when a glyph is
 * chosen, which matches the reference and, more importantly, means hovering
 * around the grid cannot write to the server.
 */

import { useMemo, useRef, useState } from 'react';
import { Popover } from './ui/Overlay.js';
import { Input } from '@/registry/default/ui/input.js';

interface EmojiEntry {
  char: string;
  name: string;
}

interface EmojiCategory {
  id: string;
  label: string;
  emoji: EmojiEntry[];
}

export const QUICK_REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '😮'];

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Smileys & emotion',
    emoji: [
      { char: '😀', name: 'grinning' },
      { char: '😃', name: 'smiley' },
      { char: '😄', name: 'smile happy' },
      { char: '😁', name: 'beaming grin' },
      { char: '😆', name: 'laughing' },
      { char: '😅', name: 'sweat smile relief' },
      { char: '🤣', name: 'rolling on the floor laughing' },
      { char: '😂', name: 'joy tears laughing' },
      { char: '🙂', name: 'slight smile' },
      { char: '🙃', name: 'upside down' },
      { char: '😉', name: 'wink' },
      { char: '😊', name: 'blush smile' },
      { char: '😇', name: 'halo innocent' },
      { char: '🥰', name: 'hearts love' },
      { char: '😍', name: 'heart eyes love' },
      { char: '😘', name: 'kiss' },
      { char: '😋', name: 'yum tasty' },
      { char: '😎', name: 'sunglasses cool' },
      { char: '🤩', name: 'star struck' },
      { char: '🥳', name: 'party celebrate' },
      { char: '🤔', name: 'thinking' },
      { char: '🤨', name: 'raised eyebrow skeptical' },
      { char: '😐', name: 'neutral' },
      { char: '😑', name: 'expressionless' },
      { char: '🙄', name: 'eye roll' },
      { char: '😴', name: 'sleeping' },
      { char: '😪', name: 'sleepy tired' },
      { char: '😵', name: 'dizzy' },
      { char: '🤯', name: 'mind blown exploding head' },
      { char: '😬', name: 'grimace awkward' },
      { char: '😱', name: 'scream shock' },
      { char: '😮', name: 'open mouth surprise wow' },
      { char: '😢', name: 'cry sad' },
      { char: '😭', name: 'sob crying' },
      { char: '😤', name: 'triumph frustrated' },
      { char: '😡', name: 'angry rage' },
      { char: '🤒', name: 'sick thermometer' },
      { char: '🤝', name: 'handshake deal' },
      { char: '🙏', name: 'please thanks pray' },
      { char: '👀', name: 'eyes looking' },
    ],
  },
  {
    id: 'gestures',
    label: 'Gestures & people',
    emoji: [
      { char: '👍', name: 'thumbs up yes approve' },
      { char: '👎', name: 'thumbs down no reject' },
      { char: '👏', name: 'clap applause' },
      { char: '🙌', name: 'raised hands celebrate' },
      { char: '👋', name: 'wave hello' },
      { char: '🤙', name: 'call me' },
      { char: '✌️', name: 'victory peace' },
      { char: '🤞', name: 'fingers crossed hope' },
      { char: '💪', name: 'strong muscle' },
      { char: '🫡', name: 'salute acknowledged' },
      { char: '🤷', name: 'shrug unsure' },
      { char: '🧑‍💻', name: 'developer coding' },
    ],
  },
  {
    id: 'objects',
    label: 'Work & objects',
    emoji: [
      { char: '🎉', name: 'party popper celebrate ship' },
      { char: '🚀', name: 'rocket ship launch' },
      { char: '🔥', name: 'fire hot great' },
      { char: '✅', name: 'check done complete' },
      { char: '❌', name: 'cross wrong fail' },
      { char: '⚠️', name: 'warning caution' },
      { char: '🐛', name: 'bug defect' },
      { char: '🛠️', name: 'tools fix build' },
      { char: '📌', name: 'pin important' },
      { char: '📝', name: 'note memo write' },
      { char: '📊', name: 'chart data report' },
      { char: '⏰', name: 'alarm clock schedule routine' },
      { char: '💡', name: 'idea lightbulb' },
      { char: '🔍', name: 'search magnify investigate' },
      { char: '🧪', name: 'test experiment' },
      { char: '💰', name: 'money cost budget' },
      { char: '🔒', name: 'lock secure' },
      { char: '🧹', name: 'broom cleanup' },
    ],
  },
  {
    id: 'hearts',
    label: 'Hearts & symbols',
    emoji: [
      { char: '❤️', name: 'red heart love' },
      { char: '🧡', name: 'orange heart' },
      { char: '💛', name: 'yellow heart' },
      { char: '💚', name: 'green heart' },
      { char: '💙', name: 'blue heart' },
      { char: '💜', name: 'purple heart' },
      { char: '🖤', name: 'black heart' },
      { char: '⭐', name: 'star favourite' },
      { char: '✨', name: 'sparkles polish' },
      { char: '💯', name: 'hundred perfect' },
    ],
  },
];

interface GrokEmojiPickerProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function GrokEmojiPicker({ anchorRef, onSelect, onClose }: GrokEmojiPickerProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return EMOJI_CATEGORIES;
    return EMOJI_CATEGORIES.map((category) => ({
      ...category,
      emoji: category.emoji.filter(
        (entry) => entry.name.includes(needle) || entry.char === needle
      ),
    })).filter((category) => category.emoji.length > 0);
  }, [query]);

  return (
    <Popover
      anchorRef={anchorRef}
      placement="bottom-start"
      label="Pick a reaction"
      role="dialog"
      width={294}
      className="grok-emoji-popover"
      onClose={onClose}
      autoFocus={false}
    >
      <label className="grok-emoji-search">
        <span aria-hidden="true">⌕</span>
        <Input
          ref={inputRef}
          type="search"
          autoFocus
          value={query}
          placeholder="Search emoji"
          aria-label="Search emoji"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="grok-emoji-scroll">
        {categories.map((category) => (
          <section key={category.id}>
            <h3 className="grok-emoji-heading">{category.label}</h3>
            <div className="grok-emoji-grid">
              {category.emoji.map((entry) => (
                <button
                  key={entry.char}
                  type="button"
                  className="grok-emoji-cell"
                  title={entry.name}
                  aria-label={entry.name}
                  onClick={() => onSelect(entry.char)}
                >
                  {entry.char}
                </button>
              ))}
            </div>
          </section>
        ))}
        {categories.length === 0 && (
          <p className="grok-emoji-empty">No emoji match “{query.trim()}”.</p>
        )}
      </div>
    </Popover>
  );
}
