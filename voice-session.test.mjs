import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from './voice-session.ts';
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function setup(overrides={}) {
  const recognizers=[], requests=[], spoken=[], errors=[], phases=[];
  const session=new VoiceSession({
    createRecognition:()=>{const rec={start(){this.onstart?.()},stop(){this.stopped=true},abort(){this.aborted=true}};recognizers.push(rec);return rec},
    request:async(text,signal)=>{requests.push({text,signal});return 'お返事です。'},
    speak:async(text)=>{spoken.push(text)}, cancelSpeech(){},
    phase:p=>phases.push(p),transcript(){},error:e=>errors.push(e),wait:async()=>{},...overrides,
  });
  const result=(rec,text='こんにちは')=>rec.onresult?.({results:[Object.assign([{transcript:text}],{isFinal:true})]});
  return {session,recognizers,requests,spoken,errors,phases,result};
}
test('waits for microphone end, sends once, speaks, then listens again',async()=>{
 const t=setup();t.session.start();const rec=t.recognizers[0];
 t.result(rec);t.result(rec);assert.equal(t.requests.length,0);assert.equal(rec.stopped,undefined);
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
test('permission failure pauses, silence recovers, and 429 stops without API retries',async()=>{
 const t=setup();t.session.start();t.recognizers[0].onerror({error:'not-allowed'});assert.equal(t.session.phase,'mic-paused');assert.match(t.errors.at(-1),/許可/);
 t.session.start();t.recognizers[1].onend();await flush();assert.equal(t.session.phase,'listening');assert.equal(t.requests.length,0);t.session.stop();
 const u=setup({request:async()=>{throw Error('利用上限です。')}});u.session.start();u.result(u.recognizers[0]);u.recognizers[0].onend();await flush();assert.equal(u.session.phase,'idle');assert.equal(u.recognizers.length,1);assert.equal(u.errors.at(-1),'利用上限です。');
});
test('a previous session cannot resume into a new session',async()=>{
 let end;const t=setup({speak:()=>new Promise(r=>end=r)});t.session.start();t.result(t.recognizers[0]);t.recognizers[0].onend();await flush();
 t.session.stop();t.session.start();end();await flush();assert.equal(t.recognizers.length,2);assert.equal(t.session.phase,'listening');t.session.stop();
});

test('releases the old capture with abort before speaking, then creates a fresh recognizer',async()=>{
 let t;t=setup({speak:async()=>assert.equal(t.recognizers[0].aborted,true)});
 t.session.start();t.result(t.recognizers[0]);t.recognizers[0].onend();await flush();
 assert.equal(t.recognizers.length,2);assert.notEqual(t.recognizers[0],t.recognizers[1]);t.session.stop();
});
test('start must be acknowledged before displaying listening; retries a missing start',async(context)=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const recs=[];const t=setup({createRecognition:()=>{const rec={start(){},stop(){},abort(){}};recs.push(rec);return rec}});
 t.session.start();assert.equal(t.session.phase,'starting');
 context.mock.timers.tick(8000);await flush();assert.equal(recs.length,2);
 recs[1].onstart();assert.equal(t.session.phase,'listening');t.session.stop();
});
test('silent capture after playback retries twice then offers manual recovery without API calls',async(context)=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const t=setup();t.session.start();
 for(let i=0;i<3;i++){context.mock.timers.tick(25000);await flush();}
 assert.equal(t.session.phase,'mic-paused');assert.equal(t.recognizers.length,3);assert.equal(t.requests.length,0);
 t.session.restartMicrophone();assert.equal(t.session.phase,'listening');assert.equal(t.recognizers.length,4);t.session.stop();
});
test('manual microphone recovery ignores callbacks from the old recognizer',async()=>{
 const t=setup();t.session.start();const old=t.recognizers[0],end=old.onend;
 t.session.restartMicrophone();end();await flush();assert.equal(t.recognizers.length,2);assert.equal(t.requests.length,0);t.session.stop();
});
test('stop during recovery delay never restarts the microphone',async()=>{
 let release;const t=setup({wait:()=>new Promise(resolve=>release=resolve)});
 t.session.start();t.recognizers[0].onend();assert.equal(t.session.phase,'recovering');
 t.session.stop();release();await flush();assert.equal(t.recognizers.length,1);assert.equal(t.session.phase,'idle');
});

test('final transcript survives missing end event and is submitted once',async(context)=>{
 context.mock.timers.enable({apis:['setTimeout']});const t=setup();t.session.start();const rec=t.recognizers[0],lateEnd=rec.onend;
 t.result(rec);context.mock.timers.tick(1800);context.mock.timers.tick(4000);await flush();assert.equal(t.requests.length,1);assert.equal(t.requests[0].text,'こんにちは');assert.equal(rec.aborted,true);
 lateEnd();await flush();assert.equal(t.requests.length,1);t.session.stop();
});
test('manual finish submits interim text only when explicitly requested',async()=>{
 const t=setup();t.session.start();const rec=t.recognizers[0];
 rec.onresult({results:[Object.assign([{transcript:'まだ確定していない言葉'}],{isFinal:false})]});assert.equal(t.requests.length,0);
 t.session.finishSpeaking();rec.onend();await flush();assert.equal(t.requests.length,1);assert.equal(t.requests[0].text,'まだ確定していない言葉');t.session.stop();
});
test('recognizer aborted error after a final result does not discard the utterance',async()=>{
 const t=setup();t.session.start();const rec=t.recognizers[0];t.result(rec);rec.onerror({error:'aborted'});await flush();assert.equal(t.requests.length,1);t.session.stop();
});
test('stop while finishing prevents delayed submission',async(context)=>{
 context.mock.timers.enable({apis:['setTimeout']});const t=setup();t.session.start();t.result(t.recognizers[0]);t.session.stop();context.mock.timers.tick(8000);await flush();assert.equal(t.requests.length,0);
});

test('final segments do not end capture immediately and repeated results send once after silence',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=setup();h.session.start();const rec=h.recognizers[0];
 assert.equal(rec.continuous,true);h.result(rec,'一文目。');assert.equal(rec.stopped,undefined);
 t.mock.timers.tick(1000);const results=[Object.assign([{transcript:'一文目。'}],{isFinal:true}),Object.assign([{transcript:'二文目。'}],{isFinal:true})];
 rec.onresult({results});rec.onresult({results});t.mock.timers.tick(1799);assert.equal(rec.stopped,undefined);
 t.mock.timers.tick(1);assert.equal(rec.stopped,true);assert.equal(h.requests.length,0);
 const end=rec.onend;end();end();await flush();assert.equal(h.requests.length,1);assert.equal(h.requests[0].text,'一文目。二文目。');h.session.stop();
});
test('explicit finish preserves interim suffix after a final segment',async()=>{
 const h=setup();h.session.start();const rec=h.recognizers[0];
 rec.onresult({results:[Object.assign([{transcript:'確定。'}],{isFinal:true}),Object.assign([{transcript:'続き'}],{isFinal:false})]});
 h.session.finishSpeaking();rec.onend();await flush();assert.equal(h.requests[0].text,'確定。続き');h.session.stop();
});

test('post-playback start with no results pauses without another request or restart loop',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const events=[];const h=setup({diagnostic:v=>events.push(v)});
 h.session.start();h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();
 assert.equal(h.recognizers.length,2);const next=h.recognizers[1];next.onaudiostart();
 t.mock.timers.tick(10000);await flush();assert.equal(h.session.phase,'mic-paused');
 assert.equal(h.requests.length,1);assert.equal(h.recognizers.length,2);assert.ok(events.includes('recognition:no-results'));
 assert.equal(next.aborted,true);h.session.restartMicrophone();assert.equal(h.recognizers.length,3);
 h.result(h.recognizers[2],'二回目');h.recognizers[2].onend();await flush();assert.equal(h.requests.length,2);h.session.stop();
});
test('recognition errors record only safe codes and stale audio callbacks are ignored',()=>{
 const events=[];const h=setup({diagnostic:v=>events.push(v)});h.session.start();const rec=h.recognizers[0],late=rec.onaudiostart;
 rec.onerror({error:'private transcript'});assert.ok(events.includes('recognition:error-other'));
 const count=events.length;late();assert.equal(events.length,count);h.session.stop();
});

test('a start timeout switches following replies to gesture playback without resending requests',async()=>{
 let plays=0,learned=0;const h=setup({speak:async()=>{if(++plays===1)throw Object.assign(Error('blocked'),{code:'speech-start-timeout'})},playbackGestureRequired:()=>learned++});
 h.session.start();h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();assert.equal(h.session.phase,'paused');assert.equal(learned,1);
 h.session.resume();await flush();assert.equal(plays,2);assert.equal(h.requests.length,1);
 h.result(h.recognizers[1],'次の言葉');h.recognizers[1].onend();await flush();
 assert.equal(h.session.phase,'paused');assert.equal(plays,2);assert.equal(h.requests.length,2);
 h.session.resume();await flush();assert.equal(plays,3);assert.equal(h.requests.length,2);h.session.stop();
});
test('preferred gesture mode queues a reply and starts speak synchronously on one click',async()=>{
 let plays=0,endPlayback;const h=setup({preferPlaybackGesture:true,speak:()=>{plays++;return new Promise(r=>endPlayback=r)}});
 h.session.start();h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();assert.equal(plays,0);assert.equal(h.session.phase,'paused');
 h.session.resume();assert.equal(plays,1);h.session.resume();assert.equal(plays,1);assert.equal(h.recognizers.length,1);
 endPlayback();await flush();assert.equal(h.recognizers.length,2);assert.equal(h.requests.length,1);h.session.stop();
});
test('stop discards pending gesture playback and late failed speech cannot change mode',async()=>{
 const h=setup({preferPlaybackGesture:true});h.session.start();h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();h.session.stop();h.session.resume();await flush();assert.equal(h.spoken.length,0);
 let rejectSpeech,learned=0;const j=setup({speak:()=>new Promise((_,reject)=>rejectSpeech=reject),playbackGestureRequired:()=>learned++});j.session.start();j.result(j.recognizers[0]);j.recognizers[0].onend();await flush();j.session.stop();rejectSpeech(Object.assign(Error(),{code:'speech-not-allowed'}));await flush();assert.equal(learned,0);assert.equal(j.session.phase,'idle');
});
test('audio hardware failure does not assume a user gesture is the cause',async()=>{
 let learned=0;const h=setup({speak:async()=>{throw Object.assign(Error(),{code:'speech-playback-failed'})},playbackGestureRequired:()=>learned++});
 h.session.start();h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();assert.equal(learned,0);assert.equal(h.session.phase,'paused');h.session.stop();
});

test('button microphone mode waits after playback and starts capture in the click call stack for three turns',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});let waitCalls=0,plays=0;
 const h=setup({preferPlaybackGesture:true,preferMicrophoneGesture:true,wait:async()=>{waitCalls++},speak:async()=>{plays++}});
 h.session.start();
 for(let turn=0;turn<3;turn++){
   const rec=h.recognizers[turn];h.result(rec,`発話${turn}`);rec.onend();await flush();
   assert.equal(h.session.phase,'paused');h.session.restartMicrophone();assert.equal(h.recognizers.length,turn+1);
   h.session.resume();await flush();assert.equal(h.session.phase,'mic-ready');assert.equal(plays,turn+1);
   t.mock.timers.tick(30000);await flush();assert.equal(h.recognizers.length,turn+1);assert.equal(h.requests.length,turn+1);
   h.session.restartMicrophone();assert.equal(h.session.phase,'listening');assert.equal(h.recognizers.length,turn+2);
 }
 assert.equal(waitCalls,0);h.session.stop();
});
test('successful playback does not cancel the completed speech before microphone handoff',async()=>{
 let cancels=0;const h=setup({cancelSpeech:()=>cancels++});h.session.start();const initial=cancels;
 h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();assert.equal(h.session.phase,'listening');assert.equal(cancels,initial);
 h.session.stop();assert.ok(cancels>initial);
});
test('button microphone mode cannot open capture during playback or after stop',async()=>{
 let finish;const h=setup({preferMicrophoneGesture:true,speak:()=>new Promise(r=>finish=r)});
 h.session.start();h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();assert.equal(h.session.phase,'speaking');
 h.session.restartMicrophone();assert.equal(h.recognizers.length,1);finish();await flush();assert.equal(h.session.phase,'mic-ready');
 h.session.stop();h.session.restartMicrophone();h.session.resume();await flush();assert.equal(h.recognizers.length,1);assert.equal(h.requests.length,1);
});
test('a stopped or failed playback cannot signal that the microphone is ready',async()=>{
 let finish;const h=setup({preferMicrophoneGesture:true,speak:()=>new Promise(r=>finish=r)});
 h.session.start();h.result(h.recognizers[0]);h.recognizers[0].onend();await flush();h.session.stop();finish();await flush();assert.equal(h.session.phase,'idle');assert.ok(!h.phases.includes('mic-ready'));
 const j=setup({preferMicrophoneGesture:true,speak:async()=>{throw Error('failed')}});j.session.start();j.result(j.recognizers[0]);j.recognizers[0].onend();await flush();assert.equal(j.session.phase,'paused');assert.ok(!j.phases.includes('mic-ready'));j.session.stop();
});
