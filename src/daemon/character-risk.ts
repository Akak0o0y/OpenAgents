import {normalizeClaimKey} from './character-claims.js';
export const CHARACTER_RISK_VERSION='character-risk/1';
export interface RiskInput {text:string;op:'post'|'reply';language:string;configuredLanguages:string[];surface:string;approvedEntities:string[];commitmentTopics:string[];disputedKeys:string[]}
// Deliberately narrow vocabulary. Unknown grammar or names always require full review.
const EN=new Set('a an the and or but to of for in on with is are be can may we you i it this that simple small clear useful idea ideas tools tool work practice learning learn think question questions better good today thanks thank helpful patience progress matters welcome keep start stay take time step steps one at helps'.split(' '));
const AR=new Set('التعلم تعلم فكرة أفكار بسيطة بسيطة الوضوح واضح العمل خطوة خطوات صغيرة مفيدة مفيد شكرا لك لكم نحن يمكن مع في من على إلى و أو الصبر الوقت يساعد مرحبا'.split(' '));
export function classifyReviewRisk(input:RiskInput):{kind:'full'|'eligible';reasons:string[]} {
  const reasons:string[]=[],text=normalizeClaimKey(input.text);const words:string[]=text.match(/\p{L}+/gu)??[];
  if(input.op==='reply')reasons.push('reply');
  if(input.surface!=='public-post')reasons.push('unfamiliar-surface');
  if(!['en','ar'].includes(input.language)||!input.configuredLanguages.includes(input.language))reasons.push('unfamiliar-language');
  if(/\p{N}/u.test(text))reasons.push('number-or-date');
  if(/\b(?:i|we)\s+(?:was|were|had|did|visited|attended|met|worked|built|went)\b|(?:كنت|كنا|حضرت|زرنا|زرت|عملت|ذهبت|التقيت)/u.test(text))reasons.push('past-claim');
  if(input.commitmentTopics.some(t=>text.includes(normalizeClaimKey(t))))reasons.push('commitment-topic');
  if(input.disputedKeys.some(k=>normalizeClaimKey(k).split(/\s+/).some(w=>w.length>2&&words.includes(w))))reasons.push('disputed-claim');
  const vocabulary=input.language==='ar'?AR:EN;
  if(!words.length||words.some(w=>!vocabulary.has(w))||/[^\p{L}\s.,!?،؛؟'’—-]/u.test(text))reasons.push('unclassified-text');
  if(input.language==='ar'&&/[a-z]/i.test(text)||input.language==='en'&&/\p{Script=Arabic}/u.test(text))reasons.push('mixed-language');
  return {kind:reasons.length?'full':'eligible',reasons};
}
