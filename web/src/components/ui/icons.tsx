/**
 * The icon set.
 *
 * Every icon in the interface comes from here, and every one is named for what
 * it MEANS rather than what it looks like - `Settings`, not `Gear`. That is the
 * point of the indirection: swapping the underlying set, or changing which
 * glyph represents "run this now", is one edit here instead of a search across
 * thirty files for a Unicode character.
 *
 * WHY A LIBRARY AT ALL. The interface previously drew its icons as Unicode text
 * - U+2699 for settings, U+29C9 for the marketplace, U+2B61 for updates. Those
 * are typographic characters, not icons: they render in whatever the font
 * happens to contain, at whatever weight and baseline that font chose, and they
 * differ between machines. Half of them are missing from Segoe UI entirely and
 * fall back to a different face mid-sentence. It is the single clearest signal
 * that an interface was assembled rather than designed.
 *
 * Lucide (ISC) is one of the sets catalogued at 21st.dev. It was chosen over
 * the others there because it is a real npm package with no Tailwind
 * dependency, it tree-shakes to only the icons imported below, and its 1.5px
 * stroke at 16px matches the weight of Geist Text - which is why the icons sit
 * on the same optical line as the labels beside them.
 *
 * THEY MOVE. The animated sets at 21st.dev - Hugeicons, Heroicons - play a
 * gesture on hover, and the gesture means something: a gear turns, a refresh
 * arrow goes round, a trash can shakes. That is the part worth having. It
 * confirms that the control under the pointer is the one you thought it was,
 * without a word of text.
 *
 * Implemented in CSS rather than with Motion, which is what those sets use.
 * Three reasons: the gesture belongs to the BUTTON's hover rather than the
 * icon's - the icon is 16px, the button is the target, and a JS hover handler
 * on the icon fires only over the glyph itself; a transform on hover is what
 * CSS is for and costs no bundle; and `prefers-reduced-motion` is already
 * handled once for the whole stylesheet instead of per component.
 */

import {
  Activity,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  ChartColumn,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePlay,
  Clock,
  Copy,
  CornerUpLeft,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  Grid2x2,
  House,
  FileText,
  Folder,
  Image,
  LayoutGrid,
  LayoutTemplate,
  Link2,
  Loader,
  Menu,
  MessageSquare,
  Mic,
  Monitor,
  Orbit,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  Send,
  Settings,
  SmilePlus,
  Square,
  SquarePen,
  Smartphone,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Users,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  LocateFixed,
} from 'lucide-react';

/**
 * Named by meaning, not by shape.
 *
 * Where two meanings share a glyph today they still get separate names, so
 * changing one later does not silently change the other.
 */
export const Icons = {
  // Navigation and chrome
  settings: Settings,
  search: Search,
  close: X,
  back: ChevronLeft,
  forward: ChevronRight,
  collapse: ChevronsLeft,
  expand: ChevronsRight,
  more: Ellipsis,
  open: ExternalLink,
  home: House,
  marketplace: LayoutGrid,
  grid: Grid2x2,
  section: Folder,
  mobile: Smartphone,
  template: LayoutTemplate,
  menu: Menu,
  cortex: Orbit,
  detail: Rows3,
  data: ChartColumn,
  chat: MessageSquare,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  recenter: LocateFixed,

  // Disclosure
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,

  // Actions
  add: Plus,
  edit: SquarePen,
  rename: Pencil,
  remove: Trash2,
  copy: Copy,
  reply: CornerUpLeft,
  react: SmilePlus,
  send: Send,
  attach: Paperclip,
  upload: Upload,
  update: ArrowUp,
  refresh: RefreshCw,
  rotate: RotateCcw,
  pin: Pin,
  star: Star,
  preview: Eye,
  hide: EyeOff,
  unread: CircleDot,
  image: Image,
  dictate: Mic,
  link: Link2,
  file: FileText,

  // Run state
  run: CirclePlay,
  pause: Pause,
  stop: Square,
  busy: Loader,
  ok: CircleCheck,
  warn: TriangleAlert,
  error: CircleAlert,
  done: Check,

  // Domain
  bot: Bot,
  group: Users,
  user: User,
  computer: Monitor,
  usage: Activity,
  schedule: Clock,
  power: Zap,
} as const;

export type IconName = keyof typeof Icons;

/**
 * What each icon does when the control holding it is hovered.
 *
 * Named by the MOVEMENT rather than by the icon, because several share one -
 * and chosen to match the meaning rather than to be lively. A gear that turns
 * is saying "settings"; a gear that bounces is saying nothing.
 *
 * EVERY icon has one. The table is `Record`, not `Partial<Record>`, so adding
 * an icon without deciding how it moves is a type error rather than an icon
 * that silently sits still next to thirty that do not. Where an icon appears
 * outside a button - a status glyph in a sentence - the CSS simply never
 * matches, so nothing moves in running text.
 */
const MOTION: Record<IconName, string> = {
  // Rotation: things that turn, or become something else.
  settings: 'turn',
  refresh: 'spin',
  rotate: 'spin-back',
  busy: 'spin',
  cortex: 'spin',
  add: 'quarter',
  close: 'quarter',
  schedule: 'turn',

  // Direction: the gesture points where the action goes.
  send: 'fly',
  open: 'fly',
  upload: 'lift',
  update: 'lift',
  chevronUp: 'lift',
  chevronDown: 'nudge-down',
  back: 'nudge-left',
  reply: 'nudge-left',
  collapse: 'nudge-left',
  forward: 'nudge-right',
  expand: 'nudge-right',
  home: 'lift',
  usage: 'lift',
  data: 'lift',
  detail: 'lift',
  file: 'lift',
  template: 'lift',
  chat: 'lift',
  menu: 'nudge-down',
  zoomIn: 'grow',
  zoomOut: 'grow',
  recenter: 'spin',

  // Emphasis: nothing to point at, so it grows or reacts.
  search: 'grow',
  more: 'grow',
  run: 'grow',
  pause: 'grow',
  stop: 'grow',
  marketplace: 'grow',
  grid: 'grow',
  image: 'grow',
  group: 'grow',
  user: 'grow',
  bot: 'bounce',
  computer: 'grow',
  ok: 'grow',
  done: 'bounce',
  copy: 'shift',
  react: 'bounce',
  star: 'bounce',
  pin: 'tilt',
  dictate: 'pulse',
  power: 'pulse',
  unread: 'pulse',

  // Tilting: things held at an angle, or hinged.
  edit: 'tilt',
  rename: 'tilt',
  attach: 'tilt',
  link: 'tilt',
  section: 'tilt',
  mobile: 'tilt',

  // Eyes blink.
  preview: 'blink',
  hide: 'blink',

  // Attention: the two that report something is wrong, and the one
  // destructive gesture, which hesitates on purpose.
  warn: 'shake',
  error: 'shake',
  remove: 'shake',
};

export interface IconProps {
  name: IconName;
  /**
   * Matched to the text it sits beside, not chosen freely: 14 next to small
   * labels, 16 in rows and buttons, 18 for a section heading.
   */
  size?: number;
  className?: string;
  /**
   * An icon next to a label is decoration and must not be announced - the
   * label already says it. An icon that IS the control needs a name, and that
   * belongs on the button, not here. So this is aria-hidden by default and
   * there is deliberately no `label` prop tempting you to do it the wrong way.
   */
  strokeWidth?: number;
  /**
   * Set false where the gesture would be noise - decoration inside a large
   * hover target, or one icon among many in a list.
   */
  motion?: boolean;
}

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.75,
  motion = true,
}: IconProps) {
  const Glyph = Icons[name];
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      // Read by the stylesheet, which plays the gesture from the hover of
      // whatever interactive ancestor contains this icon.
      data-motion={motion ? MOTION[name] : undefined}
      aria-hidden="true"
      focusable="false"
    />
  );
}
