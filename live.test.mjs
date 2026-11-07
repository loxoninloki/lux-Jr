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
test('trial tickets reserve app budget and prevent simultaneous trials without a daily count cap',async()=>{
 const l=ledger();const first=await issueLiveTicket(l,'persona');assert.equal(first.seconds,null);assert.equal(first.remainingToday,undefined);assert.equal((await l.usage()).reservedYen,100);
 assert.equal((await issueLiveTicket(l,'persona')).status,429);
 for(let i=0;i<4;i++){l.values.get('live-trial').activeUntil=0;assert.ok((await issueLiveTicket(l,'persona')).ticket);}
 assert.equal(l.values.get('live-trial').count,5);
 assert.equal((await l.usage()).reservedYen,500);
});
test('expired unused Live ticket releases only its reservation',async()=>{
 const l=ledger();const first=await issueLiveTicket(l,'persona');
 assert.ok(first.ticket);
 const ticket=l.values.get('live-ticket');ticket.expires=Date.now()-1;
 l.values.get('live-trial').activeUntil=0;
 const second=await issueLiveTicket(l,'persona');
 assert.ok(second.ticket);
 assert.equal(l.values.get('usage').reservedYen,100);
 assert.equal(l.values.get('usage').unusedLiveTickets,1);
});
test('consumed Live ticket is never refunded',async()=>{
 const l=ledger();await issueLiveTicket(l,'persona');
 l.values.delete('live-ticket');l.values.get('live-trial').activeUntil=0;
 await issueLiveTicket(l,'persona');
 assert.equal(l.values.get('usage').reservedYen,200);
});
test('expired unused ticket is recovered even when budget was full',async()=>{
 const l=ledger(100);await issueLiveTicket(l,'persona');
 l.values.get('live-ticket').expires=Date.now()-1;
 l.values.get('live-trial').activeUntil=0;
 const result=await issueLiveTicket(l,'persona');
 assert.ok(result.ticket);
 assert.equal(l.values.get('usage').reservedYen,100);
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

test('server keeps Live sockets open after 120 seconds and prevents parallel sessions',async(t)=>{
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
 t.mock.timers.tick(121000);assert.equal(pair[1].closed,false);assert.equal(upstream.closed,false);
 for(let i=0;i<15;i++)upstream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({serverContent:{turnComplete:true}})}));
 assert.equal(pair[1].closed,false);assert.equal(upstream.closed,false);
 l.values.get('live-trial').activeUntil=0;
 assert.equal((await issueLiveTicket(l,'persona')).status,429); // active connection lock
 assert.equal((await openLiveSocket(l,request)).status,409); // locked (and one-use)
 pair[1].dispatchEvent(new Event('close'));assert.equal(upstream.closed,true);
 assert.equal((await openLiveSocket(l,request)).status,401);
 assert.ok((await issueLiveTicket(l,'persona')).ticket);
});

test('Gemini Live distinguishes malformed upstream responses without leaking audio',async t=>{
 class Socket extends EventTarget {sent=[];accept(){}send(value){this.sent.push(value)}close(){this.closed=true}}
 const upstream=new Socket();let pair;
 const oldResponse=globalThis.Response,oldPair=globalThis.WebSocketPair;
 globalThis.Response=class{constructor(body,options){this.status=options.status;this.webSocket=options.webSocket}};
 globalThis.WebSocketPair=class{constructor(){this[0]=new Socket();this[1]=new Socket();pair=this}};
 t.mock.method(globalThis,'fetch',async()=>({webSocket:upstream}));
 t.after(()=>{globalThis.Response=oldResponse;globalThis.WebSocketPair=oldPair});
 const l=ledger();l.env.GEMINI_API_KEY='unit-test-only';
 const ticket=await issueLiveTicket(l,'persona');
 await openLiveSocket(l,new Request(`https://unit.test/live?ticket=${ticket.ticket}`,{headers:{Upgrade:'websocket'}}));
 upstream.dispatchEvent(new MessageEvent('message',{data:'{not json secret-audio'}));
 const result=JSON.parse(pair[1].sent.at(-1));
 assert.equal(result.luxDiagnostic,'live:upstream-invalid-json');
 assert.equal(result.luxClosed.includes('secret-audio'),false);
});
test('Gemini Live forwards binary JSON frames',async t=>{
 class Socket extends EventTarget {sent=[];accept(){}send(value){this.sent.push(value)}close(){this.closed=true}}
 const upstream=new Socket();let pair;
 const oldResponse=globalThis.Response,oldPair=globalThis.WebSocketPair;
 globalThis.Response=class{constructor(body,options){this.status=options.status;this.webSocket=options.webSocket}};
 globalThis.WebSocketPair=class{constructor(){this[0]=new Socket();this[1]=new Socket();pair=this}};
 t.mock.method(globalThis,'fetch',async()=>({webSocket:upstream}));
 t.after(()=>{globalThis.Response=oldResponse;globalThis.WebSocketPair=oldPair});
 const l=ledger();l.env.GEMINI_API_KEY='unit-test-only';
 const ticket=await issueLiveTicket(l,'persona');
 await openLiveSocket(l,new Request(`https://unit.test/live?ticket=${ticket.ticket}`,{headers:{Upgrade:'websocket'}}));
 const encoded=new TextEncoder().encode(JSON.stringify({setupComplete:{}}));
 upstream.dispatchEvent(new MessageEvent('message',{data:encoded.buffer}));
 assert.equal(JSON.parse(pair[1].sent.at(-1)).setupComplete !== undefined,true);
 assert.notEqual(pair[1].closed,true);
});
test('Cloudflare Blob upstream messages are decoded in order before text frames',async t=>{
 class Socket extends EventTarget {sent=[];accept(){}send(value){this.sent.push(value)}close(){this.closed=true}}
 const upstream=new Socket();let pair;
 const oldResponse=globalThis.Response,oldPair=globalThis.WebSocketPair;
 globalThis.Response=class{constructor(body,options){this.status=options.status;this.webSocket=options.webSocket}};
 globalThis.WebSocketPair=class{constructor(){this[0]=new Socket();this[1]=new Socket();pair=this}};
 t.mock.method(globalThis,'fetch',async()=>({webSocket:upstream}));
 t.after(()=>{globalThis.Response=oldResponse;globalThis.WebSocketPair=oldPair});
 const l=ledger();l.env.GEMINI_API_KEY='unit-test-only';
 const ticket=await issueLiveTicket(l,'persona');
 await openLiveSocket(l,new Request(`https://unit.test/live?ticket=${ticket.ticket}`,{headers:{Upgrade:'websocket'}}));
 const first=new Blob([JSON.stringify({setupComplete:{}})],{type:'application/json'});
 upstream.dispatchEvent(new MessageEvent('message',{data:first}));
 upstream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({serverContent:{turnComplete:true}})}));
 for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 const replies=pair[1].sent.map(v=>JSON.parse(v));
 assert.ok(replies[0].setupComplete);
 assert.equal(replies[1].serverContent.turnComplete,true);
 assert.equal(pair[1].closed,undefined);
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
 let capture,socket,context;const sources=[];const tracks=[{stopped:false,stop(){this.stopped=true}}];
 class Context {state='running';currentTime=0;destination={};audioWorklet={addModule:async()=>{}};constructor(){context=this}async resume(){this.state='running';this.onstatechange?.()}async close(){this.state='closed'}createMediaStreamSource(){return{connect(){},disconnect(){}}}createBuffer(_,n,rate){return{duration:n/rate,getChannelData:()=>new Float32Array(n)}}createBufferSource(){const source={connect(){},disconnect(){},start(){},stop(){}};sources.push(source);return source;}}
 class WS {static OPEN=1;readyState=1;bufferedAmount=0;sent=[];constructor(){socket=this}send(v){this.sent.push(v)}close(){this.closed=true}}
 class Capture {constructor(){capture=this;this.port={}}connect(){if(autoFrame)queueMicrotask(()=>this.port.onmessage?.({data:{pcm:new ArrayBuffer(3200),level:.1}}))}disconnect(){}}
 for(const [n,value]of Object.entries({window:{AudioContext:Context},AudioContext:Context,AudioWorkletNode:Capture,WebSocket:WS,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>tracks})}}}))Object.defineProperty(globalThis,n,{configurable:true,writable:true,value});
 t.after(()=>{for(const[n,d]of original)d?Object.defineProperty(globalThis,n,d):delete globalThis[n]});
 return{get capture(){return capture},get context(){return context},get socket(){return socket},tracks,sources};
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

const audioMessage=(data='AAAAAA==')=>({data:JSON.stringify({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data}}]}}})});
function conversation(health,events,extra={}){return new LiveConversationForTests({phase(){},error(){},diagnostic:v=>events.push(v),transcript(){},preview(){},health,ticket:async()=>({ticket:'private-ticket',seconds:120,endpoint:'https://unit.test'}),...extra});}
// Reuse the production class with browser ports; no real audio or credentials.
import { LiveConversation as LiveConversationForTests } from './live-audio.ts';
test('received, scheduled and ended are separate; suspended output resumes the bounded queue',async(t)=>{
 const h=fakeBrowser(t),events=[];let health;
 const live=conversation(v=>health=v,events);t.after(()=>live.stop());await live.start();h.socket.onmessage({data:JSON.stringify({setupComplete:{}})});
 h.context.state='suspended'; // Recheck even when Safari misses statechange.
 h.socket.onmessage(audioMessage());assert.equal(health.needsResume,true);
 for(const event of ['live:audio-received','live:playback-blocked','live:playback-scheduled'])assert.ok(events.includes(event));
 assert.equal(events.includes('live:playback-ended'),false);await live.resumeAudio();assert.equal(health.needsResume,false);
 h.sources[0].onended();assert.ok(events.includes('live:playback-ended'));
 assert.equal(events.some(e=>e.includes('private-ticket')),false);
});
test('malformed audio reports playback failure and releases resources',async(t)=>{
 const h=fakeBrowser(t),events=[];const live=conversation(()=>{},events);t.after(()=>live.stop());await live.start();
 h.socket.onmessage(audioMessage('AA=='));assert.ok(events.includes('live:playback-failed'));assert.equal(h.tracks[0].stopped,true);assert.equal(h.socket.closed,true);
});
test('no-audio turn and failed socket produce distinct diagnostics',async(t)=>{
 const h=fakeBrowser(t),events=[];const live=conversation(()=>{},events);t.after(()=>live.stop());await live.start();
 h.socket.onmessage({data:JSON.stringify({setupComplete:{},serverContent:{turnComplete:true}})});assert.ok(events.includes('live:turn-without-audio'));
 h.socket.onerror();assert.ok(events.includes('live:websocket-error'));assert.equal(h.tracks[0].stopped,true);
});
test('microphone denial is diagnosed before a ticket is requested',async(t)=>{
 fakeBrowser(t);navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('private detail','NotAllowedError')};
 const events=[];let tickets=0;const live=conversation(()=>{},events,{ticket:async()=>{tickets++;throw Error()}});t.after(()=>live.stop());await live.start();
 assert.ok(events.includes('live:microphone-denied'));assert.equal(tickets,0);assert.equal(events.some(e=>e.includes('private detail')),false);
});
test('upstream numeric close code is recorded without its potentially sensitive reason',async(t)=>{
 const h=fakeBrowser(t),events=[];const live=conversation(()=>{},events);t.after(()=>live.stop());await live.start();
 h.socket.onmessage({data:JSON.stringify({luxClosed:'接続終了',luxDiagnostic:'live:upstream-close-1008',reason:'secret'})});
 assert.ok(events.includes('live:upstream-close-1008'));assert.equal(events.some(e=>e.includes('secret')),false);
});

import { LiveEcho } from './live-echo.ts';
import { LiveOutput } from './live-output.ts';
const settleLive=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
test('new audio-to-audio local test makes three round trips with one microphone and no API or speech services',async t=>{
 const h=fakeBrowser(t),events=[];let tickets=0,health,permissions=0;
 const get=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=async()=>{permissions++;return get()};
 window.SpeechRecognition=class{constructor(){assert.fail('No speech recognition')}};
 window.speechSynthesis={speak(){assert.fail('No speech synthesis')}};
 t.mock.method(globalThis,'fetch',()=>assert.fail('No API'));
 const live=conversation(v=>health=v,events,{ticket:async()=>{tickets++;assert.fail('No ticket')}});t.after(()=>live.stop());
 await live.start({localTest:true});const capture=h.capture;
 const frame=level=>capture.port.onmessage({data:{pcm:new ArrayBuffer(3200),level}});
 for(let turn=0;turn<3;turn++){
   for(let i=0;i<3;i++)frame(0);
   for(let i=0;i<5;i++)frame(.1);
   for(let i=0;i<9;i++)frame(0);
   assert.equal(h.sources.length,turn+1);frame(.5); // playback must not record itself
   h.sources.at(-1).onended();assert.equal(health.completedTurns,turn+1);assert.equal(h.capture,capture);assert.equal(h.tracks[0].stopped,false);
 }
 assert.equal(permissions,1);assert.equal(tickets,0);assert.equal(fetch.mock.callCount(),0);assert.equal(h.socket,undefined);
 assert.equal(events.filter(e=>e==='live:local-voice-captured').length,3);live.stop();assert.equal(h.tracks[0].stopped,true);
});
test('local voice buffers are bounded, exclude playback and ignore short clicks',()=>{
 const replies=[];const echo=new LiveEcho(v=>replies.push(v));
 echo.push(new ArrayBuffer(3200),.1,false);for(let i=0;i<9;i++)echo.push(new ArrayBuffer(3200),0,false);assert.equal(replies.length,0);
 for(let i=0;i<100;i++)echo.push(new ArrayBuffer(3200),.9,true);assert.equal(replies.length,0);
 for(let i=0;i<3;i++)echo.push(new ArrayBuffer(3200),0,false);
 for(let i=0;i<9;i++)echo.push(new ArrayBuffer(30000),.1,false);
 assert.equal(replies.length,1);assert.equal(replies[0].length,128000);echo.reset();
});
test('muting sends silence without replacing the live capture or closing its connection',async t=>{
 const h=fakeBrowser(t);let health;const live=conversation(v=>health=v,[],{});t.after(()=>live.stop());
 await live.start();h.socket.onmessage({data:JSON.stringify({setupComplete:{}})});const capture=h.capture;
 const pcm=new Int16Array(1600).fill(10000).buffer;live.setMuted(true);capture.port.onmessage({data:{pcm,level:.3}});
 assert.equal(health.muted,true);assert.equal(health.inputLevel,0);assert.ok(pcmToFloat(JSON.parse(h.socket.sent.at(-1)).realtimeInput.audio.data).every(x=>x===0));
 live.setMuted(false);capture.port.onmessage({data:{pcm,level:.3}});assert.ok(pcmToFloat(JSON.parse(h.socket.sent.at(-1)).realtimeInput.audio.data)[0]>.2);assert.equal(h.capture,capture);assert.equal(h.tracks[0].stopped,false);
});
test('queued audio on a suspended context remains bounded and clearing it ignores late completion',t=>{
 const h=fakeBrowser(t);const ctx=new AudioContext();let ended=0;const output=new LiveOutput(ctx,()=>{},()=>ended++);
 ctx.state='suspended';output.enqueue(new Float32Array(24000),24000);const late=h.sources[0].onended;
 assert.equal(output.busy,true);output.clear();late();assert.equal(ended,0);assert.equal(output.busy,false);
 assert.throws(()=>output.enqueue(new Float32Array(24000*31),24000));assert.equal(output.busy,false);
});
test('mixed asynchronous and string socket messages preserve interruption ordering',async t=>{
 const h=fakeBrowser(t),events=[];const live=conversation(()=>{},events);t.after(()=>live.stop());await live.start();h.socket.onmessage({data:JSON.stringify({setupComplete:{}})});
 let resolve;h.socket.onmessage({data:{text:()=>new Promise(r=>resolve=r)}});await settleLive();
 h.socket.onmessage({data:JSON.stringify({serverContent:{interrupted:true}})});assert.equal(h.sources.length,0);
 resolve(audioMessage().data);await settleLive();assert.equal(h.sources.length,1);assert.equal(h.sources[0].onended,null);assert.ok(events.includes('live:interrupted'));assert.equal(h.tracks[0].stopped,false);
});
test('stop ignores a late ticket and releases a permission stream granted after cancellation',async t=>{
 const h=fakeBrowser(t);let resolveTicket;
 const live=conversation(()=>{},[],{ticket:()=>new Promise(r=>resolveTicket=r)});t.after(()=>live.stop());
 const starting=live.start();await new Promise(r=>setImmediate(r));live.stop();resolveTicket({ticket:'late',seconds:120,endpoint:'https://unit.test'});await starting;assert.equal(h.socket,undefined);assert.equal(h.tracks[0].stopped,true);
 let allow;navigator.mediaDevices.getUserMedia=()=>new Promise(r=>allow=r);const second=live.start();live.stop();let stopped=false;allow({getTracks:()=>[{stop(){stopped=true}}]});await second;assert.equal(stopped,true);assert.equal(h.socket,undefined);
});
test('microphone continues sending through playback for three server turns',async t=>{
 const h=fakeBrowser(t),events=[];let health;const live=conversation(v=>health=v,events);t.after(()=>live.stop());await live.start();h.socket.onmessage({data:JSON.stringify({setupComplete:{}})});const capture=h.capture;
 for(let i=0;i<3;i++){
  capture.port.onmessage({data:{pcm:new ArrayBuffer(3200),level:.1}});h.socket.onmessage(audioMessage());
  capture.port.onmessage({data:{pcm:new ArrayBuffer(3200),level:.1}});h.socket.onmessage({data:JSON.stringify({serverContent:{turnComplete:true}})});h.sources.at(-1).onended();
 }
 assert.equal(h.socket.sent.length,6);assert.equal(health.completedTurns,3);assert.equal(h.capture,capture);assert.equal(h.tracks[0].stopped,false);
});
