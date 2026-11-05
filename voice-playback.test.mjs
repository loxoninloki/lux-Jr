import test from 'node:test';
import assert from 'node:assert/strict';
import { playSpeech } from './voice-playback.ts';
function setup(t) {
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const oldWindow=globalThis.window,oldUtterance=globalThis.SpeechSynthesisUtterance;
 const synth={speaking:false,pending:false,paused:false,getVoices:()=>[],cancel(){this.speaking=false;this.pending=false},speak(u){this.utterance=u}};
 globalThis.window={speechSynthesis:synth};globalThis.SpeechSynthesisUtterance=class { constructor(text){this.text=text} };
 t.after(()=>{globalThis.window=oldWindow;globalThis.SpeechSynthesisUtterance=oldUtterance});
 return synth;
}
test('missing end event resolves only after playback and queue are quiet',async(t)=>{
 const synth=setup(t),control=new AbortController();let ended=false;
 const done=playSpeech('お返事です。','',control.signal,()=>{}).then(()=>{ended=true});
 synth.speaking=true;t.mock.timers.tick(300);await Promise.resolve();assert.equal(ended,false);
 synth.speaking=false;synth.pending=true;t.mock.timers.tick(900);await Promise.resolve();assert.equal(ended,false);
 synth.pending=false;t.mock.timers.tick(900);await done;assert.equal(ended,true);
});
test('paused playback is never treated as finished',async(t)=>{
 const synth=setup(t),control=new AbortController();const done=playSpeech('こんにちは','',control.signal,()=>{});const rejected=assert.rejects(done);
 synth.utterance.onstart();synth.paused=true;t.mock.timers.tick(1200);control.abort();await rejected;
});
test('end without start event still completes; a rejected start does not resume capture',async(t)=>{
 const synth=setup(t),control=new AbortController();const done=playSpeech('こんにちは','',control.signal,()=>{});synth.utterance.onend();await done;
 const failed=playSpeech('こんにちは','',control.signal,()=>{});const rejected=assert.rejects(failed);t.mock.timers.tick(10000);await rejected;
});
test('late start callback after cancellation cannot revive playback state',async(t)=>{
 const synth=setup(t),control=new AbortController(),states=[];
 const done=playSpeech('こんにちは','',control.signal,v=>states.push(v));const rejected=assert.rejects(done),late=synth.utterance.onstart;
 control.abort();late();await rejected;assert.deepEqual(states,[false]);
});
