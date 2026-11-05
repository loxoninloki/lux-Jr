import test from 'node:test';
import assert from 'node:assert/strict';
import { Dictation } from './dictation.ts';
import { pcmCollector,startMicCapture } from './mic-capture.ts';
function dictation(){const rec={start(){},stop(){},abort(){this.aborted=true}};const text=[],errors=[],phases=[];const d=new Dictation({create:()=>rec,phase:v=>phases.push(v),text:v=>text.push(v),error:v=>errors.push(v),diagnostic(){}});return{d,rec,text,errors,phases};}
test('manual input previews interim text and preserves it when Safari ends without a final result',()=>{
 const h=dictation();h.d.start();assert.equal(h.phases.at(-1),'starting');h.rec.onstart();assert.equal(h.phases.at(-1),'listening');
 const result=[{transcript:'こんにちは'}];result.isFinal=false;h.rec.onresult({results:[result]});assert.equal(h.text.at(-1),'こんにちは');h.rec.onend();assert.equal(h.text.at(-1),'こんにちは');assert.equal(h.rec.aborted,true);assert.equal(h.phases.at(-1),'idle');
});
test('manual input handles missing end and ignores late result after cancel',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=dictation();h.d.start();h.rec.onstart();const late=h.rec.onresult;const result=[{transcript:'ろき様'}];result.isFinal=true;h.rec.onresult({results:[result]});t.mock.timers.tick(1500);assert.equal(h.phases.at(-1),'idle');const length=h.text.length;late({results:[[{transcript:'古い結果'}]]});assert.equal(h.text.length,length);
});
test('manual input reports an unacknowledged start rather than claiming to listen',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=dictation();h.d.start();t.mock.timers.tick(8000);assert.ok(h.errors.at(-1).includes('起動しません'));assert.equal(h.phases.includes('listening'),false);assert.equal(h.rec.aborted,true);
});
function context(){let legacy;const input={connect(){},disconnect(){}};const ctx={state:'running',sampleRate:48000,destination:{},createMediaStreamSource:()=>input,audioWorklet:{addModule:async()=>{throw Error('load')}},createScriptProcessor(){legacy={connect(){},disconnect(){},onaudioprocess:null};return legacy}};return{ctx,get legacy(){return legacy}};}
test('failed worklet uses local compatibility capture with correct signed PCM and silent output',async()=>{
 const h=context(),frames=[],events=[],abort=new AbortController();const c=await startMicCapture(h.ctx,{},(pcm,level)=>frames.push({pcm,level}),v=>events.push(v),abort.signal);
 const output=new Float32Array(4800).fill(1);h.legacy.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4800).fill(-.5)},outputBuffer:{getChannelData:()=>output}});
 assert.equal(events.at(-1),'live:capture-compatibility');assert.equal(frames.length,1);assert.equal(new DataView(frames[0].pcm).getInt16(0,true),-16384);assert.ok(output.every(s=>s===0));abort.abort();assert.equal(h.legacy.onaudioprocess,null);c.stop();
});
test('compatibility resampling preserves 16kHz rate for 44.1kHz and 48kHz microphones',()=>{
 for(const rate of[44100,48000]){const frames=[];const collect=pcmCollector(rate,(pcm)=>frames.push(pcm));collect(new Float32Array(rate));assert.equal(frames.length,10);assert.equal(frames.reduce((n,f)=>n+f.byteLength,0),32000);}
});
test('a hung worklet load falls back after three seconds without waiting forever',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=context();h.ctx.audioWorklet.addModule=()=>new Promise(()=>{});const abort=new AbortController();const pending=startMicCapture(h.ctx,{},()=>{},()=>{},abort.signal);t.mock.timers.tick(3000);const c=await pending;assert.ok(h.legacy);c.stop();
});
