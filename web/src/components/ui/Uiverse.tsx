/**
 * Uiverse.io elements, wearing this app's palette.
 *
 * The CSS beside these components is vendored verbatim from
 * github.com/uiverse-io/galaxy (MIT) by `scripts/vendor-uiverse.mjs`, with only
 * the selectors scoped and the keyframes renamed - see that script for why that
 * much was unavoidable. The markup below is the author's too, transcribed from
 * the same source file.
 *
 * WHAT IS OVERRIDDEN, and it is only colour. Uiverse elements are written for
 * whatever page the author had in mind, so they arrive with literal colours
 * baked in - `#FFF`, `greenyellow`, an HSL pair at full saturation. Those are
 * the one thing that cannot survive being dropped into a monochrome interface,
 * so each component sets the element's own custom properties (or, where the
 * author used a literal, a narrow override in theme.css) to this app's tokens.
 * The geometry and the motion - which is the part worth having - are untouched.
 *
 * THE CSS IS NOT IMPORTED HERE. It is pulled into `@layer app` from
 * tailwind.css instead, because a `import '...css'` from this file would land
 * outside every layer and silently outrank the retheme - see the note there.
 *
 * WHERE THEY EARN THEIR PLACE. A spinner that is merely a spinner is already
 * handled by Coss. These are for the waits long enough that the interface has
 * nothing else to say: a daemon that has not answered yet, a model still
 * thinking. That is a real state in this app, not a decoration looking for a
 * home - which is the test any of these has to pass before it is used.
 */

/**
 * Twelve diamonds on a rotating ring, by VashonG.
 *
 * The author sized it in `vmin`, which is right for a demo page filling the
 * viewport and wrong inside a panel, so `size` maps to the same `--size`
 * custom property the original uses rather than overriding its rules.
 */
export function OrbitLoader({ size = 96, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <div className="uiv-orbit-loader" role="status" aria-label={label}>
      <figure style={{ ['--size' as string]: `${size}px` }}>
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} style={{ ['--i' as string]: i + 1 }} />
        ))}
      </figure>
    </div>
  );
}

/** A two-tone pulse, by Shoh2008. Inline-sized, for a row rather than a page. */
export function PulseLoader({ label = 'Working' }: { label?: string }) {
  return (
    <span className="uiv-pulse-loader" role="status" aria-label={label}>
      <span className="loader" />
    </span>
  );
}

/** A rotating ring with two orbiting dots, by Shoh2008. */
export function RingLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="uiv-ring-loader" role="status" aria-label={label}>
      <span className="loader" />
    </span>
  );
}
