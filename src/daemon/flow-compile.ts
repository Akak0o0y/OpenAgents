import type {PublishRecord} from './browser-publish.js';
import type {RecordedStep,FlowV1,FlowTarget,FlowStepV1,ElementIdentity} from './flow-types.js';
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const page=(s:string)=>{const u=new URL(s);return u.origin+u.pathname;};
const target=(t:ElementIdentity):FlowTarget=>({role:t.role,name:t.name,scope:t.scope,...(t.editable?{editable:t.editable}:{})});
const same=(a:ElementIdentity|null,b:ElementIdentity|null)=>a&&b&&JSON.stringify(target(a))===JSON.stringify(target(b));
type Event={event_type:string;payload_json:string|null;timestamp:number};
export function compileFlow(input:{trace:readonly RecordedStep[];publishes:readonly PublishRecord[];events:readonly Event[]}):
  {ok:true;flow:FlowV1;commitActionId:string;picked?:string;confirmedBy:'response'|'page'}|{ok:false;reason:string} {
  const no=(reason:string)=>({ok:false as const,reason});
  const {trace,publishes,events}=input;
  if(trace.length>100||trace.some(s=>s.kind==='other'&&s.action==='trace-overflow'))return no('trace-overflow');
  const confirmed=publishes.filter(p=>p.state==='confirmed'&&!p.unprobed&&p.by==='model'&&p.actionId);
  if(!confirmed.length)return no(publishes.some(p=>p.unprobed)?'unprobed-only':'no-confirmed-publish');
  if(confirmed.length!==1||publishes.some(p=>p.publishId!==confirmed[0].publishId&&['confirmed','unobserved','pending'].includes(p.state)))return no('multiple-publishes');
  const publish=confirmed[0],ci=trace.findIndex(s=>'actionId' in s&&s.actionId===publish.actionId),commit=trace[ci];
  if(!commit||commit.kind==='navigate'||commit.kind==='other'||commit.by!=='model')return no('no-confirmed-publish');
  if(commit.kind!=='click')return no(commit.kind==='press'?'commit-by-key':'commit-by-double-click');
  if(!commit.target||!commit.target.topFrame)return no('child-frame');
  if(commit.target.anchor)return no('commit-anchor');
  if(commit.target.countInScope!==1||commit.target.scopeCount!==1)return no('not-unique');
  if(!commit.account)return no('account-unreadable');
  try{
    const commitPage=page(commit.fromUrl),origin=new URL(commitPage).origin;
    if(origin!==publish.origin||!['post','reply'].includes(publish.op))return no('discontinuity');
    let ai=-1;
    for(let i=0;i<ci;i++){const s=trace[i];if(s.kind==='navigate'&&page(s.toUrl)===commitPage)ai=i;}
    if(ai<0)return no('discontinuity');
    const arrival=trace[ai] as Extract<RecordedStep,{kind:'navigate'}>;
    let fi=-1;
    for(let i=ai+1;i<ci;i++){const s=trace[i];if(s.kind==='fill'&&page(s.fromUrl)===commitPage)fi=i;}
    if(fi<0)return no('text-mismatch');
    const fill=trace[fi] as Extract<RecordedStep,{actionId:string}>;
    if(!fill.target||fill.valueSha256!==publish.textSha256)return no('text-mismatch');
    if(!fill.target.topFrame)return no('child-frame');
    if(fill.target.anchor||!fill.target.editable)return no('text-mismatch');
    if(fill.target.countInScope!==1||fill.target.scopeCount!==1)return no('not-unique');
    const steps:FlowStepV1[]=[];
    let pick:Extract<FlowStepV1,{kind:'pick'}>|undefined,first=ai;
    if(publish.op==='reply') {
      if(arrival.pick)pick={kind:'pick',...arrival.pick,ready:{target:target(fill.target)}};
      else if(arrival.link){
        const siblings=arrival.link.siblings.map(u=>new URL(u,origin)).filter(u=>u.origin===origin);
        if(new Set(siblings.map(u=>u.pathname)).size<3)return no('pick-too-few-siblings');
        const parts=siblings.map(u=>u.pathname.split('/')),picked=new URL(arrival.toUrl).pathname.split('/');
        if(parts.some(p=>p.length!==picked.length))return no('reply-without-pick');
        const pattern='^'+picked.map((p,i)=>new Set(parts.map(v=>v[i])).size===1?escape(p):'[^/]+').join('/')+'$';
        pick={kind:'pick',container:arrival.link.container,pattern,max:12,ready:{target:target(fill.target)}};
      }else return no('reply-without-pick');
      let source=-1;for(let i=0;i<ai;i++){const s=trace[i];if(s.kind==='navigate'&&page(s.toUrl)===page(arrival.fromUrl)&&new URL(s.toUrl).origin===origin)source=i;}
      if(source<0)return no('discontinuity');first=source;
      steps.push({kind:'visit',url:(trace[source] as typeof arrival).toUrl,context:true,ready:{links:{container:pick.container,pattern:pick.pattern,min:2}}},pick);
    }else steps.push({kind:'visit',url:arrival.toUrl,context:false,ready:{target:target(fill.target)}});
    const contexts:typeof arrival[]=[];
    for(let i=0;i<first;i++){const s=trace[i];if(s.kind==='navigate'&&new URL(s.toUrl).origin===origin)contexts.push(s);}
    const keep=contexts.slice(-(publish.op==='reply'?1:2));
    if(keep.length){first=trace.indexOf(keep[0]);steps.unshift(...keep.map(s=>({kind:'visit' as const,url:s.toUrl,context:true,ready:{text:{minChars:200}}})));}
    for(const e of events){let p:any;try{p=JSON.parse(e.payload_json??'{}');}catch{continue;}
      if(e.timestamp<=commit.at&&(['HUMAN_ASSIST_REQUESTED','BROWSER_OPERATOR_INPUT'].includes(e.event_type)||(e.event_type==='BROWSER_CONTROL'&&p.operator===true)))return no('human-assist');
      if(e.timestamp>=trace[first].at&&e.timestamp<=commit.at&&e.event_type==='WORK_ACTION'&&p.tool==='computer')return no('computer-input');
    }
    for(const s of trace.slice(first,ci+1)){if(s.kind==='other')return no(s.secret?'secret-fill':'other-step');if('target' in s&&s.target&&!s.target.topFrame)return no('child-frame');}
    let previous=commitPage,readBack=-1;
    for(let i=ai+1;i<ci;i++){
      const s=trace[i];if(s.kind==='navigate')return no('discontinuity');if(s.kind==='other')return no('other-step');
      if(!['click','fill'].includes(s.kind))continue;
      if(page(s.fromUrl)!==previous||page(s.toUrl)!==commitPage)return no('discontinuity');previous=page(s.toUrl);
      if(s.kind==='fill'&&i!==fi){if(!same(s.target,fill.target))return no('other-step');continue;}
      if(s.kind==='click'&&same(s.target,fill.target))continue;
      if(!s.target||s.target.countInScope!==1||s.target.scopeCount!==1||s.target.anchor)return no('not-unique');
      if(s.kind==='fill'){readBack=steps.length;steps.push({kind:'fill',param:'text',target:target(s.target)});}else steps.push({kind:'click',target:target(s.target)});
    }
    if(readBack<0)return no('text-mismatch');
    if(publish.inReplyTo&&steps.some(s=>s.kind==='visit'&&s.url.includes(publish.inReplyTo!)))return no('reply-target-baked-in');
    const pattern=pick?.pattern??'^'+escape(new URL(commitPage).pathname)+'$';
    if(publish.inReplyTo&&pattern.includes(publish.inReplyTo))return no('reply-target-baked-in');
    steps.push({kind:'commit',target:target(commit.target),page:pattern,readBack});
    return {ok:true,flow:{v:1,origin,probe:publish.probe,op:publish.op as 'post'|'reply',account:commit.account,steps,output:{pick:!!pick,maxWeighted:280}},commitActionId:commit.actionId,
      ...(pick?{picked:arrival.toUrl}:{}),confirmedBy:publish.confirmedBy??'page'};
  }catch{return no('discontinuity');}
}
export const describeFlow=(flow:FlowV1)=>flow.steps.map(s=>s.kind==='visit'?`Open ${s.url}`:s.kind==='pick'?'Choose a post':s.kind==='fill'?`Type into “${s.target.name}”`:`Press “${s.target.name}”`);
