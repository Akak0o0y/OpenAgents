/** One installation-wide admission limit, shared by chat and scheduled executors. */
export class RunCapacity {
  private readonly active = new Set<string>();
  private readonly loans = new Map<string, string>();
  private readonly owners = new Map<string,string>();
  private readonly queue:Array<{runId:string;agentId:string;signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:unknown)=>void;cleanup:()=>void}>=[];
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Run concurrency must be a positive integer.');
  }
  get used(): number { return this.active.size; }
  isWaiting(runId:string){return this.queue.some(q=>q.runId===runId);}
  acquire(runId: string, agentId?:string): (() => void) | null {
    if(agentId&&[...this.owners.values()].includes(agentId))return null;
    if (this.active.has(runId) || [...this.loans.values()].includes(runId) || this.active.size >= this.limit) return null;
    this.active.add(runId);
    if(agentId)this.owners.set(runId,agentId);
    let released = false;
    return () => { if (!released) { released = true; this.active.delete(runId);this.owners.delete(runId);this.drain(); } };
  }

  /** Acquire bot ownership and a global slot together; waiting never consumes either. */
  wait(runId:string,agentId:string,signal:AbortSignal):Promise<()=>void>{
    signal.throwIfAborted();
    if(this.queue.some(q=>q.runId===runId)||this.active.has(runId))return Promise.reject(new Error('Run already admitted or queued.'));
    const release=this.acquire(runId,agentId);if(release)return Promise.resolve(release);
    if(this.queue.length>=100)return Promise.reject(new Error('Run admission queue is full.'));
    return new Promise((resolve,reject)=>{
      const cancel=()=>{const i=this.queue.findIndex(q=>q.runId===runId);if(i>=0){const [q]=this.queue.splice(i,1);q!.cleanup();reject(signal.reason??new Error('Queue wait cancelled.'));this.drain();}};
      const timer=setTimeout(()=>{const i=this.queue.findIndex(q=>q.runId===runId);if(i>=0){const [q]=this.queue.splice(i,1);q!.cleanup();reject(new Error('Resource wait exceeded five minutes.'));this.drain();}},300000);
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);};
      this.queue.push({runId,agentId,signal,resolve,reject,cleanup});signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    });
  }
  private drain(){for(let i=0;i<this.queue.length&&this.used<this.limit;){const q=this.queue[i]!;const release=this.acquire(q.runId,q.agentId);if(!release){i++;continue;}this.queue.splice(i,1);q.cleanup();q.resolve(release);}}

  /** A synchronous child borrows its suspended parent's slot, even at limit=1. */
  acquireChild(parentRunId: string, childRunId: string): (() => void) | null {
    if (!this.active.has(parentRunId)) return this.acquire(childRunId);
    if (parentRunId === childRunId || this.loans.has(parentRunId) || this.active.has(childRunId) || [...this.loans.values()].includes(childRunId)) return null;
    this.loans.set(parentRunId, childRunId);
    return () => { if (this.loans.get(parentRunId) === childRunId) this.loans.delete(parentRunId); };
  }
}
