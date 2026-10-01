# Third-party notices

## Aora Emotion Ball

OpenAgents includes a TypeScript adaptation of the Emotion Ball engine from
[`sam70361/aora-bot`](https://github.com/sam70361/aora-bot), reviewed against
upstream commit `e3b6148c818da4a8e1966f2bc89cdb3cee473b73`.

The adapted implementation lives in `web/src/lib/aora-bot/`. The upstream
community license, usage notice, and commercial-license terms are retained in
`web/public/vendor/aora/` and are served from the application at
`/vendor/aora/LICENSE`, `/vendor/aora/NOTICE.md`, and
`/vendor/aora/LICENSE-COMMERCIAL.md`.

### What is and is not covered

The upstream licence splits into two classes, and OpenAgents now depends on only
one of them:

| Content | Upstream terms | Used by OpenAgents |
| --- | --- | --- |
| Expression engine and emotion data (state machine, spring interpolation, spherical projection, eye/mouth parameters, keyframes, the 32 emotion definitions) | Free for non-commercial use; **commercial licence available** | **Yes** — `engine.ts`, `ball.ts`, `emotions.ts`, and the `EXPRESSIONS` data in `rings.ts` |
| Ball-character visual designs — the `blob`, `wedge` and `gem` body silhouettes | **Non-commercial only, permanently. No commercial licence is or will be offered.** | **No** — not bundled |

### The character silhouettes are not bundled

`rings.ts` upstream carries a `SHAPES` table holding the three ball-character
silhouettes. That table ships **empty** here: the geometry was removed, and
`web/src/lib/aora-bot/shapes.ts` fills it at import time with twelve OpenAgents
originals.

Each is generated from a formula in that file — a superellipse, a stadium, a
rounded polygon, a union of disks, a disk with a cone. Those are mathematical
primitives, not artwork, so the results are independent creations carrying no
third-party terms and covered by the OpenAgents project licence.

Editing the upstream silhouettes was considered and rejected. A modified design
is a derivative work and inherits the original restriction; it would look safe
without being safe. Independent generation is the only route that actually
removes the dependency.

The `gem` identifier is retired. A stored profile naming it is migrated to
`crystal`, an original of similar character, rather than reset.

The colour palette in `web/src/lib/botProfile.ts` is likewise OpenAgents' own.
Its eleven labels follow a conventional colour vocabulary; the values are not
taken from any other product.

### What shipping commercially would still require

One thing: a commercial licence for the **expression engine and emotion data**,
which upstream offers (see `web/public/vendor/aora/LICENSE-COMMERCIAL.md` and
the contact address in it). Nothing about the character visuals blocks it any
more, because none of them are here.

## Geist and Geist Mono

The interface is set in **Geist**, with **Geist Mono** on code surfaces. Both
are by Vercel in collaboration with basement.studio, and both are licensed
under the **SIL Open Font License, Version 1.1**, which permits bundling,
modification and redistribution — including commercially — provided the fonts
are not sold on their own and the licence travels with them.

Two variable faces are vendored, taken from the `geist` npm package v1.7.2:

| File | Source |
| --- | --- |
| `web/public/fonts/Geist-Variable.woff2` | `geist/dist/fonts/geist-sans/Geist-Variable.woff2` |
| `web/public/fonts/GeistMono-Variable.woff2` | `geist/dist/fonts/geist-mono/GeistMono-Variable.woff2` |

The licence travels with them at `web/public/fonts/GEIST-LICENSE.txt`, served
from the application at `/fonts/GEIST-LICENSE.txt`. The npm package itself is
**not** a dependency — it was used once to obtain the files, then removed, so
the two `.woff2` files above are the whole of it.

Only the fonts are Vercel's. The palette in `web/src/theme.css` follows the
proportions and neutral-grey approach of Vercel's published design system,
which is a visual convention and not licensed material; no Vercel trademark,
logo or brand asset is bundled or implied.

## Coss UI, Base UI and Tailwind CSS

The interface's component library is **Coss UI** — the design system behind
Cal.com — vendored from its registry into `web/src/registry/default/`.

| Part | Licence | How it is used |
| --- | --- | --- |
| [Coss UI](https://github.com/cosscom/coss) `apps/ui` | **MIT** | 54 components, copied verbatim from `coss.com/ui/r` |
| [Base UI](https://base-ui.com) `@base-ui/react` | MIT | npm dependency; the unstyled primitives Coss builds on |
| Tailwind CSS 4 | MIT | Build-time only; utilities, no runtime |
| `class-variance-authority`, `clsx`, `tailwind-merge` | MIT / Apache-2.0 | npm dependencies Coss components import |

**The wider `cosscom/coss` repository is AGPLv3.** Only `apps/ui/` and
`apps/origin/` are separately MIT, and only `apps/ui` is used here. Nothing
under the AGPL portion of that repository is copied, imported or linked.

### The vendored files are not edited

`web/src/registry/default/` is byte-identical to the registry, and
`web/scripts/vendor-coss.mjs` re-fetches it. That is deliberate: a vendored file
edited on arrival cannot be updated without merging against changes nobody
recorded. Two consequences follow, and both are handled outside those files:

- `web/src/lib/utils.ts` exists only because Coss's `group.tsx` imports `cn`
  from a different path than every other component does.
- The `not-[class*='w-']:min-w-32` workaround lives in `theme.css`, not in
  `menu.tsx`.

### They wear this app's theme, not Cal.com's

Coss components are styled with Tailwind class names — `bg-background`,
`ring-ring`, `rounded-lg`. `web/src/tailwind.css` maps every one of those names
onto this project's own `--gk-*` tokens, so the components arrive in the Vercel
palette and Geist typography without a line of them being modified, and follow
the light/dark switch because the tokens underneath them do.

Tailwind's **preflight reset is deliberately not imported**. It would unstyle
every heading, list, button and input in the existing 3,400-line stylesheet.

## Uiverse.io elements

`web/src/registry/uiverse/` contains UI elements from [Uiverse.io](https://uiverse.io/),
fetched from the project's own archive at
[github.com/uiverse-io/galaxy](https://github.com/uiverse-io/galaxy) by
`web/scripts/vendor-uiverse.mjs`. Every element there is published by its author
under the **MIT Licence**, which permits use, modification and redistribution
provided the notice travels with the code.

Each vendored file records the source URL and the author's own credit comment,
and the manifest lists the same. The elements in use, and who wrote them:

| Element | Author | Used for |
| --- | --- | --- |
| `orbit-loader` | VashonG | Opening a conversation |
| `pulse-loader` | Shoh2008 | "…is thinking" in the transcript |
| `ring-loader` | Shoh2008 | The cold pass over local session logs |

Two changes are made mechanically when they are vendored, both recorded in the
script: selectors are prefixed with the element's scope class, and keyframes are
renamed. Without that, an element written for a standalone demo page restyles
every `<figure>` or `.loader` in this application. Colour is overridden
separately in `web/src/theme.css` so the vendored files stay a straight copy of
the source. The geometry and motion are the authors' and are unmodified.

Attribution is not strictly required by MIT beyond the notice, but Uiverse asks
for it and the authors deserve it.

## Markdown rendering

Model output is typeset with [`react-markdown`](https://github.com/remarkjs/react-markdown)
and [`remark-gfm`](https://github.com/remarkjs/remark-gfm), both MIT-licensed
and installed as ordinary npm dependencies rather than vendored. They build
React elements directly, so model output never becomes an HTML string — see
`web/src/components/MessageBody.tsx` for why that choice is load-bearing.

## Reference material

The private development folder `docs/grokbot-reference/` contained local screenshots and written observations
used while designing the workspace layout. It is reference evidence, not
redistributable product imagery: the captures include account identity,
conversation text and third-party branding. That directory is excluded from this public snapshot. Do not publish it, and
do not copy its contents into seed data or marketing material.

## Extracted assets (removed)

`web/public/assets/grok/` previously held 31 logo images and sound files
captured from another application during design research. Nothing in `web/src/`
imported them, but Vite copies everything under `web/public/` into `web/dist/`,
so they were being included in production builds while serving no purpose.

They were third-party trademarks and artwork belonging to their respective
owners, and have been deleted. `web/public/` now contains only the retained
Aora licence files and the Geist fonts described above, both of which carry
licences that permit redistribution. Do not reintroduce captured third-party
assets there.

## DeepSeek Harness streaming and assembly

OpenAgents adapts LLM streaming protocols, block assembly and stream translation
from [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness),
pinned against upstream commit `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`.

The adapted files live in `src/evals/llm/`:
- `src/evals/llm/stream.ts` (adapted from `packages/llm/llm/src/assembler.ts` and `types.ts`)
- `src/evals/llm/chat-completions.ts` (adapted from `packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts`)
- `src/evals/llm/anthropic-messages.ts` (adapted from `packages/llm/llm-deepseek/src/protocols/messages/translate.ts`)

These files are licensed under the **MIT License**:

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

# OpenAgents document and OCR dependencies

## Bot desktop sandbox profile

`docker/bot-desktop/seccomp.json` is derived from Microsoft Playwright v1.63.0's Docker seccomp profile, copyright Microsoft Corporation, licensed under Apache-2.0. The license is included at `docker/bot-desktop/LICENSE.seccomp`. Local changes return ENOSYS for `clone3` and permit Chrome's `chroot` within its user namespace. Upstream source: https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json.

## Document and OCR libraries

The 0.3.6 build includes Tesseract.js 7.0.0 and its Tesseract core (Apache-2.0), bundled English/Arabic trained data from `@tesseract.js-data/eng` and `@tesseract.js-data/ara` 1.0.0 (MIT package metadata), and `@napi-rs/canvas` 1.0.9 (MIT). It also uses PDF.js (`pdfjs-dist`, Apache-2.0), docx, ExcelJS, PptxGenJS, image-size and fflate (MIT). These dependencies are installed from their published packages; their included license files remain with the packaged modules.

Upstream projects: https://github.com/naptha/tesseract.js, https://github.com/naptha/tesseract.js-core, https://github.com/naptha/tessdata, https://github.com/Brooooooklyn/canvas, https://github.com/mozilla/pdf.js, https://github.com/dolanmiu/docx, https://github.com/exceljs/exceljs, https://github.com/gitbrent/PptxGenJS.
