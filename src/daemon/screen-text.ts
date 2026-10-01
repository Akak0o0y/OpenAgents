import { createOcr } from './ocr.js';

/**
 * Reading the text that is actually on the bot's screen.
 *
 * A vision model guesses at small interface text, and guesses worst exactly where being
 * wrong costs most: a button label, a code, an amount. Tesseract reads it instead, and the
 * English and Arabic data the project already bundles covers the languages this owner
 * works in. Reading a region rather than the whole screen is what makes it useful - a
 * whole 1440x900 desktop OCRs into noise.
 */
export type ScreenRegion = { x: number; y: number; width: number; height: number };

/** Starting a worker copies language data and spawns a process, so one is shared. */
let shared: Promise<Awaited<ReturnType<typeof createOcr>>> | undefined;

async function worker() {
  // A failed start must not be cached, or every later read fails with a stale error.
  if (!shared) shared = createOcr().catch(error => { shared = undefined; throw error; });
  return shared;
}

async function crop(png: Buffer, region: ScreenRegion): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(png);
  const x = Math.min(region.x, Math.max(0, image.width - 1));
  const y = Math.min(region.y, Math.max(0, image.height - 1));
  const width = Math.max(1, Math.min(region.width, image.width - x));
  const height = Math.max(1, Math.min(region.height, image.height - y));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, -x, -y);
  return canvas.toBuffer('image/png');
}

export async function readScreenText(png: Buffer, region?: ScreenRegion): Promise<{ text: string; confidence: number; region?: ScreenRegion }> {
  const bytes = region ? await crop(png, region) : png;
  const ocr = await worker();
  const result = await ocr.read(bytes);
  return {
    // Tesseract pads with blank lines that carry no meaning to a reader.
    text: result.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    confidence: Math.round(result.confidence),
    region,
  };
}

/** Release the worker on shutdown; it holds a child process and a temporary directory. */
export async function closeScreenText(): Promise<void> {
  const pending = shared;
  shared = undefined;
  await pending?.then(ocr => ocr.close()).catch(() => undefined);
}
