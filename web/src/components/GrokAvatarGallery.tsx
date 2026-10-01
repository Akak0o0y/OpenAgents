/**
 * The avatar gallery.
 *
 * Modelled on the upstream Aora "Emotion Gallery": a family selector, a
 * filter toolbar, a scrolling strip of emotion thumbnails, and a large preview
 * with prev/next. It is the configurator for creating a bot, where you are
 * choosing a character rather than tweaking one field at a time.
 *
 * The family row groups the twelve silhouettes by how they are built - rounds,
 * angular, organic - so browsing is a short list rather than a wall of twelve.
 * It is NOT a licence gate: every silhouette is OpenAgents-original geometry.
 * The upstream ball characters are not bundled at all, because their designs
 * are permanently non-commercial and editing them would only produce a
 * derivative under the same restriction.
 *
 * Everything here drives the real engine: the expressions are its own 32
 * definitions, the sketch toggle is its style flag, and the preview is a live
 * ball rather than a picture of one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui/icons.js';
import { BotFace, usePrefersReducedMotion } from './BotFace.js';
import { EMOTION_GROUPS, EMOTION_SEED } from '../lib/aora-bot/index.js';
import {
  SHAPE_FAMILIES,
  SHAPE_LABELS,
  familyOfShape,
  type AoraShape,
} from '../lib/aora-bot/shapes.js';
import { BOT_COLORS } from '../lib/botProfile.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/Select.js';
import { Kbd, KbdGroup } from '@/registry/default/ui/kbd.js';
import { Switch } from '@/registry/default/ui/switch.js';
import { Badge } from '@/registry/default/ui/badge.js';

export interface GalleryValue {
  shape: AoraShape;
  color: string;
  eyeColor: string;
  emotion: string;
  sketch: boolean;
}

interface GrokAvatarGalleryProps {
  value: GalleryValue;
  onChange: (patch: Partial<GalleryValue>) => void;
  /** Rendered above the family row, e.g. "Design your bot". */
  heading?: string;
}

interface EmotionEntry {
  id: string;
  name: string;
  description: string;
  group: string;
}

/** The engine's emotion definitions, in English, with the group they belong to. */
const EMOTIONS: EmotionEntry[] = (EMOTION_SEED as Array<any>).map((item) => ({
  id: String(item.id),
  name: item.en?.name || item.name || String(item.id),
  description: item.en?.desc || item.desc || '',
  group: item.group || 'custom',
}));

const GROUPS: Array<{ key: string; label: string }> = [
  { key: 'all', label: `All (${EMOTIONS.length})` },
  ...(EMOTION_GROUPS as Array<any>).map((g) => ({
    key: g.key,
    label: `${g.en || g.name} (${EMOTIONS.filter((e) => e.group === g.key).length})`,
  })),
].filter((g) => !g.label.endsWith('(0)'));

const INTERVALS = [1500, 2500, 4000, 6000];

export function GrokAvatarGallery({ value, onChange, heading }: GrokAvatarGalleryProps) {
  const [view, setView] = useState<'wall' | 'album'>('album');
  const [group, setGroup] = useState('all');
  const [interval, setIntervalMs] = useState(2500);
  const [autoplay, setAutoplay] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  const family = familyOfShape(value.shape);

  const emotions = useMemo(
    () => (group === 'all' ? EMOTIONS : EMOTIONS.filter((e) => e.group === group)),
    [group]
  );

  const index = Math.max(0, emotions.findIndex((e) => e.id === value.emotion));
  const current = emotions[index] ?? emotions[0];

  const step = useCallback(
    (delta: number) => {
      if (emotions.length === 0) return;
      const next = (index + delta + emotions.length) % emotions.length;
      onChange({ emotion: emotions[next].id });
    },
    [emotions, index, onChange]
  );

  // Autoplay walks the filtered set. Reduced motion turns it off rather than
  // running it invisibly: an operator who asked for less movement should not
  // get a slideshow.
  useEffect(() => {
    if (!autoplay || reducedMotion || emotions.length < 2) return;
    const timer = setInterval(() => step(1), interval);
    return () => clearInterval(timer);
  }, [autoplay, reducedMotion, interval, emotions.length, step]);

  // Keep the selected thumbnail in view when it changes from any source.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const selected = strip.querySelector<HTMLElement>('[aria-pressed="true"]');
    selected?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [value.emotion, reducedMotion]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    }
  };

  const face = (size: number, emotion: string, extra?: { idle?: boolean; interactive?: boolean }) => (
    <BotFace
      size={size}
      shape={value.shape}
      color={value.color}
      eyeColor={value.eyeColor}
      emotion={emotion}
      sketch={value.sketch}
      idle={extra?.idle ?? false}
      interactive={extra?.interactive}
    />
  );

  return (
    <section className="grok-gallery" aria-label="Avatar gallery" onKeyDown={onKeyDown}>
      {heading && <h2 className="grok-gallery-heading">{heading}</h2>}

      {/* Family row. A browsing aid, not a licence gate: every silhouette
          below is OpenAgents-original geometry. */}
      <div className="grok-gallery-families" role="radiogroup" aria-label="Character family">
        {SHAPE_FAMILIES.map((entry) => {
          const selected = family.id === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`grok-family-card ${selected ? 'selected' : ''}`}
              title={entry.description}
              onClick={() => {
                if (selected) return;
                onChange({ shape: entry.shapes[0] });
              }}
            >
              <BotFace
                size={44}
                shape={entry.shapes[0]}
                color={value.color}
                eyeColor={value.eyeColor}
                emotion={value.emotion}
                idle={false}
              />
              <span className="grok-family-name">{entry.name}</span>
              <Badge variant="outline" size="sm">{entry.shapes.length} shapes</Badge>
            </button>
          );
        })}
      </div>
      <p className="grok-gallery-note">
        {family.description} All twelve silhouettes are OpenAgents-original
        geometry, generated from formulas — no third-party character artwork is
        bundled. The expressions come from the Aora emotion engine, which is
        free for non-commercial use and separately licensable for commercial use.
      </p>

      {/* Toolbar. */}
      <div className="grok-gallery-toolbar">
        <div className="grok-gallery-viewtoggle" role="group" aria-label="Gallery view">
          {(['wall', 'album'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={view === mode ? 'active' : ''}
              aria-pressed={view === mode}
              onClick={() => setView(mode)}
            >
              {mode === 'wall' ? 'Wall' : 'Album'}
            </button>
          ))}
        </div>

        <label className="grok-gallery-field">
          <span>Group</span>
          <Select value={group} onValueChange={(value) => setGroup(value ?? group)}>
            <SelectTrigger className="grok-mini-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUPS.map((g) => (
                <SelectItem key={g.key} value={g.key}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="grok-gallery-field">
          <span>Shape</span>
          <Select
            value={value.shape}
            onValueChange={(next) => next && onChange({ shape: next as AoraShape })}
          >
            <SelectTrigger className="grok-mini-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
            {family.shapes.map((shape) => (
              <SelectItem key={shape} value={shape}>
                {SHAPE_LABELS[shape]}
              </SelectItem>
            ))}
            </SelectContent>
          </Select>
        </label>

        <label className="grok-gallery-field">
          <span>Interval</span>
          <Select
            // Base UI carries values as strings; the interval is a number, so
            // the conversion happens at both edges rather than in the middle.
            value={String(interval)}
            disabled={!autoplay}
            onValueChange={(next) => next && setIntervalMs(Number(next))}
          >
            <SelectTrigger className="grok-mini-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
            {INTERVALS.map((ms) => (
              <SelectItem key={ms} value={String(ms)}>
                {ms / 1000}s
              </SelectItem>
            ))}
            </SelectContent>
          </Select>
        </label>

        {/* Coss Switch, on Base UI. A toggle is `role="switch"`, not a
            checkbox: a screen reader then says "on/off" rather than
            "checked", which is what the control actually means. */}
        <label className="grok-switch-inline">
          <Switch checked={value.sketch} onCheckedChange={(next) => onChange({ sketch: next })} />
          <span>Sketch</span>
        </label>

        <label className="grok-switch-inline">
          <Switch checked={autoplay} disabled={reducedMotion} onCheckedChange={setAutoplay} />
          <span>Autoplay</span>
        </label>

        <span className="grok-gallery-hint">
          {reducedMotion ? (
            'Autoplay is off because you asked for reduced motion.'
          ) : (
            <>
              {/* Coss Kbd. The arrows used to be two characters in a sentence,
                  which reads as punctuation rather than as keys you can press.
                  Drawn as keycaps they are recognisably an instruction. */}
              Click a thumbnail to switch expression, or page with{' '}
              <KbdGroup>
                <Kbd>
                  <Icon name="back" size={12} motion={false} />
                </Kbd>
                <Kbd>
                  <Icon name="forward" size={12} motion={false} />
                </Kbd>
              </KbdGroup>
            </>
          )}
        </span>
      </div>

      {/* Colour row. The upstream gallery ties colour to its characters; ours
          is a separate choice, so it gets its own row rather than being hidden. */}
      <div className="grok-color-grid wide" role="radiogroup" aria-label="Body colour">
        {BOT_COLORS.map((colour) => (
          <button
            key={colour.id}
            type="button"
            role="radio"
            aria-checked={value.color === colour.value}
            className={`grok-color-swatch ${value.color === colour.value ? 'selected' : ''}`}
            style={{ background: colour.value }}
            aria-label={colour.label}
            title={colour.label}
            onClick={() =>
              onChange({
                color: colour.value,
                // A light body needs dark eyes to stay legible.
                eyeColor: ['black', 'yellow'].includes(colour.id) ? '#1A1A1A' : '#FFFFFF',
              })
            }
          />
        ))}
      </div>

      {view === 'album' ? (
        <>
          <div className="grok-gallery-strip" ref={stripRef} role="listbox" aria-label="Expressions">
            {emotions.map((emotion) => (
              <button
                key={emotion.id}
                type="button"
                role="option"
                aria-selected={emotion.id === value.emotion}
                aria-pressed={emotion.id === value.emotion}
                className={`grok-gallery-thumb ${emotion.id === value.emotion ? 'selected' : ''}`}
                title={emotion.description}
                onClick={() => onChange({ emotion: emotion.id })}
              >
                {face(64, emotion.id)}
                <span className="grok-gallery-thumb-label">
                  <em>{emotion.id}</em> {emotion.name}
                </span>
              </button>
            ))}
          </div>

          <div className="grok-gallery-stage">
            <button
              type="button"
              className="grok-gallery-arrow"
              aria-label="Previous expression"
              onClick={() => step(-1)}
            >
              <Icon name="back" />
            </button>
            <div className="grok-gallery-hero">
              {face(220, value.emotion, { idle: true, interactive: true })}
              {current && (
                <p className="grok-gallery-caption">
                  <strong>
                    {current.id} · {current.name}
                  </strong>
                  <span>{current.description}</span>
                </p>
              )}
            </div>
            <button
              type="button"
              className="grok-gallery-arrow"
              aria-label="Next expression"
              onClick={() => step(1)}
            >
              <Icon name="forward" />
            </button>
          </div>
        </>
      ) : (
        <div className="grok-gallery-wall" role="listbox" aria-label="Expressions">
          {emotions.map((emotion) => (
            <button
              key={emotion.id}
              type="button"
              role="option"
              aria-selected={emotion.id === value.emotion}
              aria-pressed={emotion.id === value.emotion}
              className={`grok-gallery-cell ${emotion.id === value.emotion ? 'selected' : ''}`}
              title={emotion.description}
              onClick={() => onChange({ emotion: emotion.id })}
            >
              {face(84, emotion.id)}
              <span className="grok-gallery-thumb-label">
                <em>{emotion.id}</em> {emotion.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
