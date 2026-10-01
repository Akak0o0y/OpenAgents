/**
 * Colour helpers shared by the workspace and Cortex.
 */

/**
 * Black or white, whichever reads on a bot's colour.
 *
 * Bots can be any colour, white and yellow included, so an icon on a
 * bot-coloured surface cannot have one fixed ink. WCAG relative luminance, with
 * the switch placed where white stops clearing 3:1 - the minimum for a
 * non-text control - rather than at the midpoint, because white on a saturated
 * colour is the expected look and should be kept wherever it is legible.
 */
export function inkOn(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return '#ffffff';
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.3 ? '#0a0a0a' : '#ffffff';
}
