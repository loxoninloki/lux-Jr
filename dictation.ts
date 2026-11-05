import type { Recognition } from './voice-session.ts';
type Ports={create():Recognition;phase(value:'idle'|'starting'|'listening'|'finishing'):void;text(value:string):void;error(value:string):void;diagnostic(value:string):void};
/** One utterance into the editor. It never sends messages or invokes an AI API. */
export class Dictation{
 private rec:Recognition|null=null;private epoch=0;private timer:ReturnType<typeof setTimeout>|undefined;private draft='';private hasFinal=false;
 private ports:Ports;
 constructor(ports:Ports){this.ports=ports;}
 cancel(){++this.epoch;clearTimeout(this.timer);const rec=this.rec;this.rec=null;if(rec){rec.onstart=rec.onresult=rec.onerror=rec.onend=null;try{rec.abort();}catch{}}this.ports.phase('idle');}
 finish(){if(!this.rec)return;this.ports.phase('finishing');clearTimeout(this.timer);this.timer=setTimeout(()=>this.complete(),1500);try{this.rec.stop();}catch{this.complete();}}
 private complete(){const text=this.draft.trim();this.cancel();if(text)this.ports.text(text);else this.ports.error('音声を認識できませんでした。iPhoneキーボードのマイクからも入力できます。');}
 start(){this.cancel();this.draft='';this.hasFinal=false;this.ports.error('');const epoch=this.epoch;
  let rec:Recognition;try{rec=this.ports.create();}catch{this.ports.error('このブラウザの音声認識は使えません。iPhoneキーボードのマイクをお試しください。');return;}
  this.rec=rec;const valid=()=>epoch===this.epoch&&this.rec===rec;rec.lang='ja-JP';rec.continuous=false;rec.interimResults=true;
  rec.onstart=()=>{if(!valid())return;this.ports.diagnostic('dictation:started');this.ports.phase('listening');clearTimeout(this.timer);this.timer=setTimeout(()=>{if(valid())this.finish();},20000);};
  rec.onresult=event=>{if(!valid())return;let text='';for(let i=0;i<event.results.length;i++){text+=event.results[i][0]?.transcript||'';if(event.results[i].isFinal)this.hasFinal=true;}this.draft=text;this.ports.text(text);this.ports.diagnostic(this.hasFinal?'dictation:final':'dictation:interim');if(this.hasFinal)this.finish();};
  rec.onend=()=>{if(valid())this.complete();};
  rec.onerror=event=>{if(!valid())return;const code=event.error;this.ports.diagnostic(`dictation:error-${['not-allowed','service-not-allowed','audio-capture','no-speech','network','aborted'].includes(code)?code:'other'}`);if(this.draft.trim()){this.complete();return;}this.cancel();this.ports.error(code==='not-allowed'||code==='service-not-allowed'?'Safariの音声認識が許可されていません。マイクの許可と、iPhoneの「Siriと音声入力」の制限をご確認ください。':code==='network'?'音声認識サービスにつながりません。通信状態を確認するか、キーボードのマイクから入力してください。':'音声入力が中断されました。キーボードのマイクからも入力できます。');};
  this.ports.phase('starting');this.ports.diagnostic('dictation:starting');this.timer=setTimeout(()=>{if(!valid())return;this.cancel();this.ports.error('Safariの音声認識が起動しませんでした。iPhoneキーボードのマイクをお試しください。');},8000);
  try{rec.start();}catch{this.cancel();this.ports.error('音声入力を起動できません。少し待って再度お試しください。');}
 }
}
