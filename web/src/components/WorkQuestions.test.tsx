import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkQuestions } from './WorkQuestions.js';
import { RepositoryPublication } from './RepositoryPublication.js';
import { api } from '../lib/transport.js';
afterEach(()=>vi.restoreAllMocks());
it('a saved question remains answerable without an active run and queues the exact selected answer',async()=>{
  const call=vi.spyOn(api,'systemAction').mockImplementation(async action=>action==='questions'?{questions:[{id:'q',threadId:'thread',state:'pending',question:'Which language?',options:['English','Arabic']}]}:{runId:'resumed'});
  const user=userEvent.setup();render(<WorkQuestions agentId="bot" threadId="thread"/>);
  await user.click(await screen.findByRole('button',{name:'Arabic'}));
  expect(call).toHaveBeenCalledWith('question-answer',{agentId:'bot',id:'q',answer:'Arabic'});
  expect(screen.queryByRole('article',{name:'Saved task question'})).not.toBeInTheDocument();
});
it('publication requires preview and a separate explicit approval for that digest',async()=>{
  const call=vi.spyOn(api,'systemAction').mockImplementation(async action=>action==='repository-preview'?{repository:'owner/repo',baseCommit:'abc',digest:'review-hash',files:[{path:'src/a.ts',content:'reviewed'}]}:{url:'https://github.com/owner/repo/pull/1'});
  const user=userEvent.setup();render(<RepositoryPublication runId="run"/>);
  await user.click(screen.getByText('Create a GitHub pull request'));
  await user.type(screen.getByLabelText('Base branch'),'main');await user.type(screen.getByLabelText('Pull request title'),'Fix');
  await user.click(screen.getByRole('button',{name:'Review publication'}));
  expect(call).toHaveBeenCalledTimes(1);
  await user.click(await screen.findByRole('button',{name:'Approve and create draft pull request'}));
  expect(call).toHaveBeenCalledWith('repository-publish',{runId:'run',approvedDigest:'review-hash'});
  expect(await screen.findByRole('link',{name:'Open draft pull request'})).toHaveAttribute('href','https://github.com/owner/repo/pull/1');
});
