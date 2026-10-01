import { createHash } from 'node:crypto';
import https from 'node:https';
import type { AgentStore } from './agent-store.js';
import { ArtifactStore, workspacePath } from './artifacts.js';
import { readWorkResult } from './work-results.js';
import type { WorkContract } from './work-contract.js';
import { publicAddress, resolveAddresses } from './web-research.js';

type GitHubCall = (repository: string, method: 'GET' | 'POST', endpoint: string, body?: unknown) => Promise<any>;
export class GitHubError extends Error { constructor(readonly status: number) { super(`GitHub returned HTTP ${status}.`); } }

/** Fixed GitHub origin, no redirects, credentials only in headers, bounded response. */
export function githubClient(tokenFor: (repository: string) => string): GitHubCall {
  return async (repository, method, endpoint, body) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !endpoint.startsWith('/') || endpoint.includes('..')) throw new Error('Invalid GitHub destination.');
    const signal = AbortSignal.timeout(30000);
    const addresses = await resolveAddresses('api.github.com', signal);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('GitHub address is unavailable.');
    const token = tokenFor(repository);
    if (!token) throw new Error('GitHub publication credential is unavailable.');
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(`https://api.github.com/repos/${repository}${endpoint}`, { method, signal,
        lookup: (_host, _options, cb) => cb(null, addresses[0].address, addresses[0].family),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OpenAgents', 'X-GitHub-Api-Version': '2022-11-28',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 3 * 1024 * 1024) req.destroy(new Error('GitHub response exceeds 3 MiB.')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { reject(new GitHubError(res.statusCode ?? 0)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('GitHub returned invalid JSON.')); }
        });
      });
      req.on('error', () => reject(new Error('GitHub request failed; its outcome may be uncertain.')));
      req.end(data);
    });
  };
}

interface Preview {
  runId: string; repository: string; base: string; baseCommit: string; branch: string; title: string;
  files: Array<{ path: string; sha256: string; content: string | null; encoding?: 'base64' }>; digest: string;
}
interface Publication extends Preview { commit?: string; prUncertain?: boolean; url?: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sha = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('GitHub returned an invalid commit or tree ID.'); return value; };

export class RepositoryPublication {
  private readonly active = new Set<string>();
  constructor(private readonly store: AgentStore, private readonly artifacts: ArtifactStore, private readonly call: GitHubCall,
    private readonly permitted: (repository: string) => boolean) {}
  private files(runId: string) {
    const result = readWorkResult(this.store, runId);
    if (this.store.getTaskRun(runId)?.status !== 'COMPLETED' || result?.outcome !== 'COMPLETED') throw new Error('Only completed, verified repository work can be published.');
    if (!result.artifacts.some(a => a.path === 'openhours-review/verification.txt')) throw new Error('Repository verification evidence is missing.');
    const changes: Preview['files'] = result.artifacts.filter(a => !a.path.startsWith('openhours-review/')).map(a => {
      const file = this.artifacts.read(runId, a.id);
      if (!file || createHash('sha256').update(file.encoding==='base64'?Buffer.from(file.content,'base64'):file.content).digest('hex') !== a.sha256 || file.path !== a.path) throw new Error('A verified artifact changed or was removed. Run verification again before publishing.');
      const path = workspacePath(file.path);
      if (/^(\.git|\.github\/workflows)(\/|$)/.test(path)) throw new Error('Git internals and GitHub workflows cannot be published by this connector.');
      return { path, sha256: a.sha256, content: file.content, ...(file.encoding==='base64'?{encoding:'base64' as const}:{}) };
    });
    const manifestArtifact=result.artifacts.find(a=>a.path==='openhours-review/changes.json');
    if(manifestArtifact){
      const file=this.artifacts.read(runId,manifestArtifact.id);
      if(!file||file.encoding||hash(file.content)!==manifestArtifact.sha256)throw new Error('Verified change manifest changed.');
      const manifest=JSON.parse(file.content);
      if(manifest.version!==1||!Array.isArray(manifest.deleted)||manifest.deleted.length>16)throw new Error('Invalid change manifest.');
      for(const p of manifest.deleted){const path=workspacePath(p);if(/^(\.git|\.github\/workflows)(\/|$)/.test(path)||changes.some(c=>c.path===path))throw new Error('Invalid deletion in change manifest.');changes.push({path,sha256:hash('deleted:'+path),content:null});}
    }
    return changes.sort((a,b)=>a.path.localeCompare(b.path));
  }
  async preview(runId: string, base: string, title: string): Promise<Preview> {
    if (this.active.has(runId)) throw new Error('Publication is already in progress.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(base) || base.includes('..') || base.endsWith('/') || base.includes('//') || /[\r\n]/.test(title) || !title.trim() || title.length > 200) throw new Error('Supply a valid base branch and a title of 1–200 characters.');
    const contract = (this.store.getRunDefinition(runId) as {work?:{contract?:WorkContract}} | null)?.work?.contract;
    const target = contract?.repository;
    if (!target?.commit || target.owner === 'local') throw new Error('This run has no pinned GitHub repository.');
    const repository = `${target.owner}/${target.repo}`;
    if (!this.permitted(repository)) throw new Error('Publication is not enabled for this repository in the operator configuration.');
    const ref = await this.call(repository, 'GET', `/git/ref/heads/${base.split('/').map(encodeURIComponent).join('/')}`);
    if (this.active.has(runId)) throw new Error('Publication is already in progress.');
    if (sha(ref.object?.sha) !== target.commit) throw new Error('The base branch moved since verification. Start a new repository task against its current commit.');
    const files = this.files(runId);
    if (!files.length) throw new Error('No verified changed files to publish.');
    const value = { runId, repository, base, baseCommit: target.commit, branch: `openhours/run-${hash(runId).slice(0,24)}`, title: title.trim(), files };
    const preview = { ...value, digest: hash(JSON.stringify(value)) };
    const existing = this.read(runId);
    if (existing && (existing.commit || existing.url || existing.prUncertain) && existing.digest !== preview.digest) throw new Error('This run already has a different publication attempt.');
    this.save(existing?.digest === preview.digest ? { ...existing, ...preview } : preview);
    return preview;
  }
  private read(runId: string): Publication | null {
    const run = this.store.getTaskRun(runId);
    const row = run && this.store.getAgentData(run.agent_id, runId, 'repository-publication');
    return row ? JSON.parse(row.data_json) as Publication : null;
  }
  private save(value: Publication): void {
    const used=Number((this.store.getDatabase().prepare("SELECT TOTAL(LENGTH(CAST(data_json AS BLOB))) AS n FROM agent_data WHERE category='repository-publication' AND key != ?").get(value.runId) as {n:number}).n);
    if(used+Buffer.byteLength(JSON.stringify(value))>64*1024*1024)throw new Error('Publication records reached the 64 MiB installation limit.');
    this.store.setAgentData({ agentId: this.store.getTaskRun(value.runId)!.agent_id, taskRunId: value.runId, category: 'repository-publication', key: value.runId, data: value });
  }
  async publish(runId: string, approvedDigest: string): Promise<{ url: string; commit: string }> {
    if (this.active.has(runId)) throw new Error('Publication is already in progress.');
    this.active.add(runId);
    try {
      const p = this.read(runId);
      if (!p || p.digest !== approvedDigest) throw new Error('Review and approve the exact publication preview first.');
      if (!this.permitted(p.repository)) throw new Error('Publication permission has been removed.');
      if (p.url && p.commit) return { url: p.url, commit: p.commit };
      if (JSON.stringify(this.files(runId)) !== JSON.stringify(p.files)) throw new Error('Verified artifacts changed after the preview.');
      const event=(event_type:string,detail:unknown)=>this.store.recordEvent({task_run_id:runId,agent_id:this.store.getTaskRun(runId)!.agent_id,event_type,
        payload_json:JSON.stringify(detail),timestamp:Date.now()});
      const ref = await this.call(p.repository, 'GET', `/git/ref/heads/${p.base.split('/').map(encodeURIComponent).join('/')}`);
      if (sha(ref.object?.sha) !== p.baseCommit) throw new Error('The base branch moved after the preview. Re-run repository verification.');
      event('EXTERNAL_ACTION_STARTED',{kind:'repository-publication',repository:p.repository,digest:p.digest,branch:p.branch});
      if (!p.commit) {
        const base = await this.call(p.repository, 'GET', `/git/commits/${p.baseCommit}`);
        // Preserve executable file modes. Refuse symlinks/submodules rather than silently turning them into files.
        const tree = await this.call(p.repository, 'GET', `/git/trees/${sha(base.tree?.sha)}?recursive=1`);
        if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('The base tree is too large for safe publication.');
        const entries = [];
        for (const file of p.files) {
          const old = tree.tree.find((entry: any) => entry.path === file.path);
          if (old && !['100644', '100755'].includes(old.mode)) throw new Error(`Unsupported Git entry: ${file.path}`);
          if(file.content===null){if(old)entries.push({path:file.path,mode:old.mode,type:'blob',sha:null});continue;}
          if(file.encoding==='base64'){
            const blob=await this.call(p.repository,'POST','/git/blobs',{content:file.content,encoding:'base64'});
            entries.push({path:file.path,mode:old?.mode??'100644',type:'blob',sha:sha(blob.sha)});
          }else entries.push({ path: file.path, mode: old?.mode ?? '100644', type: 'blob', content: file.content });
        }
        const next = await this.call(p.repository, 'POST', '/git/trees', { base_tree: sha(base.tree?.sha), tree: entries });
        const commit = await this.call(p.repository, 'POST', '/git/commits', { message: p.title, tree: sha(next.sha), parents: [p.baseCommit] });
        p.commit = sha(commit.sha); this.save(p);
      }
      let branch;
      try { branch = await this.call(p.repository, 'GET', `/git/ref/heads/${p.branch}`); }
      catch (error) { if (!(error instanceof GitHubError) || error.status !== 404) throw error; }
      if (branch && sha(branch.object?.sha) !== p.commit) throw new Error('The publication branch has unexpected changes. It will not be overwritten.');
      if (!branch) await this.call(p.repository, 'POST', '/git/refs', { ref: `refs/heads/${p.branch}`, sha: p.commit });
      const pulls = await this.call(p.repository, 'GET', `/pulls?state=all&head=${encodeURIComponent(`${p.repository.split('/')[0]}:${p.branch}`)}&base=${encodeURIComponent(p.base)}`);
      if (!Array.isArray(pulls)) throw new Error('GitHub returned an invalid pull request list.');
      let pr = pulls.find((candidate: any) => candidate.head?.sha === p.commit && candidate.head?.ref === p.branch && candidate.base?.ref === p.base);
      if (!pr) {
        if (pulls.length || p.prUncertain) throw new Error('A prior pull request attempt is uncertain or changed. Inspect GitHub before retrying; no duplicate was created.');
        p.prUncertain = true; this.save(p); // Before dispatch: a crash cannot turn an uncertain POST into a blind replay.
        pr = await this.call(p.repository, 'POST', '/pulls', { title: p.title, head: p.branch, base: p.base, draft: true,
          body: `Prepared from OpenAgents verified run ${p.runId}.\n\nBase commit: ${p.baseCommit}\nReview the changed files and the repository tests before merging.` });
      }
      const url = new URL(pr.html_url);
      if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${p.repository}/pull/`)) throw new Error('GitHub returned an unexpected pull request URL.');
      p.url = url.href; p.prUncertain = false; this.save(p);
      event('EXTERNAL_ACTION_FINISHED',{kind:'repository-publication',repository:p.repository,digest:p.digest,url:p.url,commit:p.commit});
      return { url: p.url, commit: p.commit! };
    } finally { this.active.delete(runId); }
  }
}
