import type { VoicePhase } from './voice-session.ts';
export function pcmToFloat(data: string): Float32Array {
  const raw=atob(data);if(raw.length%2)throw Error('PCM');
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),out=new Float32Array(bytes.length/2);
  for(let i=0;i<out.length;i++)out[i]=view.getInt16(i*2,true)/32768;
  return out;
}
export function audioBase64(buffer:ArrayBuffer):string {
  const bytes=new Uint8Array(buffer);let raw='';for(let i=0;i<bytes.length;i++)raw+=String.fromCharCode(bytes[i]);return btoa(raw);
}
export type LiveHealth = { stage:string; inputLevel:number; sentFrames:number; receivedChunks:number; needsResume:boolean };
type LivePorts = {
  phase(value:VoicePhase):void; error(text:string):void; diagnostic(text:string):void;
  transcript(user:string,assistant:string):void; preview(text:string):void;
  ticket(signal:AbortSignal):Promise<{ticket:string;seconds:number;endpoint:string}>;
  health?(value:LiveHealth):void;
};
export class LiveConversation {
  private ports:LivePorts;private generation=0;private aborter:AbortController|null=null;
  private context:AudioContext|null=null;private stream:MediaStream|null=null;private capture:AudioWorkletNode|null=null;private input:MediaStreamAudioSourceNode|null=null;
  private socket:WebSocket|null=null;private ready=false;private nextPlay=0;private sources=new Set<AudioBufferSourceNode>();
  private handshake:ReturnType<typeof setTimeout>|undefined;private limit:ReturnType<typeof setTimeout>|undefined;
  private userText='';private assistantText='';
  private health:LiveHealth={stage:'停止中',inputLevel:0,sentFrames:0,receivedChunks:0,needsResume:false};
  private monitor:ReturnType<typeof setInterval>|undefined;private rejectCapture:((reason:Error)=>void)|null=null;
  private report(stage=this.health.stage){this.health={...this.health,stage};this.ports.health?.({...this.health});}
  async resumeAudio(){
    const context=this.context;if(!context)return;const current=this.generation;
    this.ports.diagnostic('live:audio-resume-request');
    try{await context.resume();if(current!==this.generation)return;
      this.health.needsResume=context.state!=='running';this.report(this.health.needsResume?'音声を再開できません。終了してSafariで開き直してください。':this.ready?'接続済み。お話しください。':'音声を再開しました。接続を準備しています。');
    }catch{if(current===this.generation){this.health.needsResume=true;this.report('音声を再開できません。終了して開始し直してください。');}}
  }
  constructor(ports:LivePorts){this.ports=ports;}
  stop(message='') {
    ++this.generation;this.ready=false;clearTimeout(this.handshake);clearTimeout(this.limit);this.aborter?.abort();this.aborter=null;
    if(this.socket){this.socket.onmessage=this.socket.onerror=this.socket.onclose=null;try{this.socket.close(1000,'User ended');}catch{}this.socket=null;}
    clearInterval(this.monitor);this.monitor=undefined;this.rejectCapture?.(new Error('音声準備を中止しました。'));this.rejectCapture=null;
    if(this.capture){this.capture.port.onmessage=null;this.capture.onprocessorerror=null;this.capture.disconnect();this.capture=null;}this.input?.disconnect();this.input=null;
    this.stream?.getTracks().forEach(track=>track.stop());this.stream=null;this.stopOutput();
    if(this.context){this.context.onstatechange=null;void this.context.close().catch(()=>{});this.context=null;}this.flush();
    this.health.needsResume=false;this.health.inputLevel=0;this.report(message||'停止中');
    this.ports.phase('idle');this.ports.diagnostic('live:stopped');if(message)this.ports.error(message);
  }
  private stopOutput(){for(const source of this.sources){source.onended=null;try{source.stop();}catch{}source.disconnect();}this.sources.clear();this.nextPlay=0;}
  private flush(){if(this.userText.trim()||this.assistantText.trim())this.ports.transcript(this.userText.trim(),this.assistantText.trim());this.userText='';this.assistantText='';}
  async start(){
    this.stop();this.ports.error('');const current=++this.generation;const valid=()=>current===this.generation;
    this.aborter=new AbortController();const signal=this.aborter.signal;this.ports.phase('starting');this.ports.diagnostic('live:connecting');
    this.health={stage:'マイクの許可を確認しています。',inputLevel:0,sentFrames:0,receivedChunks:0,needsResume:false};this.report();
    try {
      if(!navigator.mediaDevices?.getUserMedia||!window.AudioContext)throw Error('このブラウザではライブ音声を開始できません。Safariでお試しください。');
      // Construct/resume during the button gesture, before permission/network awaits.
      const context=new AudioContext();this.context=context;void context.resume().catch(()=>{});
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(!valid()){stream.getTracks().forEach(t=>t.stop());return;}this.stream=stream;
      this.report('マイクの音声処理を読み込んでいます。');
      if(!context.audioWorklet)throw Error('このSafariでは音声処理を読み込めません。iOSの更新をご確認ください。');
      try{await context.audioWorklet.addModule(new URL('./live-processor.js',import.meta.url).href);}catch{throw Error('マイクの音声処理を読み込めません。ページを更新してお試しください。');}if(!valid())return;
      const capture=new AudioWorkletNode(context,'lux-live-capture');this.capture=capture;
      let captured=false,lastFrame=Date.now(),lastReport=0;
      const firstFrame=new Promise<void>((resolve,reject)=>{
        this.rejectCapture=reject;
        capture.port.onmessage=event=>{
          if(!valid())return;const pcm=event.data?.pcm;if(!(pcm instanceof ArrayBuffer))return;
          lastFrame=Date.now();this.health.inputLevel=Math.max(0,Math.min(1,Number(event.data.level)||0));
          if(!captured){captured=true;this.rejectCapture=null;resolve();this.ports.diagnostic('live:microphone-frames');}
          if(this.ready&&this.socket?.readyState===WebSocket.OPEN&&context.state==='running'){
            if(this.socket.bufferedAmount>128000){this.stop('通信が追いつかないためライブを終了しました。');return;}
            try{this.socket.send(JSON.stringify({realtimeInput:{audio:{mimeType:'audio/pcm;rate=16000',data:audioBase64(pcm)}}}));this.health.sentFrames++;}
            catch{this.stop('マイク音声を送信できませんでした。');return;}
          }
          if(Date.now()-lastReport>500){lastReport=Date.now();this.report();}
        };
      });
      capture.onprocessorerror=()=>{if(valid())this.stop('マイクの音声処理が停止しました。終了してページを更新してください。');};
      capture.port.start?.();
      this.input=context.createMediaStreamSource(stream);this.input.connect(capture);capture.connect(context.destination);
      const updateAudioState=()=>{if(!valid())return;this.health.needsResume=context.state!=='running';this.ports.diagnostic(`live:audio-${context.state}`);this.report(this.health.needsResume?'音声が一時停止中です。「音声を有効にする」を押してください。':this.ready?'接続済み。お話しください。':'マイクの音声を確認しています。');};
      context.onstatechange=updateAudioState;
      // Microphone permission/routing can interrupt Safari's earlier resume.
      void context.resume().catch(()=>{});updateAudioState();
      const captureStarted=Date.now();
      this.monitor=setInterval(()=>{
        if(!valid())return;
        if(context.state!=='running'){if(!this.health.needsResume)updateAudioState();return;}
        if(Date.now()-(captured?lastFrame:captureStarted)>10000)this.stop('マイクから音声データが届いていません。Safariのマイク許可と接続先をご確認ください。');
      },1000);
      await firstFrame;if(!valid())return;
      this.report('マイク確認済み。LUXサーバーに接続しています。');
      const result=await this.ports.ticket(signal);if(!valid())return;
      this.report('Gemini Liveの開始を待っています。');this.ports.diagnostic('live:ticket-issued');
      const address=new URL(result.endpoint);address.protocol='wss:';address.pathname='/live';address.search='';address.searchParams.set('ticket',result.ticket);
      const socket=new WebSocket(address);this.socket=socket;socket.binaryType='arraybuffer';
      this.handshake=setTimeout(()=>{if(valid())this.stop('ライブの開始がタイムアウトしました。サーバーの更新と無料枠をご確認ください。');},20000);
      this.limit=setTimeout(()=>{if(valid())this.stop('2分間のライブ試用を終了しました。');},Math.min(result.seconds,120)*1000);
      socket.onopen=()=>{if(valid())this.ports.diagnostic('live:websocket-open');};
      socket.onmessage=event=>{
        if(!valid())return;
        try {
          const value=JSON.parse(typeof event.data==='string'?event.data:new TextDecoder().decode(event.data));
          if(value.luxClosed){this.stop(value.luxClosed);return;}
          if(value.setupComplete){this.ready=true;clearTimeout(this.handshake);this.ports.phase('listening');this.ports.diagnostic('live:ready');this.report('Gemini Liveに接続済み。お話しください。');}
          const content=value.serverContent;if(!content)return;
          if(content.interrupted){this.stopOutput();this.flush();this.ports.phase('listening');this.ports.diagnostic('live:interrupted');}
          if(content.inputTranscription?.text){this.userText=(this.userText+content.inputTranscription.text).slice(0,4000);this.ports.preview(this.userText);this.report('声が認識されました。');}
          if(content.outputTranscription?.text)this.assistantText=(this.assistantText+content.outputTranscription.text).slice(0,4000);
          for(const part of content.modelTurn?.parts||[]){const audio=part.inlineData;if(audio?.data&&audio.mimeType?.startsWith('audio/pcm')){this.health.receivedChunks++;this.play(audio.data,audio.mimeType);this.report(this.health.needsResume?'返答音声が届きました。「音声を有効にする」を押してください。':'ルクスの返答音声を再生しています。');}}
          if(content.turnComplete){this.flush();if(!this.sources.size)this.ports.phase('listening');this.ports.diagnostic('live:turn-complete');}
        } catch {this.stop('ライブ音声の処理に失敗しました。開始し直してください。');}
      };
      socket.onerror=()=>{if(valid())this.stop('ライブに接続できません。無料枠・サーバー更新・通信をご確認ください。');};
      socket.onclose=event=>{if(valid()){this.ports.diagnostic(`live:socket-close-${event.code}`);this.stop(`ライブ接続が終了しました（${event.code}）。無料枠・モデルの利用権限をご確認ください。`);}};
    } catch(error){if(valid())this.stop(error instanceof Error&&error.name==='NotAllowedError'?'マイクの許可が必要です。Safariのサイト設定をご確認ください。':error instanceof Error?error.message:'ライブを開始できませんでした。');}
  }
  private play(data:string,mime:string){
    const context=this.context;if(!context)return;const samples=pcmToFloat(data);const rate=Number(/rate=(\d+)/.exec(mime)?.[1]||24000);
    if(![16000,24000,48000].includes(rate)||this.nextPlay-context.currentTime>30)throw Error('audio queue');
    const buffer=context.createBuffer(1,samples.length,rate);buffer.getChannelData(0).set(samples);const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);
    const start=Math.max(context.currentTime+.04,this.nextPlay);this.nextPlay=start+buffer.duration;this.sources.add(source);this.ports.phase('speaking');
    source.onended=()=>{this.sources.delete(source);source.disconnect();if(!this.sources.size&&this.ready)this.ports.phase('listening');};source.start(start);
  }
}
