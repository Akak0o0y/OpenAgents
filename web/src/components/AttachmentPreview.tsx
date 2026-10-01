import { useEffect, useState } from 'react';
import { api } from '../lib/transport.js';
export function AttachmentPreview({ id }: { id:string }) {
  const [file,setFile]=useState<{name:string;data:string;mime?:string}|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{let gone=false;void api.systemAction('attachment-read',{id}).then(data=>{if(!gone)setFile(data);}).catch(()=>{if(!gone)setError('Attachment is unavailable.');});return()=>{gone=true;};},[id]);
  if(error)return <span role="status">{error}</span>;
  if(!file)return <span>Loading attachment…</span>;
  function download(){
    if(!file)return;
    const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0));
    const url=URL.createObjectURL(new Blob([bytes],{type:file.mime??'application/octet-stream'}));
    const link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <span className="oh-attachment-preview">
    {file.mime && /^image\/(png|jpeg|webp)$/.test(file.mime) && <img src={`data:${file.mime};base64,${file.data}`} alt={file.name} style={{display:'block',maxWidth:'100%',maxHeight:260}} />}
    <button type="button" onClick={download}>Download {file.name}</button>
  </span>;
}
