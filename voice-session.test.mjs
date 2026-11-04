import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from './voice-session.ts';
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function setup(overrides={}) {
  const recognizers=[], requests=[], spoken=[], errors=[], phases=[];
  const session=new VoiceSession({
    createRecognition:()=>{const rec={start(){},stop(){this.stopped=true},abort(){this.aborted=true}};recognizers.push(rec);return rec},
    request:async(text,signal)=>{requests.push({text,signal});return 'お返事です。'},
    speak:async(text)=>{spoken.push(text)}, cancelSpeech(){},
    phase:p=>phases.push(p),transcript(){},error:e=>errors.push(e),wait:async()=>{},...overrides,
  });
  const result=(rec,text='こんにちは')=>rec.onresult?.({results:[Object.assign([{transcript:text}],{isFinal:true})]});
  return {session,recognizers,requests,spoken,errors,phases,result};
}
test('waits for microphone end, sends once, speaks, then listens again',async()=>{
 const t=setup();t.session.start();const rec=t.recognizers[0];
 t.result(rec);t.result(rec);assert.equal(t.requests.length,0);assert.equal(rec.stopped,true);
 rec.onend();await flush();assert.equal(t.requests.length,1);assert.equal(t.spoken.length,1);assert.equal(t.recognizers.length,2);assert.equal(t.session.phase,'listening');t.session.stop();
});
test('stop discards queued recognition callbacks and cannot auto-send',async()=>{
 const t=setup();t.session.start();const rec=t.recognizers[0];const result=rec.onresult,end=rec.onend;
 t.session.stop();result({results:[Object.assign([{transcript:'遅延イベント'}],{isFinal:true})]});end();await flush();
 assert.equal(t.requests.length,0);assert.equal(t.session.phase,'idle');assert.equal(rec.aborted,true);
});
test('stop aborts API request and ignores a late response',async()=>{
 let finish,signal;const t=setup({request:(_,s)=>{signal=s;return new Promise(r=>finish=r)}});
 t.session.start();t.result(t.recognizers[0]);t.recognizers[0].onend();t.session.stop();
 assert.equal(signal.aborted,true);finish('遅い回答');await flush();assert.equal(t.spoken.length,0);assert.equal(t.recognizers.length,1);
});
test('does not reopen microphone until playback has ended',async()=>{
 let end;const t=setup({speak:()=>new Promise(r=>end=r)});t.session.start();t.result(t.recognizers[0]);t.recognizers[0].onend();await flush();
 assert.equal(t.session.phase,'speaking');assert.equal(t.recognizers.length,1);end();await flush();assert.equal(t.recognizers.length,2);t.session.stop();
});
test('playback denial pauses with a user-gesture retry and does not send again',async()=>{
 let plays=0;const t=setup({speak:async()=>{if(++plays===1)throw Error('not-allowed')}});
 t.session.start();t.result(t.recognizers[0]);t.recognizers[0].onend();await flush();assert.equal(t.session.phase,'paused');assert.equal(t.recognizers.length,1);
 t.session.resume();await flush();assert.equal(plays,2);assert.equal(t.requests.length,1);assert.equal(t.recognizers.length,2);t.session.stop();
});
test('permission failure, silence and 429 end the session without retries',async()=>{
 const t=setup();t.session.start();t.recognizers[0].onerror({error:'not-allowed'});assert.equal(t.session.phase,'idle');assert.match(t.errors.at(-1),/許可/);
 t.session.start();t.recognizers[1].onend();assert.equal(t.session.phase,'idle');assert.equal(t.requests.length,0);
 const u=setup({request:async()=>{throw Error('利用上限です。')}});u.session.start();u.result(u.recognizers[0]);u.recognizers[0].onend();await flush();assert.equal(u.session.phase,'idle');assert.equal(u.recognizers.length,1);assert.equal(u.errors.at(-1),'利用上限です。');
});
test('a previous session cannot resume into a new session',async()=>{
 let end;const t=setup({speak:()=>new Promise(r=>end=r)});t.session.start();t.result(t.recognizers[0]);t.recognizers[0].onend();await flush();
 t.session.stop();t.session.start();end();await flush();assert.equal(t.recognizers.length,2);assert.equal(t.session.phase,'listening');t.session.stop();
});
