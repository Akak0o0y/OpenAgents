export interface ScopeId {role:string;name?:string}
export interface ElementIdentity {role:string;name:string;scope:ScopeId|null;scopeCount:number;countInScope:number;topFrame:boolean;anchor:boolean;editable:'contenteditable'|'input'|'textarea'|null}
export type RecordedStep=
  | {kind:'navigate';via:'navigate'|'anchor'|'flow';href:string;fromUrl:string;toUrl:string;link?:{container:string;siblings:string[]};pick?:{container:string;pattern:string;max:number};at:number}
  | {kind:'click'|'double_click'|'press'|'fill';target:ElementIdentity|null;key?:string;valueSha256?:string;account?:string|null;fromUrl:string;toUrl:string;actionId:string;by:'model'|'flow';at:number}
  | {kind:'other';action:string;secret?:boolean;at:number};
export type FlowTarget=Pick<ElementIdentity,'role'|'name'|'scope'>&{editable?:ElementIdentity['editable']};
export type Ready={target:FlowTarget}|{links:{container:string;pattern:string;min:number}}|{text:{minChars:number}};
export type FlowStepV1=
  | {kind:'visit';url:string;ready:Ready;context:boolean}
  | {kind:'pick';container:string;pattern:string;max:number;ready:Ready}
  | {kind:'click';target:FlowTarget}
  | {kind:'fill';target:FlowTarget;param:'text'}
  | {kind:'commit';target:FlowTarget;page:string;readBack:number};
export interface FlowV1 {v:1;origin:string;probe:string;op:'post'|'reply';account:string;steps:FlowStepV1[];output:{pick:boolean;maxWeighted:280}}
export type PlayStep=
  |{kind:'visit';url:string;ready:Ready;pick?:{container:string;pattern:string;max:number};extract?:{context?:boolean;candidates?:{container:string;pattern:string;max:number;exclude:string[]};account?:{role:string;name:string}}}
  |{kind:'click';target:FlowTarget}|{kind:'press';target:FlowTarget;key:'Escape'}|{kind:'fill';target:FlowTarget;value:string;method:'fill'|'insertText'}
  |{kind:'commit';target:FlowTarget;page:string;readBack:FlowTarget;expectText:string;inReplyTo?:string;account:string;probe:string};
export interface PlayResult {url:string;ms:number;context?:string;candidates?:Array<{id:number;href:string;text:string}>;account?:string|null;publish?:import('./browser-publish.js').PublishRecord}
export class FlowMiss extends Error {constructor(readonly reason:'operator'|'redirect'|'not-ready'|'not-unique'|'anchor'|'disabled'|'text-mismatch'|'listbox'|'wrong-page'|'target'|'duplicate'|'goto',readonly detail:string){super(detail);}}
export class CommitRejected extends Error {}
export class CommitNotSent extends Error {}
export class FlowAccountChanged extends Error {constructor(readonly signedIn:string|null){super('The signed-in account changed before submission.');}}
export function appendBoundedTrace(trace:RecordedStep[],step:RecordedStep):'recorded'|'trace-overflow' {
  if(trace.length>=100)return 'trace-overflow';trace.push(step);return 'recorded';
}
