/**
 * BotFace: a bot's avatar.
 *
 * Two rendering paths, and only two:
 *   - an uploaded image, when the operator supplied one; or
 *   - the Aora emotion-ball engine, driven by the bot's shape/colour/emotion.
 *
 * REDUCED MOTION is honoured at the source rather than by a CSS override. The
 * engine runs a spring-physics loop on requestAnimationFrame; hiding that with
 * `animation: none` would leave the loop burning frames while pretending to be
 * still. When the operator has asked for reduced motion the ball is created
 * without idle behaviour, gaze tracking is not attached, click reactions are
 * suppressed, and a single static frame is rendered.
 *
 * CLEANUP is exhaustive because these mount and unmount constantly - every
 * sidebar row, every marketplace card. A leaked instance keeps an rAF loop and
 * a live SVG alive for the rest of the session.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createEmotionBall,
  getAgentBotPersonality,
  getAgentEmotion,
  type EmotionBallOptions,
  type EmotionBallInstance,
} from '../lib/aora-bot/index.js';
// Importing for the side effect: this registers the six original OpenAgents
// silhouettes with the engine before any ball is created.
import { type AoraShape } from '../lib/aora-bot/shapes.js';
import type { AgentRow } from '../lib/transport.js';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Shared across every avatar on the page; one listener, not one per bot. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export interface BotFaceProps {
  agent?: AgentRow | { id?: string; name?: string; model_id?: string; current_status?: string };
  status?: string;
  emotion?: string;
  shape?: AoraShape;
  color?: string;
  eyeColor?: string;
  /** An uploaded avatar. Takes precedence over the generated ball. */
  image?: string | null;
  size?: number;
  eyeScale?: number;
  idle?: EmotionBallOptions['idle'];
  sketch?: boolean;
  tourEmotionIds?: string[];
  tourInterval?: number;
  interactive?: boolean;
  bounceOnClick?: boolean;
  spinOnClick?: boolean;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Rendered as decoration when false; give it a name when it carries meaning. */
  alt?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export const BotFace: React.FC<BotFaceProps> = ({
  agent,
  status,
  emotion: explicitEmotion,
  shape: explicitShape,
  color: explicitColor,
  eyeColor: explicitEyeColor,
  image = null,
  size = 48,
  eyeScale,
  idle = true,
  sketch = false,
  tourEmotionIds,
  tourInterval = 1800,
  interactive = false,
  bounceOnClick = true,
  spinOnClick = false,
  title,
  className = '',
  style,
  alt,
  onClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<EmotionBallInstance | null>(null);
  const [clickCount, setClickCount] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  const personality = useMemo(() => getAgentBotPersonality(agent), [agent]);
  const shape = explicitShape ?? (personality.shape as AoraShape);
  const color = explicitColor ?? personality.color;
  const eyeColor = explicitEyeColor ?? personality.eyeColor;

  const currentStatus = status ?? (agent as AgentRow | undefined)?.current_status;
  const targetEmotion = explicitEmotion ?? getAgentEmotion(currentStatus);

  // Small avatars need proportionally larger eyes to stay legible.
  const calculatedEyeScale = eyeScale ?? (size <= 40 ? 1.25 : size <= 56 ? 1.1 : 1.0);
  const tourKey = tourEmotionIds?.join(',') ?? '';
  const useEngine = !image;

  useEffect(() => {
    if (!useEngine) return;
    const el = containerRef.current;
    if (!el) return;

    el.replaceChildren();

    const ball = createEmotionBall(el, {
      emotion: targetEmotion,
      shape,
      color,
      eyeColor,
      eyeScale: calculatedEyeScale,
      // Idle behaviour is the engine's ambient animation loop. Reduced motion
      // turns it off at the source rather than hiding a loop that still runs.
      idle: reducedMotion ? false : idle,
      autostart: !reducedMotion,
    });

    ball.setStyle({ sketch: sketch ? 1 : 0 });
    if (reducedMotion) {
      ball.setActive(false);
      ball.renderStatic();
    } else if (tourKey) {
      ball.startTour(tourKey.split(','), tourInterval);
    }

    ballRef.current = ball;

    return () => {
      // stopTour before destroy: the tour holds its own interval, and destroy
      // alone has been observed to leave it scheduled.
      ball.stopTour();
      ball.destroy();
      ballRef.current = null;
      el.replaceChildren();
    };
  }, [
    useEngine,
    shape,
    color,
    eyeColor,
    calculatedEyeScale,
    idle,
    sketch,
    tourKey,
    tourInterval,
    reducedMotion,
  ]);

  useEffect(() => {
    if (ballRef.current && targetEmotion) {
      ballRef.current.setEmotion(targetEmotion);
      if (reducedMotion) ballRef.current.renderStatic();
    }
  }, [targetEmotion, reducedMotion]);

  useEffect(() => {
    if (!interactive || reducedMotion || !useEngine) return;

    const onMouseMove = (e: MouseEvent) => {
      const el = containerRef.current;
      const ball = ballRef.current;
      if (!el || !ball) return;

      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;

      if (Math.hypot(dx, dy) < 600) {
        ball.setGaze(Math.max(-1, Math.min(1, dx / 200)), Math.max(-1, Math.min(1, dy / 200)));
      } else {
        ball.clearGaze();
      }
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [interactive, reducedMotion, useEngine]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const ball = ballRef.current;
    if (ball && !reducedMotion) {
      if (spinOnClick || (interactive && clickCount % 3 === 2)) ball.spin(1);
      else if (bounceOnClick || interactive) ball.bounce();
      setClickCount((c) => c + 1);
    }
    onClick?.(e);
  };

  const resolvedTitle =
    title ??
    (agent
      ? `${(agent as AgentRow).name ?? 'Bot'} (${currentStatus ?? 'IDLE'})`
      : undefined);

  const boxStyle: React.CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: interactive || onClick ? 'pointer' : 'default',
    userSelect: 'none',
    ...style,
  };

  if (image) {
    return (
      <div
        className={`bot-face bot-face-image ${className}`}
        style={boxStyle}
        title={resolvedTitle}
        onClick={onClick}
      >
        <img src={image} alt={alt ?? ''} width={size} height={size} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`bot-face ${interactive ? 'interactive' : ''} ${className}`}
      style={boxStyle}
      title={resolvedTitle}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      onClick={handleClick}
    />
  );
};
