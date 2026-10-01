import { useEffect, useState } from 'react';
import { api } from '../lib/transport.js';

interface Question { id: string; threadId?: string; question: string; options: string[]; state: string; purpose?: string }
export function WorkQuestions({ agentId, threadId }: { agentId: string; threadId: string | null }) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setQuestions([]); setAnswers({}); setError('');
    const refresh = async () => {
      try {
        const data = await api.systemAction('questions', { agentId });
        if (!disposed) setQuestions((data?.questions ?? []).filter((q: Question) => q.state === 'pending' && q.purpose !== 'browser-signin' && (!q.threadId || q.threadId === threadId)));
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [agentId, threadId]);
  const submit = async (id: string, answer?: string) => {
    setBusy(id); setError('');
    try {
      await api.systemAction(answer === undefined ? 'question-cancel' : 'question-answer', { agentId, id, ...(answer === undefined ? {} : { answer }) });
      setQuestions(rows => rows.filter(q => q.id !== id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  return <>
    {questions.map(q => <article key={q.id} className="grok-question-card" aria-label="Saved task question">
      <h3 className="grok-question-title">{q.question}</h3>
      <p>The task is paused. Your answer resumes it with its saved work.</p>
      <div className="grok-question-options">
        {q.options.map((option, i) => <button type="button" className="grok-question-answer-row" key={i} disabled={busy !== null} onClick={() => void submit(q.id, option)}>{option}</button>)}
      </div>
      <form onSubmit={e => { e.preventDefault(); if (answers[q.id]?.trim()) void submit(q.id, answers[q.id]); }}>
        <textarea aria-label={`Answer: ${q.question}`} maxLength={8000} value={answers[q.id] ?? ''} disabled={busy !== null} onChange={e => setAnswers(old => ({ ...old, [q.id]: e.target.value }))} />
        <button type="submit" disabled={busy !== null || !answers[q.id]?.trim()}>Answer and resume</button>
        <button type="button" disabled={busy !== null} onClick={() => void submit(q.id)}>Cancel question</button>
      </form>
    </article>)}
    {error && <p role="alert">{error}</p>}
  </>;
}
