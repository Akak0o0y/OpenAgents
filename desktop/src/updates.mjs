import { createHash, verify, randomUUID } from 'node:crypto';
import fs from 'node:fs';

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Update URLs must use HTTPS without embedded credentials.');
  return url.href;
}
function version(value) {
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/.test(value)) throw new Error('Update version must contain three or four numeric parts.');
  return value.split('.').map(Number);
}
export function isNewer(next, current) {
  const a=version(next),b=version(current);
  for(let i=0;i<4;i++){const left=a[i]??0,right=b[i]??0;if(left!==right)return left>right;}return false;
}
async function bounded(response, limit) {
  if (!response.ok) throw new Error(`Update request returned HTTP ${response.status}.`);
  const parts=[];let size=0;
  for await (const part of response.body) {
    size+=part.length;
    if(size>limit) throw new Error('Update response exceeds its size limit.');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}
/** Feed and public key are bundled by the release owner, never taken from a model. */
export async function checkUpdate(channel, currentVersion, platform=process.platform, arch=process.arch, fetcher=fetch) {
  const response=await fetcher(httpsUrl(channel.feedUrl),{redirect:'error',signal:AbortSignal.timeout(15000)});
  const envelope=JSON.parse((await bounded(response,65536)).toString('utf8'));
  if(typeof envelope.payload!=='string'||typeof envelope.signature!=='string') throw new Error('Malformed signed update envelope.');
  const bytes=Buffer.from(envelope.payload,'base64');
  if(!verify(null,bytes,channel.publicKey,Buffer.from(envelope.signature,'base64'))) throw new Error('Update signature is invalid.');
  const manifest=JSON.parse(bytes.toString('utf8'));
  if(!isNewer(manifest.version,currentVersion))return null;
  if(!Array.isArray(manifest.assets))throw new Error('Update manifest has no assets.');
  const asset=manifest.assets.find(a=>a.platform===platform && a.arch===arch);
  if(!asset)throw new Error('This update has no installer for your platform.');
  if(!/^[a-f0-9]{64}$/.test(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>512*1024*1024)throw new Error('Invalid update asset size or hash.');
  const url=httpsUrl(asset.url);
  const extensions={win32:'.exe',darwin:'.dmg',linux:'.AppImage'};
  return {version:manifest.version,url,sha256:asset.sha256,bytes:asset.bytes,filename:`OpenAgents-${manifest.version}-${platform}-${arch}${extensions[platform]??'.bin'}`};
}
export async function downloadUpdate(asset, destination, fetcher=fetch) {
  const response=await fetcher(httpsUrl(asset.url),{redirect:'error',signal:AbortSignal.timeout(180000)});
  if (!response.ok) throw new Error(`Update request returned HTTP ${response.status}.`);
  const staging = `${destination}.${randomUUID()}.partial`;
  const fd = fs.openSync(staging, 'wx'); const hash = createHash('sha256'); let size = 0;
  try {
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > asset.bytes) throw new Error('Update response exceeds its size limit.');
        hash.update(chunk); fs.writeFileSync(fd, chunk);
      }
      if (size !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('Downloaded installer failed its size or checksum verification.');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // A hard link publishes the fully verified file atomically and refuses an
    // existing destination, including an attacker-created symbolic link.
    fs.linkSync(staging, destination);
  } finally { fs.unlinkSync(staging); }
  return destination;
}
