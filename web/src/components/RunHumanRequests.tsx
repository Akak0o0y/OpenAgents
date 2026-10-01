import {useEffect, useRef, useState} from 'react';
import {getJson, sendCommand, type ApprovalRow} from '../lib/transport.js';
import {GrokQuestionCard, parseApproval} from './GrokQuestionCard.js';

/** Keep a scheduled run's response controls outside its scrolling activity history. */
export function RunHumanRequests({runId, agentId, waiting}: {runId:string; agentId:string; waiting:boolean}) {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [busy, setBusy] = useState<string|null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true; return () => { mounted.current=false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await getJson<{approvals:ApprovalRow[]}>(`/api/approvals?run=${encodeURIComponent(runId)}`, controller.signal);
        if (!controller.signal.aborted) {
          setRows(data.approvals.filter(row => row.task_run_id===runId && row.agent_id===agentId && row.kind==='human-assist' && row.status==='PENDING'));
          setLoadError('');
          setLoaded(true);
        }
      } catch {
        if (!controller.signal.aborted && waiting) setLoadError('Could not load the request. Reconnecting…');
      } finally {
        if (!controller.signal.aborted) timer=setTimeout(read, 3000);
      }
    };
    void read();
    return () => {controller.abort(); clearTimeout(timer);};
  }, [runId, agentId, waiting, revision]);

  const answer = async (id:string, decision:'approve'|'deny', reason?:string) => {
    if (submitting.current) return;
    submitting.current=true; setBusy(id); setError('');
    try {
      const result=await sendCommand(decision,id,reason?{reason}:undefined);
      if (!result?.success) throw new Error(result?.error || 'The response was not acknowledged. Try again.');
      if (mounted.current) {setRows(current=>current.filter(row=>row.id!==id)); setRevision(n=>n+1);}
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error?cause.message:'Your response could not be sent. Try again.');
    } finally {
      submitting.current=false;
      if (mounted.current) setBusy(null);
    }
  };
  if (!rows.length && !error && !waiting) return null;
  return <section className="oh-run-human-requests" aria-label="Human assistance">
    <strong>Waiting for your response</strong>
    {error && <p role="alert">{error}</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {!rows.length && waiting && !error && !loadError && <p role="status">{loaded ? 'No pending request. Waiting for the run to update…' : 'Loading the request…'}</p>}
    {rows.map(row=><GrokQuestionCard key={row.id} approval={parseApproval(row)} busy={busy===row.id} onAnswer={(id,decision,reason)=>{void answer(id,decision,reason);}}/>)}
  </section>;
}
