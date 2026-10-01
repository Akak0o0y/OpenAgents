export interface CharacterRunContext {logicalCalls:number;preparations:number;deadlineAt:number;taskIdentity:unknown;currentCandidate:string|null;currentAdmission:string|null}
export const remainingCallMs=(now:number,preparationDeadline:number,runDeadline:number)=>Math.max(0,Math.min(90000,preparationDeadline-now,runDeadline-now));
/** Whether this run may still start a preparation; asking spends nothing. */
export function characterPreparationOpen(context:CharacterRunContext,now=Date.now()):boolean {
  return !(context.preparations>=2||context.logicalCalls>=8||now>=context.deadlineAt);
}
export function startCharacterPreparation(context:CharacterRunContext,now=Date.now()):number|null {
  if(!characterPreparationOpen(context,now))return null;
  context.preparations++;return Math.min(now+240000,context.deadlineAt);
}
export class CharacterTimeout extends Error {constructor(){super('Character preparation time limit reached.');}}
