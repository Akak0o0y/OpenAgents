import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {desktopObserver} from '../docker/bot-desktop/observe.mjs';

test('desktop observer shares bounded full-screen cursor capture and exposes no input method',async()=>{
  let args,calls=0,killed=0;
  const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{killed++;};
  const observe=desktopObserver((command,argv)=>{assert.equal(command,'ffmpeg');args=argv;calls++;return child;},async()=>({width:1920,height:1080}));
  const response=()=>{const r=new EventEmitter();r.frames=[];r.writableLength=0;r.writeHead=status=>{r.status=status;};r.write=s=>r.frames.push(s);r.end=()=>r.emit('close');r.destroy=r.end;return r;};
  const rejected=response();await observe({method:'POST'},rejected);assert.equal(rejected.status,405);assert.equal(calls,0);
  const first=response(),second=response();await observe({method:'GET'},first);await observe({method:'GET'},second);
  assert.equal(calls,1);assert.equal(args[args.indexOf('-draw_mouse')+1],'1');assert.equal(args[args.indexOf('-video_size')+1],'1920x1080');
  child.stdout.write(Buffer.from([255,216,1,2,255,217]));assert.match(first.frames.at(-1),/data:image\/jpeg/);assert.equal(first.frames.at(-1),second.frames.at(-1));
  first.end();assert.equal(killed,0);observe.reset();assert.equal(killed,1);
});
