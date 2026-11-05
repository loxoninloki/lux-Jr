import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { LIVE_MODEL, liveSetup, validateLiveAudio, issueLiveTicket, openLiveSocket } from './live-worker.mjs';
import { pcmToFloat, audioBase64 } from './live-audio.ts';
function ledger(budget=1000){
 const values=new Map();const tx={async get(k){return structuredClone(values.get(k))},async put(k,v){if(typeof k==='object')for(const [name,value]of Object.entries(k))values.set(name,structuredClone(value));else values.set(k,structuredClone(v));},async delete(k){values.delete(k)}};
 return {values,ctx:{storage:{...tx,transaction:fn=>fn(tx)}},env:{MONTHLY_BUDGET_YEN:String(budget)},async usage(){return values.get('usage')||{month:'test-month',requests:0,reservedYen:0,budgetYen:budget}}};
}
test('live model and audio-only setup are fixed; client controls cannot set the model',()=>{
 const setup=liveSetup('test persona').setup;assert.equal(setup.model,`models/${LIVE_MODEL}`);assert.deepEqual(setup.generationConfig.responseModalities,['AUDIO']);assert.equal(setup.realtimeInputConfig.activityHandling,'START_OF_ACTIVITY_INTERRUPTS');
 assert.doesNotThrow(()=>validateLiveAudio(JSON.stringify({realtimeInput:{audio:{data:'AAA=',mimeType:'audio/pcm;rate=16000'}}})));
 for(const data of [{setup:{model:'other'}},{realtimeInput:{text:'inject'}},{realtimeInput:{audio:{data:'AA==',mimeType:'audio/pcm;rate=16000'}}}])assert.throws(()=>validateLiveAudio(JSON.stringify(data)));
});
test('trial tickets reserve app budget, prevent simultaneous trials, and limit daily starts',async()=>{
 const l=ledger();const first=await issueLiveTicket(l,'persona');assert.equal(first.seconds,120);assert.equal(first.remainingToday,2);assert.equal((await l.usage()).reservedYen,100);
 assert.equal((await issueLiveTicket(l,'persona')).status,429);
 for(let i=0;i<2;i++){l.values.get('live-trial').activeUntil=0;assert.ok((await issueLiveTicket(l,'persona')).ticket);}
 l.values.get('live-trial').activeUntil=0;assert.equal((await issueLiveTicket(l,'persona')).status,429);
 assert.equal((await l.usage()).reservedYen,300);
});
test('monthly app cap rejects live before issuing a ticket',async()=>{
 const l=ledger(50);assert.equal((await issueLiveTicket(l,'persona')).status,429);assert.equal(l.values.has('live-ticket'),false);
});
test('invalid live ticket is rejected before any provider connection',async()=>{
 const l=ledger();assert.equal((await openLiveSocket(l,new Request('https://unit.test/live?ticket=bad',{headers:{Upgrade:'websocket'}}))).status,401);
});
test('PCM encode/decode preserves signed 16-bit little-endian audio',()=>{
 const bytes=new Uint8Array([0,128,0,0,255,127]);const decoded=pcmToFloat(audioBase64(bytes.buffer));assert.equal(decoded[0],-1);assert.equal(decoded[1],0);assert.ok(decoded[2]>.999);
 assert.throws(()=>pcmToFloat('AA=='));
});
test('audio worklet streams 16 kHz mono from both iPhone sample rates and never echoes microphone',()=>{
 for(const rate of [48000,44100]){
  let Processor;const frames=[];const sandbox={sampleRate:rate,Float32Array,ArrayBuffer,DataView,Math,AudioWorkletProcessor:class{constructor(){this.port={postMessage:v=>frames.push(v)}}},registerProcessor:(_,p)=>{Processor=p}};
  vm.runInNewContext(readFileSync(new URL('./live-processor.js',import.meta.url),'utf8'),sandbox);const processor=new Processor();
  for(let n=0;n<rate;n+=100){const input=new Float32Array(Math.min(100,rate-n)).fill(-1),output=new Float32Array(input.length).fill(1);processor.process([[input]],[[output]]);assert.ok(output.every(s=>s===0));}
  assert.equal(frames.length,10);assert.equal(frames.reduce((sum,f)=>sum+f.pcm.byteLength,0),32000);assert.equal(new DataView(frames[0].pcm).getInt16(0,true),-32768);
 }
});

test('server consumes tickets once and force-closes both sockets after 120 seconds',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 class Socket extends EventTarget {sent=[];closed=false;accept(){}send(value){this.sent.push(value)}close(){this.closed=true;this.dispatchEvent(new Event('close'))}}
 const upstream=new Socket();let pair;const originalResponse=globalThis.Response,originalPair=globalThis.WebSocketPair;
 globalThis.Response=class{constructor(body,options){this.status=options.status;this.webSocket=options.webSocket}};
 globalThis.WebSocketPair=class{constructor(){this[0]=new Socket();this[1]=new Socket();pair=this}};
 t.mock.method(globalThis,'fetch',async()=>({webSocket:upstream}));t.after(()=>{globalThis.Response=originalResponse;globalThis.WebSocketPair=originalPair});
 const l=ledger();l.env.GEMINI_API_KEY='unit-test-only';const ticket=await issueLiveTicket(l,'persona');
 const request=new Request(`https://unit.test/live?ticket=${ticket.ticket}`,{headers:{Upgrade:'websocket'}});
 const response=await openLiveSocket(l,request);assert.equal(response.status,101);assert.equal(l.values.has('live-ticket'),false);
 upstream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({setupComplete:{}})}));
 t.mock.timers.tick(120000);assert.equal(pair[1].closed,true);assert.equal(upstream.closed,true);
 assert.equal((await openLiveSocket(l,request)).status,401);
});

test('native Live keeps the microphone open through playback and clears queued audio on interruption',async(t)=>{
 const {LiveConversation}=await import('./live-audio.ts');const names=['window','AudioContext','AudioWorkletNode','WebSocket','navigator'];const originals=new Map(names.map(n=>[n,Object.getOwnPropertyDescriptor(globalThis,n)]));
 const tracks=[{stopped:false,stop(){this.stopped=true}}],sources=[];let socket,capture;
 class Context {state='running';currentTime=0;destination={};audioWorklet={addModule:async()=>{}};async resume(){}async close(){this.state='closed'}createMediaStreamSource(){return {connect(){},disconnect(){}}}createBuffer(_,size,rate){return {duration:size/rate,getChannelData:()=>new Float32Array(size)}}createBufferSource(){const source={connect(){},disconnect(){},start(){},stop(){this.stopped=true}};sources.push(source);return source}}
 class WS {static OPEN=1;readyState=1;bufferedAmount=0;sent=[];constructor(){socket=this}send(v){this.sent.push(v)}close(){this.closed=true}}
 class Capture {constructor(){capture=this;this.port={}}connect(){queueMicrotask(()=>this.port.onmessage?.({data:{pcm:new ArrayBuffer(3200),level:.2}}))}disconnect(){}}
 for(const [name,value]of Object.entries({window:{AudioContext:Context},AudioContext:Context,AudioWorkletNode:Capture,WebSocket:WS,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>tracks})}}}))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
 t.after(()=>{for(const [n,d]of originals)d?Object.defineProperty(globalThis,n,d):delete globalThis[n]});
 const live=new LiveConversation({phase(){},error(){},diagnostic(){},transcript(){},preview(){},ticket:async()=>({ticket:'unit-test',seconds:120,endpoint:'https://unit.test'})});
 await live.start();socket.onmessage({data:JSON.stringify({setupComplete:{}})});
 socket.onmessage({data:JSON.stringify({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AAAAAA=='}}]}}})});
 capture.port.onmessage({data:{pcm:new ArrayBuffer(3200)}});assert.equal(socket.sent.length,1);assert.equal(tracks[0].stopped,false);
 socket.onmessage({data:JSON.stringify({serverContent:{interrupted:true}})});assert.equal(sources[0].stopped,true);assert.equal(tracks[0].stopped,false);
 live.stop();assert.equal(tracks[0].stopped,true);assert.equal(socket.closed,true);
});

function fakeBrowser(t,{autoFrame=true}={}){
 const names=['window','AudioContext','AudioWorkletNode','WebSocket','navigator'];
 const original=new Map(names.map(n=>[n,Object.getOwnPropertyDescriptor(globalThis,n)]));
 let capture,socket,context;const tracks=[{stopped:false,stop(){this.stopped=true}}];
 class Context {state='running';currentTime=0;destination={};audioWorklet={addModule:async()=>{}};constructor(){context=this}async resume(){this.state='running';this.onstatechange?.()}async close(){this.state='closed'}createMediaStreamSource(){return{connect(){},disconnect(){}}}createBuffer(_,n,rate){return{duration:n/rate,getChannelData:()=>new Float32Array(n)}}createBufferSource(){return{connect(){},disconnect(){},start(){},stop(){}}}}
 class WS {static OPEN=1;readyState=1;bufferedAmount=0;sent=[];constructor(){socket=this}send(v){this.sent.push(v)}close(){this.closed=true}}
 class Capture {constructor(){capture=this;this.port={}}connect(){if(autoFrame)queueMicrotask(()=>this.port.onmessage?.({data:{pcm:new ArrayBuffer(3200),level:.1}}))}disconnect(){}}
 for(const [n,value]of Object.entries({window:{AudioContext:Context},AudioContext:Context,AudioWorkletNode:Capture,WebSocket:WS,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>tracks})}}}))Object.defineProperty(globalThis,n,{configurable:true,writable:true,value});
 t.after(()=>{for(const[n,d]of original)d?Object.defineProperty(globalThis,n,d):delete globalThis[n]});
 return{get capture(){return capture},get context(){return context},get socket(){return socket},tracks};
}
test('Safari audio interruption offers gesture resume and preserves the live connection',async(t)=>{
 const {LiveConversation}=await import('./live-audio.ts');const h=fakeBrowser(t);let health;
 const live=new LiveConversation({phase(){},error(){},diagnostic(){},transcript(){},preview(){},health:v=>health=v,ticket:async()=>({ticket:'unit',seconds:120,endpoint:'https://unit.test'})});t.after(()=>live.stop());
 await live.start();h.socket.onmessage({data:JSON.stringify({setupComplete:{}})});
 h.context.state='interrupted';h.context.onstatechange();assert.equal(health.needsResume,true);
 h.capture.port.onmessage({data:{pcm:new ArrayBuffer(3200),level:.3}});assert.equal(h.socket.sent.length,0);
 await live.resumeAudio();assert.equal(health.needsResume,false);
 h.capture.port.onmessage({data:{pcm:new ArrayBuffer(3200),level:.3}});assert.equal(h.socket.sent.length,1);assert.equal(h.tracks[0].stopped,false);
 live.stop();assert.equal(h.tracks[0].stopped,true);assert.equal(h.socket.closed,true);
});
test('missing microphone frames never consume a Live trial; stopping preparation releases tracks',async(t)=>{
 const {LiveConversation}=await import('./live-audio.ts');const h=fakeBrowser(t,{autoFrame:false});let tickets=0;
 const live=new LiveConversation({phase(){},error(){},diagnostic(){},transcript(){},preview(){},ticket:async()=>{tickets++;return{ticket:'unit',seconds:120,endpoint:'https://unit.test'}}});t.after(()=>live.stop());
 const starting=live.start();await new Promise(resolve=>setImmediate(resolve));assert.ok(h.capture);assert.equal(tickets,0);
 const late=h.capture.port.onmessage;live.stop();late({data:{pcm:new ArrayBuffer(3200)}});await starting;
 assert.equal(tickets,0);assert.equal(h.tracks[0].stopped,true);
});
