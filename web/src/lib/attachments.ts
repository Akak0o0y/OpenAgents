/**
 * Attachments.
 *
 * Text is inlined within the prompt budget. Supported binary files use the
 * authenticated upload callback and durable attachment IDs. The server extracts
 * document text or supplies typed images to an explicitly enabled vision model.
 * Base64 is never placed into conversational text.
 */

/** 64KB of text is roughly 16k tokens - already a large, costly message. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_ATTACHMENTS = 4;

/**
 * Extensions treated as text.
 *
 * An allowlist, not a `type.startsWith('text/')` check: browsers report
 * `application/json`, `application/x-yaml` and often an empty string for files
 * they do not recognise, so sniffing the MIME type alone rejects exactly the
 * files an operator most wants to paste in.
 */
const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'csv', 'tsv', 'log', 'sql', 'html', 'htm', 'xml', 'svg', 'css', 'scss',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'ps1', 'dockerfile', 'gitignore', 'patch', 'diff',
];

export interface Attachment {
  id: string;
  name: string;
  bytes: number;
  content: string;
}

export interface AttachmentRejection {
  name: string;
  reason: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.toLowerCase();
  return name.slice(dot + 1).toLowerCase();
}

export function looksTextual(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  return TEXT_EXTENSIONS.includes(extensionOf(file.name));
}

/** Human size, for a message the operator has to act on. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read files into attachments, reporting each refusal separately.
 *
 * A partial result is deliberate: dropping five files of which one is a PNG
 * should attach the other four and say why the fifth was left out, rather than
 * failing the whole gesture.
 */
export async function readAttachments(
  files: File[],
  alreadyAttached = 0,
  uploadBinary?: (file: File) => Promise<Attachment>
): Promise<{ attachments: Attachment[]; rejected: AttachmentRejection[] }> {
  const attachments: Attachment[] = [];
  const rejected: AttachmentRejection[] = [];

  for (const file of files) {
    if (alreadyAttached + attachments.length >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: `at most ${MAX_ATTACHMENTS} files per message` });
      continue;
    }
    if (!looksTextual(file)) {
      if (uploadBinary && /\.(png|jpe?g|webp|pdf|docx|xlsx|pptx)$/i.test(file.name)) {
        if(file.size>2*1024*1024){rejected.push({name:file.name,reason:'binary attachments must be at most 2 MB'});continue;}
        try { attachments.push(await uploadBinary(file)); }
        catch(cause){rejected.push({name:file.name,reason:cause instanceof Error?cause.message:'could not upload file'});}
        continue;
      }
      rejected.push({
        name: file.name,
        reason: 'This file requires a supported binary upload service. Use PNG, JPEG, WebP, PDF, DOCX, XLSX or PPTX in a conversation, or attach text.',
      });
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({
        name: file.name,
        reason: `${formatBytes(file.size)} is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit — its text becomes prompt tokens you pay for`,
      });
      continue;
    }

    try {
      const content = await file.text();
      attachments.push({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        bytes: file.size,
        content,
      });
    } catch (cause) {
      rejected.push({
        name: file.name,
        reason: cause instanceof Error ? cause.message : 'could not be read',
      });
    }
  }

  return { attachments, rejected };
}

/**
 * Fold attachments into the outgoing message.
 *
 * Fenced and labelled with the filename so the bot can tell the operator's own
 * words from the file, and so the transcript still reads as what was actually
 * sent - because it is.
 */
export function composeWithAttachments(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const blocks = attachments
    .map((a) => `Attached file: ${a.name} (${formatBytes(a.bytes)})\n\`\`\`\n${a.content}\n\`\`\``)
    .join('\n\n');
  return text.trim() ? `${text.trim()}\n\n${blocks}` : blocks;
}
