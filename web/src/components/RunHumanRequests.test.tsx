import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {RunActivityCard} from './RunActivityCard.js';
import {RunHumanRequests} from './RunHumanRequests.js';
import {getJson,sendCommand,type ApprovalRow} from '../lib/transport.js';
import {useCortex} from '../store.js';
import {defaultProfile} from '../lib/botProfile.js';
import type {Teammate} from './workspaceTypes.js';

vi.mock('../lib/transport.js',async original=>({...await original<typeof import('../lib/transport.js')>(),getJson:vi.fn(),sendCommand:vi.fn()}));
vi.mock('./BotFace.js',()=>({BotFace:()=>null}));
const human:ApprovalRow={id:'help-1',agent_id:'alpha',task_run_id:'run-1',kind:'human-assist',status:'PENDING',waiting:true,created_at:1,payload_json:JSON.stringify({what:'Choose the destination',why:'Two sections have similar names.'})};
const agent={id:'alpha',name:'Milo',description:'',model:'test',status:'BUSY',budgetCapUsd:10,profile:defaultProfile({id:'alpha',name:'Milo',model_id:'test'}),flags:{pinned:false,unread:false,hidden:false,section:null},reactions:{},threadId:null,lastMessagePreview:null,lastMessageAt:null} as Teammate;
beforeEach(()=>{
  vi.resetAllMocks();
  useCortex.setState({liveRuns:{},watchRun:()=>()=>{}});
  vi.mocked(getJson).mockImplementation(async url=>url.startsWith('/api/approvals')?{approvals:[human]} as never:{legacy:true} as never);
  vi.mocked(sendCommand).mockResolvedValue({success:true} as never);
});
describe('human requests beside run activity',()=>{
  it('keeps the response outside a long scrolling timeline and finds it after reload',async()=>{
    useCortex.setState({liveRuns:{'run-1':{watchers:1,events:[],activity:{runId:'run-1',phase:'running',plan:[],steps:[
      ...Array.from({length:40},(_,i)=>({id:`step-${i}`,tool:'browser',label:'Using browser',status:'error' as const,card:'generic' as const,startedAt:i})),
      {id:'waiting',tool:'request_human',label:'Waiting for your response',status:'waiting',card:'generic',startedAt:41,approvalId:'help-1'},
    ]}}}});
    render(<RunActivityCard agent={agent} runId="run-1"/>);
    const input=await screen.findByRole('textbox',{name:'Your response'});
    expect(input.closest('.oh-activity-steps-container')).toBeNull();
    expect(screen.getByRole('region',{name:'Human assistance'}).compareDocumentPosition(screen.getByRole('region',{name:'Command activity'})) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getJson).toHaveBeenCalledWith('/api/approvals?run=run-1',expect.any(AbortSignal));
  });
  it('sends the exact response and preserves it if the daemon rejects it',async()=>{
    const user=userEvent.setup();vi.mocked(sendCommand).mockResolvedValueOnce({success:false,error:'Connection interrupted'} as never);
    render(<RunHumanRequests runId="run-1" agentId="alpha" waiting/>);
    await user.type(await screen.findByRole('textbox',{name:'Your response'}),'Use preview.');
    await user.click(screen.getByRole('button',{name:'Continue with my response'}));
    expect(sendCommand).toHaveBeenCalledWith('approve','help-1',{reason:'Use preview.'});
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted');
    expect(screen.getByRole('textbox',{name:'Your response'})).toHaveValue('Use preview.');
    vi.mocked(getJson).mockResolvedValue({approvals:[]} as never);
    await user.click(screen.getByRole('button',{name:'Continue with my response'}));
    await waitFor(()=>expect(screen.queryByRole('textbox',{name:'Your response'})).not.toBeInTheDocument());
  });
  it('does not show or answer a request from another run or bot',async()=>{
    vi.mocked(getJson).mockResolvedValue({approvals:[{...human,agent_id:'other'},{...human,task_run_id:'other'}]} as never);
    render(<RunHumanRequests runId="run-1" agentId="alpha" waiting={false}/>);
    await waitFor(()=>expect(getJson).toHaveBeenCalled());
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();expect(sendCommand).not.toHaveBeenCalled();
  });
});
