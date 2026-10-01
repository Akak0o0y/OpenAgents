import path from 'node:path';

export function safeDownloadName(filename) {
  const leaf = String(filename).split(/[\\/]/).at(-1).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0,160);
  return !leaf || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf) ? 'OpenAgents-artifact.txt' : leaf;
}

/** Native Save dialog plus real DownloadItem completion, including blob files. */
export function attachDownloads(ses, { isTrusted, downloadsDirectory, onComplete = () => {} }) {
  const handler = (event, item, contents) => {
    if (!contents || !isTrusted(contents)) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: 'Save OpenAgents file', defaultPath: path.join(downloadsDirectory, safeDownloadName(item.getFilename())),
      buttonLabel: 'Save', properties: ['showOverwriteConfirmation', 'createDirectory'] });
    item.once('done', (_event, state) => onComplete({ state, path: state === 'completed' ? item.getSavePath() : null }));
  };
  ses.on('will-download', handler);
  return () => ses.off('will-download', handler);
}
