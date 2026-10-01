import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { Icon } from './ui/icons.js';
import { IconButton, Button } from './ui/Button.js';
import { Spinner } from '@/registry/default/ui/spinner.js';
import { api } from '../lib/transport.js';
import { desktopBridge } from '../lib/desktop.js';
import type { SelectedWorkspaceFile } from './workspaceTypes.js';
import type { CodeThemePreference } from '../lib/preferences.js';

export interface GrokFileViewerProps {
  file: SelectedWorkspaceFile | null | undefined;
  agentName: string;
  codeTheme?: CodeThemePreference;
  onBack: () => void;
  onClose: () => void;
}

export function GrokFileViewer({
  file,
  agentName: _agentName,
  codeTheme = 'openhours',
  onBack,
  onClose,
}: GrokFileViewerProps) {
  const [content, setContent] = useState<string | null>(file?.content ?? null);
  const [draftContent, setDraftContent] = useState<string | null>(file?.content ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeLine, setActiveLine] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const filePath = file?.path ?? '';
  const isHtml = useMemo(() => /\.(html?|xhtml)$/i.test(filePath), [filePath]);
  const isImage = useMemo(() => /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(filePath), [filePath]);

  const [viewMode, setViewMode] = useState<'preview' | 'code'>(() => (isHtml ? 'preview' : 'code'));

  const isDirty = useMemo(
    () => draftContent !== null && content !== null && draftContent !== content,
    [draftContent, content]
  );
  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);
  const canLeave = useCallback(
    () => !saving && (!isDirty || window.confirm('Discard your unsaved changes?')),
    [isDirty, saving]
  );

  useEffect(() => {
    const returnToChat = () => {
      if (canLeave()) onClose();
    };
    const bridge = desktopBridge();
    if (bridge?.keyboard) return bridge.keyboard.onEscape(returnToChat);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      returnToChat();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canLeave, onClose]);

  const lineCount = useMemo(() => {
    if (draftContent === null) return 1;
    return (draftContent.split('\n')).length;
  }, [draftContent]);

  const lineNumbers = useMemo(
    () => Array.from({ length: Math.max(1, lineCount) }, (_, i) => i + 1),
    [lineCount]
  );

  useEffect(() => {
    setViewMode(isHtml ? 'preview' : 'code');
  }, [filePath, isHtml]);

  useEffect(() => {
    if (!file) {
      setContent(null);
      setDraftContent(null);
      setError('No file selected.');
      return;
    }

    setTruncated(false);
    setSaveSuccess(false);
    setSaveError(null);
    if (refreshKey === 0 && file.content !== undefined && file.content !== null) {
      setContent(file.content);
      setDraftContent(file.content);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    setSaveError(null);

    async function load() {
      try {
        if (file?.runId && file.path) {
          try {
            const res = await api.workspaceFile(file.runId, file.path);
            if (active) {
              if (res.available) {
                setContent(res.content);
                setDraftContent(res.content);
                setTruncated(!!res.truncated);
                setLoading(false);
                return;
              }
            }
          } catch (err: any) {
            // Workspace volume might be reaped; try artifactUrl fallback if present
            if (!file?.artifactUrl) {
              throw err;
            }
          }
        }

        if (file?.artifactUrl) {
          const res = await fetch(file.artifactUrl);
          if (!res.ok) throw new Error(`Failed to load file: HTTP ${res.status}`);
          const text = await res.text();
          if (active) {
            setContent(text);
            setDraftContent(text);
            setTruncated(false);
            setLoading(false);
            return;
          }
        }

        throw new Error('File content could not be retrieved from workspace.');
      } catch (err: any) {
        if (active) {
          setError(err?.message ?? 'Failed to load file');
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [file?.runId, file?.path, file?.artifactUrl, file?.content, refreshKey]);

  const updateActiveLine = useCallback(() => {
    if (!textareaRef.current) return;
    const pos = textareaRef.current.selectionStart;
    const textBefore = textareaRef.current.value.substring(0, pos);
    const lineIndex = textBefore.split('\n').length - 1;
    setActiveLine(lineIndex);
  }, []);

  const handleScroll = useCallback(() => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!isDirty || saving || truncated || draftContent === null || content === null) return;
    if (!file?.runId || !file?.path) {
      setSaveError('Cannot save: file is not associated with a task run.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.saveWorkspaceFile(file.runId, file.path, draftContent, content);
      if (!mounted.current) return;
      if (res.success) {
        setContent(draftContent);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2500);
      } else {
        setSaveError(res.reason ?? 'Failed to save changes.');
      }
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save changes.');
    } finally {
      setSaving(false);
    }
  }, [isDirty, saving, truncated, content, draftContent, file]);

  const handleRevert = useCallback(() => {
    setDraftContent(content);
    setSaveError(null);
  }, [content]);

  const handleCopy = async () => {
    const textToCopy = draftContent ?? content;
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleOpenExternal = () => {
    if (file?.artifactUrl && !isDirty) {
      window.open(file.artifactUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const textToOpen = draftContent ?? content;
    if (textToOpen) {
      const mime = isHtml ? 'text/html' : 'text/plain';
      const blob = new Blob([textToOpen], { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      if (win) {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (saving || truncated) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void handleSave();
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;

      if (e.shiftKey) {
        // Shift+Tab: Outdent
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = val.indexOf('\n', end);
        const actualEnd = lineEnd === -1 ? val.length : lineEnd;
        const block = val.substring(lineStart, actualEnd);
        const lines = block.split('\n');
        let removedFirst = 0;
        let totalRemoved = 0;

        const outdented = lines
          .map((line, idx) => {
            let remove = 0;
            if (line.startsWith('  ')) remove = 2;
            else if (line.startsWith(' ') || line.startsWith('\t')) remove = 1;
            if (idx === 0) removedFirst = remove;
            totalRemoved += remove;
            return line.slice(remove);
          })
          .join('\n');

        const nextVal = val.substring(0, lineStart) + outdented + val.substring(actualEnd);
        setDraftContent(nextVal);
        requestAnimationFrame(() => {
          textarea.selectionStart = Math.max(lineStart, start - removedFirst);
          textarea.selectionEnd = Math.max(lineStart, end - totalRemoved);
          updateActiveLine();
        });
      } else {
        // Tab: Indent
        if (start === end) {
          const nextVal = val.substring(0, start) + '  ' + val.substring(end);
          setDraftContent(nextVal);
          requestAnimationFrame(() => {
            textarea.selectionStart = textarea.selectionEnd = start + 2;
            updateActiveLine();
          });
        } else {
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          const lineEnd = val.indexOf('\n', end);
          const actualEnd = lineEnd === -1 ? val.length : lineEnd;
          const block = val.substring(lineStart, actualEnd);
          const lines = block.split('\n');
          const indented = lines.map((line) => '  ' + line).join('\n');
          const nextVal = val.substring(0, lineStart) + indented + val.substring(actualEnd);
          setDraftContent(nextVal);
          requestAnimationFrame(() => {
            textarea.selectionStart = start + 2;
            textarea.selectionEnd = end + lines.length * 2;
            updateActiveLine();
          });
        }
      }
      return;
    }

    if (e.key === 'Enter') {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;

      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const currentLine = val.substring(lineStart, start);
      const indentMatch = currentLine.match(/^[ \t]+/);
      const indent = indentMatch ? indentMatch[0] : '';

      e.preventDefault();
      const nextVal = val.substring(0, start) + '\n' + indent + val.substring(end);
      setDraftContent(nextVal);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1 + indent.length;
        updateActiveLine();
      });
      return;
    }
  };

  if (!file) {
    return (
      <div className="grok-file-viewer-empty">
        <p>No file selected.</p>
        <Button kind="secondary" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className={`grok-file-viewer ${fullscreen ? 'is-fullscreen' : ''} theme-${codeTheme}`}>
      <header className="grok-file-viewer-header">
        <div className="grok-file-viewer-title-group">
          <IconButton onClick={() => { if (canLeave()) onBack(); }} aria-label="Back to workspace" title="Back to workspace" disabled={saving}>
            <Icon name="back" size={16} />
          </IconButton>
          <div className="grok-file-viewer-name-box">
            <Icon name={isImage ? 'image' : 'file'} size={15} />
            <span className="grok-file-viewer-filename" title={filePath}>
              {filePath}
            </span>
            {isDirty && (
              <span className="grok-file-dirty-indicator" title="Unsaved changes">
                ●
              </span>
            )}
          </div>
        </div>

        <div className="grok-file-viewer-actions">
          {isHtml && (
            <div className="grok-file-viewmode-tabs" role="tablist" aria-label="View mode">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'preview'}
                className={`grok-file-tab-btn ${viewMode === 'preview' ? 'active' : ''}`}
                onClick={() => setViewMode('preview')}
              >
                <Icon name="preview" size={13} />
                <span>Preview</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'code'}
                className={`grok-file-tab-btn ${viewMode === 'code' ? 'active' : ''}`}
                onClick={() => setViewMode('code')}
              >
                <span>Code</span>
              </button>
            </div>
          )}

          {/* Save Button for Code View */}
          <button
            type="button"
            className={`grok-file-save-btn ${isDirty ? 'is-dirty' : ''} ${saveSuccess ? 'is-saved' : ''}`}
            onClick={() => void handleSave()}
            disabled={!isDirty || saving || truncated || !file.runId}
            title={isDirty ? 'Save changes (Ctrl+S)' : 'No changes to save'}
          >
            {saving ? (
              <>
                <Spinner className="grok-save-spinner" />
                <span>Saving…</span>
              </>
            ) : saveSuccess ? (
              <>
                <Icon name="done" size={12} motion={false} />
                <span>Saved</span>
              </>
            ) : (
              <>
                <Icon name="done" size={12} motion={false} />
                <span>Save</span>
              </>
            )}
          </button>

          {isDirty && (
            <IconButton
              onClick={handleRevert}
              disabled={saving}
              aria-label="Discard changes"
              title="Discard changes and revert to saved"
            >
              <Icon name="back" size={14} />
            </IconButton>
          )}

          <IconButton
            onClick={() => { if (canLeave()) setRefreshKey((k) => k + 1); }}
            disabled={saving}
            aria-label="Reload file"
            title="Reload file"
          >
            <Icon name="refresh" size={14} />
          </IconButton>

          <IconButton
            onClick={handleCopy}
            aria-label={copied ? 'Copied!' : 'Copy file content'}
            title={copied ? 'Copied!' : 'Copy file content'}
            disabled={!content && !draftContent}
          >
            <Icon name={copied ? 'ok' : 'copy'} size={14} />
          </IconButton>

          <IconButton
            onClick={handleOpenExternal}
            aria-label="Open in new window"
            title="Open in new window"
            disabled={!content && !draftContent && !file.artifactUrl}
          >
            <Icon name="open" size={14} />
          </IconButton>

          <IconButton
            onClick={() => setFullscreen((fs) => !fs)}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <Icon name={fullscreen ? 'collapse' : 'expand'} size={14} />
          </IconButton>

          <IconButton onClick={() => { if (canLeave()) onClose(); }} aria-label="Close file viewer" title="Close file viewer" disabled={saving}>
            <Icon name="close" size={14} />
          </IconButton>
        </div>
      </header>

      {saveError && (
        <div className="grok-file-viewer-banner error">
          <span>Failed to save: {saveError}</span>
        </div>
      )}

      {truncated && (
        <div className="grok-file-viewer-banner warning">
          <span>Only part of this file is loaded. Download the full file to edit it safely.</span>
        </div>
      )}

      <div className="grok-file-viewer-body">
        {loading && (
          <div className="grok-file-viewer-status">
            <Spinner className="grok-spinner-icon" />
            <span>Loading {filePath}…</span>
          </div>
        )}

        {!loading && error && (
          <div className="grok-file-viewer-status error">
            <p className="grok-file-error-msg">{error}</p>
            <Button kind="secondary" onClick={() => setRefreshKey((k) => k + 1)}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && (
          <>
            {isHtml && viewMode === 'preview' ? (
              <div className="grok-file-preview-container">
                <iframe
                  srcDoc={draftContent ?? content ?? ''}
                  sandbox="allow-scripts allow-forms allow-popups"
                  title={filePath}
                  className="grok-file-preview-iframe"
                />
              </div>
            ) : isImage && file.artifactUrl ? (
              <div className="grok-file-image-preview">
                <img src={file.artifactUrl} alt={filePath} />
              </div>
            ) : (
              <div className="grok-file-code-container">
                <div className={`grok-code-editor theme-${codeTheme}`}>
                  <div className="grok-code-gutter" ref={gutterRef} aria-hidden="true">
                    {lineNumbers.map((num) => (
                      <div
                        key={num}
                        className={`grok-code-line-number ${num === activeLine + 1 ? 'is-active' : ''}`}
                      >
                        {num}
                      </div>
                    ))}
                  </div>
                  <div className="grok-code-textarea-wrap">
                    <textarea
                      ref={textareaRef}
                      className="grok-code-textarea"
                      value={draftContent ?? ''}
                      readOnly={truncated || saving}
                      wrap="off"
                      onChange={(e) => {
                        setDraftContent(e.target.value);
                        updateActiveLine();
                      }}
                      onKeyDown={handleKeyDown}
                      onScroll={handleScroll}
                      onClick={updateActiveLine}
                      onKeyUp={updateActiveLine}
                      onSelect={updateActiveLine}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                      autoCorrect="off"
                      aria-label={`Code editor for ${filePath}`}
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {!loading && !error && !isImage && (
        <footer className="oh-editor-status" aria-live="polite">
          <span>{truncated ? 'Read-only preview' : saving ? 'Saving…' : isDirty ? 'Unsaved changes' : isHtml && viewMode === 'preview' ? 'Open Code to edit' : 'Click code to edit'}</span>
          <span>Esc to chat · Ln {activeLine + 1} · {lineCount} lines · Ctrl / ⌘ S to save</span>
        </footer>
      )}
    </div>
  );
}
