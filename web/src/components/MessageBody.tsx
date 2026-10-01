/**
 * A message, typeset.
 *
 * Models answer in Markdown whether or not anything renders it, so a transcript
 * that prints the source shows `**bold**`, `###` and raw table pipes to the
 * user. This turns that back into text.
 *
 * WHY react-markdown RATHER THAN A MARKDOWN-TO-HTML LIBRARY. The obvious
 * approach - `marked` into `dangerouslySetInnerHTML` - means putting model
 * output into the DOM as HTML, and then needing a sanitiser to be correct
 * forever to stay safe. react-markdown builds React elements directly: there
 * is no HTML string at any point, so a model that emits `<script>` produces
 * the *characters* `<script>`, not an element. `remark-gfm` adds the tables,
 * strikethrough and task lists models actually use.
 *
 * USER MESSAGES ARE NOT RENDERED. What someone typed should appear as they
 * typed it - an asterisk they meant literally is not emphasis, and a line that
 * happens to start with `#` is not a heading. Only the model's side is
 * Markdown, because only the model is writing it.
 */

import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './ui/CodeBlock.js';
import { Collapsible } from './ui/Collapsible.js';
import { AttachmentPreview } from './AttachmentPreview.js';

interface MessageBodyProps {
  content: string;
  /** User text is shown verbatim; only assistant output is treated as Markdown. */
  markdown: boolean;
  onOpenFile?: (file: { path: string; runId?: string | null; artifactUrl?: string | null }) => void;
  runId?: string | null;
}

/**
 * Links go to the browser, not to this window.
 *
 * In the desktop shell a navigation is intercepted by the main process and
 * opened externally, but `target="_blank"` plus `rel` is what makes it behave
 * in a plain browser tab too - and `noreferrer` keeps the daemon's local
 * address out of the Referer header on the way out.
 */
function Anchor({
  href,
  children,
  onOpenFile,
  runId,
}: {
  href?: string;
  children?: React.ReactNode;
  onOpenFile?: (file: { path: string; runId?: string | null; artifactUrl?: string | null }) => void;
  runId?: string | null;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isArtifact = href && /^\/api\/runs\/[a-zA-Z0-9_-]+\/artifacts\/[a-zA-Z0-9_-]+$/.test(href);
  if (isArtifact) {
    const artifactMatch = href.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/artifacts\/[a-zA-Z0-9_-]+$/);
    const artifactRunId = artifactMatch ? artifactMatch[1] : runId;
    const fileName = typeof children === 'string' ? children : 'deliverable';
    const binaryDownload = /\.(docx|xlsx|pptx|pdf|png|jpe?g|webp|zip)$/i.test(fileName);
    const download = async () => {
      setBusy(true); setError('');
      try {
        const response = await fetch(href);
        if (!response.ok) throw new Error(`File download failed (${response.status}).`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'artifact.txt';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Download failed.'); }
      finally { setBusy(false); }
    };
    return (
      <>
        <button
          type="button"
          className="grok-artifact-download"
          disabled={busy}
          onClick={() => {
            if (onOpenFile && !binaryDownload) {
              onOpenFile({ path: fileName, runId: artifactRunId, artifactUrl: href });
            } else {
              void download();
            }
          }}
          title={onOpenFile && !binaryDownload ? `Preview ${fileName}` : `Download ${fileName}`}
        >
          {children}{busy ? ' (downloading)' : ''}
        </button>
        {error && <span role="alert">{error}</span>}
      </>
    );
  }

  const isLocalFileLink =
    href &&
    !href.startsWith('http://') &&
    !href.startsWith('https://') &&
    !href.startsWith('mailto:') &&
    !href.startsWith('#');

  if (isLocalFileLink && onOpenFile) {
    const cleanPath = href.replace(/^file:\/\//, '').replace(/^\.\//, '');
    return (
      <button
        type="button"
        className="grok-file-link-inline"
        onClick={(e) => {
          e.preventDefault();
          onOpenFile({ path: cleanPath, runId });
        }}
        title={`Preview ${cleanPath}`}
      >
        {children}
      </button>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/**
 * A table that can scroll on its own.
 *
 * Model output routinely contains tables wider than a chat column. Without a
 * scroll container of its own, one of them widens the whole transcript and
 * every other message goes with it.
 */
function Table({ children }: { children?: React.ReactNode }) {
  return (
    <div className="grok-md-tablewrap">
      <table>{children}</table>
    </div>
  );
}

export const MessageBody = memo(function MessageBody({
  content,
  markdown,
  onOpenFile,
  runId,
}: MessageBodyProps) {
  if (!markdown) {
    const parts=content.split(/(\[\[openhours-attachment:[a-f0-9-]{36}\]\])/g);
    let count=0;
    return <>{parts.map((part,i)=>{
      const id=/^\[\[openhours-attachment:([a-f0-9-]{36})\]\]$/.exec(part)?.[1];
      return id && count++<4 ? <AttachmentPreview key={i} id={id}/> : part;
    })}</>;
  }

  const CustomAnchor = (props: { href?: string; children?: React.ReactNode }) => (
    <Anchor {...props} onOpenFile={onOpenFile} runId={runId} />
  );

  return (
    // Folded when it is tall enough to bury the rest of the conversation. The
    // threshold is measured, not counted - see Collapsible.
    <Collapsible label="reply">
      <div className="grok-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          // No rehype-raw: embedded HTML in model output stays text. That is the
          // property that makes the sanitiser unnecessary rather than merely
          // absent.
          components={{ a: CustomAnchor, table: Table, pre: CodeBlock }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </Collapsible>
  );
});
