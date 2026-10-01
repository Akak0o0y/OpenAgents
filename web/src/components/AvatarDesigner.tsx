import { useState, type CSSProperties } from 'react';
import { ArrowUpRight, Check, Pause, Play, RotateCcw, Sparkles } from 'lucide-react';
import { BotFace, usePrefersReducedMotion } from './BotFace.js';
import { ALL_SHAPES, SHAPE_LABELS } from '../lib/aora-bot/shapes.js';
import { EMOTION_SEED } from '../lib/aora-bot/index.js';
import type { BotProfile } from '../lib/botProfile.js';
import './AvatarDesigner.css';

const EDITIONS = [
  { name: 'Orbit', note: 'A little cosmic', shape: 'pebble', color: '#748CD6', eyeColor: '#FFFFFF', emotion: '02' },
  { name: 'Sprout', note: 'Soft by nature', shape: 'bean', color: '#82A888', eyeColor: '#20342A', emotion: '03' },
  { name: 'Ember', note: 'A warm presence', shape: 'blob', color: '#D78D60', eyeColor: '#FFFFFF', emotion: '10' },
  { name: 'Ink', note: 'Quietly different', shape: 'squircle', color: '#595666', eyeColor: '#EAE4CF', emotion: '02' },
] as const;
const SWATCHES = ['#D78D60', '#D4B778', '#82A888', '#67A7AE', '#748CD6', '#A092C6', '#D995AC', '#595666'];
const EXPRESSIONS = (EMOTION_SEED as Array<{id:string; en?:{name?:string}; name?:string}>).map(e=>({id:String(e.id),name:e.en?.name || e.name || String(e.id)}));
const AUDITIONS = ['02','03','10','19','30','32'].map(id=>EXPRESSIONS.find(e=>e.id===id)).filter((e):e is typeof EXPRESSIONS[number]=>Boolean(e));

/** One editor for the sidebar and the full studio. Only explicit edits persist. */
export function AvatarDesigner({name,profile,onChange,onOpenStudio,wide=false}:{
  name:string; profile:BotProfile; onChange:(patch:Partial<BotProfile>)=>void; onOpenStudio?:()=>void; wide?:boolean;
}) {
  const [page,setPage]=useState<'Look'|'Expressions'|'Details'>('Look');
  const [audition,setAudition]=useState<string|null>(null);
  const [tour,setTour]=useState(false);
  const reduced=usePrefersReducedMotion();
  const expression=EXPRESSIONS.find(e=>e.id===(audition??profile.emotion));
  const edit=(patch:Partial<BotProfile>)=>{setAudition(null);setTour(false);onChange(patch);};
  const sculpture=(patch:Partial<BotProfile>)=>edit({...patch,avatarImage:null});
  return <section className={`avatar-atelier${wide?' avatar-atelier-wide':''}`} aria-label="Avatar designer" style={{'--avatar-pigment':profile.color} as CSSProperties}>
    <div className="avatar-stage-wrap">
      <div className="avatar-stage">
        <div className="avatar-stage-top"><span>OPENAGENTS / ATELIER</span><span className="avatar-live"><i/>Live preview</span></div>
        <div className="avatar-stage-orbit" aria-hidden="true"/>
        <div className="avatar-specimen"><BotFace size={164} {...profile} image={profile.avatarImage} emotion={audition??profile.emotion} tourEmotionIds={tour&&!reduced?AUDITIONS.map(e=>e.id):undefined} interactive={!tour} /><span className="avatar-pedestal" aria-hidden="true"/></div>
        <div className="avatar-stage-caption"><h3>{name || 'Your bot'}</h3><span>{profile.avatarImage?'Your uploaded portrait':tour?'Expression tour':`${SHAPE_LABELS[profile.shape]} · ${expression?.name??'Your expression'}`}</span></div>
        <div className="avatar-stage-bottom"><span>{audition||tour?'Preview only':profile.avatarImage?'CUSTOM PORTRAIT':'MADE TO BE YOURS'}</span>{!profile.avatarImage&&<button type="button" disabled={reduced} aria-label={tour?'Stop emotion tour':'Preview emotion tour'} onClick={()=>{setAudition(null);setTour(!tour);}}>{tour?<Pause size={12}/>:<Play size={12}/>}<span>{tour?'Pause':'Meet your bot'}</span></button>}</div>
      </div>
      {reduced&&<p className="avatar-small-note">Animation previews respect your reduced-motion setting.</p>}
      {profile.avatarImage&&<p className="avatar-small-note">Your uploaded portrait is active. Choose a silhouette or an edition below to switch to an animated avatar.</p>}
      {onOpenStudio&&<button className="avatar-expand" type="button" onClick={onOpenStudio}>Open the full atelier <ArrowUpRight size={15}/></button>}
    </div>
    <div className="avatar-workbench">
      <nav className="avatar-pages" aria-label="Avatar design sections">{(['Look','Expressions','Details'] as const).map((item,i)=><button key={item} type="button" aria-label={item} aria-current={page===item?'page':undefined} onClick={()=>setPage(item)}><small>0{i+1}</small>{item}</button>)}</nav>
      {page==='Look'&&<div className="avatar-controls">
        <div className="avatar-section-heading"><span>THE STARTING POINT</span><h4>Find your kind of different.</h4><p>Start with an edition. Make every detail yours.</p></div>
        <div className="avatar-editions">{EDITIONS.map(edition=><button type="button" key={edition.name} onClick={()=>sculpture({shape:edition.shape,color:edition.color,eyeColor:edition.eyeColor,emotion:edition.emotion,sketch:false,eyeScale:1})} aria-label={`Apply ${edition.name} edition`} style={{'--edition-color':edition.color} as CSSProperties}><BotFace size={48} {...edition} idle={false}/><strong>{edition.name}</strong><small>{edition.note}</small></button>)}</div>
        <div className="avatar-section-heading"><span>01 / SILHOUETTE</span><h4>A shape to call your own.</h4></div>
        <div className="avatar-shapes" role="group" aria-label="Avatar silhouette">{ALL_SHAPES.map(shape=><button type="button" key={shape} aria-pressed={!profile.avatarImage&&profile.shape===shape} onClick={()=>sculpture({shape})}><BotFace size={38} shape={shape} color={profile.color} eyeColor={profile.eyeColor} emotion="02" idle={false}/><span>{SHAPE_LABELS[shape]}</span>{!profile.avatarImage&&profile.shape===shape&&<Check className="avatar-choice-check" size={10}/>}</button>)}</div>
        <div className="avatar-section-heading"><span>02 / PALETTE</span><h4>A signature color.</h4></div>
        <div className="avatar-swatches" role="group" aria-label="Body color palette">{SWATCHES.map(color=><button key={color} type="button" aria-label={`Body color ${color}`} aria-pressed={profile.color.toLowerCase()===color.toLowerCase()} style={{background:color}} onClick={()=>sculpture({color})}>{profile.color.toLowerCase()===color.toLowerCase()&&<Check size={15}/>}</button>)}</div>
        <div className="avatar-color-pair"><label>Body color <span><input type="color" aria-label="Body color" value={profile.color} onChange={e=>sculpture({color:e.target.value})}/><code>{profile.color}</code></span></label><label>Eye colour <span><input type="color" aria-label="Eye colour" value={profile.eyeColor} onChange={e=>edit({eyeColor:e.target.value})}/><code>{profile.eyeColor}</code></span></label></div>
      </div>}
      {page==='Expressions'&&<div className="avatar-controls">
        <div className="avatar-section-heading"><span>A LITTLE LIFE</span><h4>More than a pretty face.</h4><p>Try an expression on the stage. Nothing changes until you make it the default.</p></div>
        <div className="avatar-expression-grid">{AUDITIONS.map(e=><button key={e.id} type="button" aria-label={`Preview ${e.name}`} aria-pressed={audition===e.id} disabled={Boolean(profile.avatarImage)} onClick={()=>{setTour(false);setAudition(e.id);}}><BotFace size={46} shape={profile.shape} color={profile.color} eyeColor={profile.eyeColor} eyeScale={profile.eyeScale} sketch={profile.sketch} emotion={e.id} idle={false}/><span>{e.name}</span></button>)}</div>
        {audition&&<div className="avatar-audition"><span>Trying {expression?.name}</span><button type="button" onClick={()=>edit({emotion:audition})}>Make default <Check size={13}/></button><button type="button" aria-label="End expression preview" onClick={()=>setAudition(null)}><RotateCcw size={13}/></button></div>}
        <label className="avatar-select-label">Default emotion<select value={profile.emotion??''} onChange={e=>edit({emotion:e.target.value})}>{!EXPRESSIONS.some(e=>e.id===profile.emotion)&&<option value={profile.emotion??''}>{profile.emotion?'Custom expression':'Choose an expression'}</option>}{EXPRESSIONS.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <p className="avatar-small-note">Visual expressions change the face, not the bot’s personality or instructions.</p>
      </div>}
      {page==='Details'&&<div className="avatar-controls">
        <div className="avatar-section-heading"><span>THE FINISHING TOUCHES</span><h4>Small details. Big character.</h4></div>
        <label className="avatar-scale">Eye scale <output>{profile.eyeScale.toFixed(2)}×</output><input type="range" min="0.65" max="1.6" step="0.05" value={profile.eyeScale} onChange={e=>edit({eyeScale:Number(e.target.value)})}/><span><small>Understated</small><small>Wide-eyed</small></span></label>
        <div className="avatar-rendering" role="group" aria-label="Rendering style">{[{name:'Soft',sketch:false},{name:'Sketch',sketch:true}].map(style=><button type="button" key={style.name} aria-pressed={profile.sketch===style.sketch} onClick={()=>edit({sketch:style.sketch})}><BotFace size={60} shape={profile.shape} color={profile.color} eyeColor={profile.eyeColor} sketch={style.sketch} emotion="02" idle={false}/><strong>{style.name}</strong><small>{style.sketch?'A hand-drawn edge':'Smooth & sculptural'}</small></button>)}</div>
        <label className="avatar-motion"><span><strong>Idle animation</strong><small>A little movement between moments.</small></span><input type="checkbox" checked={profile.idle} onChange={e=>edit({idle:e.target.checked})}/></label>
        <div className="avatar-design-note"><Sparkles size={16}/><p>Your face, everywhere.<br/><span>This identity follows your bot through chat, the workspace and Cortex.</span></p></div>
      </div>}
    </div>
  </section>;
}
