/**
 * The selected run's live workspace.
 *
 * A finished run has had its volume reaped, and the daemon says so with a
 * reason. That reason is shown verbatim: "no files" and "the workspace no longer
 * exists" are different facts and the operator needs to tell them apart.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../lib/transport.js';
import { useCortex } from '../store.js';
import { Icon } from './ui/icons.js';
import { CortexEmpty } from './CortexKit.js';
import { RepositoryPublication } from './RepositoryPublication.js';

export function WorkspaceBrowser() {
  const runId = useCortex((s) => s.selectedRunId);
  const [files, setFiles] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [open, setOpen] = useState<{ file: string; content: string; truncated: boolean } | null>(null);

  useEffect(() => {
    setFiles([]);
    setOpen(null);
    setUnavailable(null);
    if (!runId) return;

    let cancelled = false;
    api.workspace(runId)
      .then((res) => { if (!cancelled) { if (res.available) setFiles(res.files); else setUnavailable(res.reason); } })
      .catch((err) => { if (!cancelled) setUnavailable(err.message); });
    return () => { cancelled = true; };
  }, [runId]);

  if (!runId) {
    return (
      <CortexEmpty icon="file" title="No run selected">
        Pick a run to browse the files in its workspace.
      </CortexEmpty>
    );
  }
  if (unavailable) {
    return (
      <CortexEmpty icon="warn" title="Workspace unavailable">
        {unavailable}
      </CortexEmpty>
    );
  }
  if (files.length === 0) {
    return (
      <div className="cx-loading">
        <span className="cx-spinner" aria-hidden="true" />
        Reading workspace…
      </div>
    );
  }

  return (
    <div className="cx-stack">
      {files.includes('openhours-review/verification.txt') && <RepositoryPublication key={runId} runId={runId} />}
      <ul className="cx-files">
        {files.map((file, index) => (
          <li key={file} style={{ '--i': Math.min(index, 20) } as CSSProperties}>
            <button
              type="button"
              className={`cx-file ${open?.file === file ? 'is-on' : ''}`}
              aria-pressed={open?.file === file}
              onClick={() =>
                api.workspaceFile(runId, file)
                  .then((res) => setOpen({ file, content: res.content, truncated: res.truncated }))
                  .catch((err) => setOpen({ file, content: `Could not read: ${err.message}`, truncated: false }))
              }
            >
              <Icon name="file" size={14} motion={false} />
              <span>{file}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="cx-code" key={open.file}>
          <div className="cx-code-head">
            <Icon name="file" size={13} motion={false} />
            <span>{open.file}</span>
            {open.truncated && <em>Truncated by the daemon read cap</em>}
          </div>
          <pre>{open.content}</pre>
        </div>
      )}
    </div>
  );
}
