import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateVoiceReply,SHORT_TEST_REPLY,LONG_TEST_REPLY } from './voice-simulation.ts';
import { VoiceSession } from './voice-session.ts';
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve()};
test('simulated response waits the selected latency and selects short or long fixed audio text',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const delay of [0,3000,10000,30000]){
  let done=false;const events=[];const p=simulateVoiceReply(delay,true,new AbortController().signal,e=>events.push(e)).then(v=>{done=true;return v});
  if(delay){t.mock.timers.tick(delay-1);await flush();assert.equal(done,false);t.mock.timers.tick(1);}else t.mock.timers.tick(0);
  assert.equal(await p,LONG_TEST_REPLY);assert.equal(events.at(-1),'recognition:test-reply-ready');
 }
 const p=simulateVoiceReply(0,false,new AbortController().signal,()=>{});t.mock.timers.tick(0);assert.equal(await p,SHORT_TEST_REPLY);
});
test('stop cancels a pending simulated response and cannot later emit a reply',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const control=new AbortController(),events=[];
 const p=simulateVoiceReply(30000,false,control.signal,e=>events.push(e));const rejected=assert.rejects(p,{name:'AbortError'});
 control.abort();t.mock.timers.tick(60000);await rejected;assert.equal(events.includes('recognition:test-reply-ready'),false);
});
test('already stopped simulation and unsupported delays fail without queueing a response',async()=>{
 const control=new AbortController();control.abort();await assert.rejects(simulateVoiceReply(3000,false,control.signal,()=>{}),{name:'AbortError'});
 await assert.rejects(simulateVoiceReply(123,false,new AbortController().signal,()=>{}));
});
test('three voice turns with delayed replies release capture, wait for playback and never use fetch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(globalThis,'fetch',()=>{throw Error('Simulation must not call a server')});
 const recs=[],spoken=[];let endPlayback;
 const session=new VoiceSession({
  createRecognition(){const rec={start(){this.onstart?.()},stop(){},abort(){this.aborted=true}};recs.push(rec);return rec},
  request:(_,signal)=>simulateVoiceReply(3000,false,signal,()=>{}),
  speak(text){spoken.push(text);return new Promise(resolve=>endPlayback=resolve)},cancelSpeech(){},phase(){},transcript(){},error(){},wait:async()=>{},
 });
 session.start();
 for(let i=0;i<3;i++){
  const rec=recs[i];rec.onresult({results:[Object.assign([{transcript:'テスト'}],{isFinal:true})]});rec.onend();
  assert.equal(rec.aborted,true);assert.equal(session.phase,'waiting');t.mock.timers.tick(2999);await flush();assert.equal(spoken.length,i);
  t.mock.timers.tick(1);await flush();assert.equal(session.phase,'speaking');assert.equal(recs.length,i+1);
  endPlayback();await flush();assert.equal(recs.length,i+2);
 }
 session.stop();assert.equal(fetch.mock.callCount(),0);
});
test('stopping a voice session during simulated delay never speaks or restarts capture',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let rec,spoke=0,created=0;
 const session=new VoiceSession({createRecognition(){created++;return rec={start(){this.onstart?.()},stop(){},abort(){}}},request:(_,signal)=>simulateVoiceReply(10000,true,signal,()=>{}),speak:async()=>{spoke++},cancelSpeech(){},phase(){},transcript(){},error(){},wait:async()=>{}});
 session.start();rec.onresult({results:[Object.assign([{transcript:'テスト'}],{isFinal:true})]});rec.onend();session.stop();t.mock.timers.tick(30000);await flush();assert.equal(spoke,0);assert.equal(created,1);
});
