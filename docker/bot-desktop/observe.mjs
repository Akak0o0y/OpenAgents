import {spawn} from 'node:child_process';
import {displayGet} from './display.mjs';

/** One output-only capture process per desktop, shared by viewers; no input protocol. */
export function desktopObserver(spawnProcess=spawn,geometry=displayGet) {
  const clients=new Set(); let process=null, buffer=Buffer.alloc(0),starting=false,generation=0;
  const stop=()=>{generation++;starting=false;const prior=process;process=null;prior?.kill('SIGTERM');buffer=Buffer.alloc(0);};
  const fail=()=>{for(const client of clients)client.end();clients.clear();stop();};
  const observe=async (req,res)=>{
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(clients.size>=8){res.writeHead(429);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.write(': observing\n\n');clients.add(res);
    res.on('close',()=>{clients.delete(res);if(!clients.size)stop();});
    if(process||starting)return;
    starting=true;const epoch=generation;
    let size;try{size=await geometry();}catch{if(epoch===generation)fail();return;}
    if(epoch!==generation||!clients.size)return;
    starting=false;
    if(!Number.isInteger(size.width)||!Number.isInteger(size.height)||size.width<320||size.height<320||size.width>7680||size.height>7680){fail();return;}
    // draw_mouse captures the real X pointer. DOM automation does not invent pointer travel.
    let child;try{child=spawnProcess('ffmpeg',['-nostdin','-loglevel','error','-f','x11grab','-draw_mouse','1','-framerate','5','-video_size',`${size.width}x${size.height}`,'-i',':1','-vf','scale=1280:-2','-q:v','5','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{stdio:['ignore','pipe','ignore']});}catch{fail();return;}
    process=child;
    child.stdout.on('data',chunk=>{
      if(process!==child)return;
      buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8*1024*1024){fail();return;}
      let end;
      while((end=buffer.indexOf(Buffer.from([255,217])))>=0){
        const frame=buffer.subarray(0,end+2);buffer=buffer.subarray(end+2);
        if(frame[0]!==255||frame[1]!==216){fail();return;}
        const data='data: '+JSON.stringify({at:Date.now(),image:'data:image/jpeg;base64,'+frame.toString('base64')})+'\n\n';
        for(const client of clients){if(client.writableLength>2*1024*1024){client.destroy();continue;}client.write(data);}
      }
    });
    child.on('error',()=>{if(process===child)fail();});
    child.on('exit',()=>{if(process===child)fail();});
  };
  observe.reset=fail;return observe;
}
