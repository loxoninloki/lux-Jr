/** Compatibility capture stays local; only the caller decides when to send PCM. */
export function pcmCollector(rate:number,emit:(pcm:ArrayBuffer,level:number)=>void){
  let phase=0,sum=0,count=0,samples:number[]=[];
  return (input:Float32Array)=>{for(const sample of input){sum+=sample;count++;phase+=16000;
    if(phase>=rate){phase-=rate;samples.push(sum/count);sum=0;count=0;}
    if(samples.length===1600){const pcm=new ArrayBuffer(3200),view=new DataView(pcm);let energy=0;
      samples.forEach((value,i)=>{const s=Math.max(-1,Math.min(1,value));energy+=s*s;view.setInt16(i*2,s<0?s*32768:s*32767,true);});
      samples=[];emit(pcm,Math.sqrt(energy/1600));}
  }};
}
export async function deadline<T>(promise:Promise<T>,ms:number,message:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}
}
export async function startMicCapture(context:AudioContext,stream:MediaStream,frame:(pcm:ArrayBuffer,level:number)=>void,diagnostic:(text:string)=>void,signal:AbortSignal){
  let stopped=false,node:AudioWorkletNode|ScriptProcessorNode|null=null,received=false;
  let watch:ReturnType<typeof setTimeout>|undefined;
  const input=context.createMediaStreamSource(stream);
  const detach=()=>{input.disconnect();if(node){if('port' in node){node.port.onmessage=null;node.onprocessorerror=null;}else node.onaudioprocess=null;node.disconnect();node=null;}};
  const stop=()=>{if(stopped)return;stopped=true;clearTimeout(watch);detach();signal.removeEventListener('abort',stop);};
  signal.addEventListener('abort',stop,{once:true});
  const receive=(pcm:ArrayBuffer,level:number)=>{if(stopped||signal.aborted)return;received=true;frame(pcm,level);};
  const fallback=()=>{
    if(stopped||signal.aborted)return;detach();clearTimeout(watch);
    if(!context.createScriptProcessor)throw Error('予備のマイク処理を起動できません。Safariで開き直してください。');
    diagnostic('live:capture-compatibility');
    const legacy=context.createScriptProcessor(4096,1,1);node=legacy;
    const collect=pcmCollector(context.sampleRate,receive);
    legacy.onaudioprocess=event=>{event.outputBuffer.getChannelData(0).fill(0);collect(event.inputBuffer.getChannelData(0));};
    input.connect(legacy);legacy.connect(context.destination);
  };
  try{
    try{
      if(!context.audioWorklet)throw Error('no-worklet');
      await deadline(context.audioWorklet.addModule(new URL('./live-processor.js',import.meta.url).href),3000,'worklet-timeout');
      if(stopped||signal.aborted){stop();return{stop};}
      const worklet=new AudioWorkletNode(context,'lux-live-capture');node=worklet;
      worklet.port.onmessage=event=>{if(event.data?.pcm instanceof ArrayBuffer)receive(event.data.pcm,Number(event.data.level)||0);};
      // The outer watchdog reports failure if the compatibility node also fails.
      worklet.onprocessorerror=()=>{try{fallback();}catch{stop();}};
      worklet.port.start?.();input.connect(worklet);worklet.connect(context.destination);diagnostic('live:capture-worklet');
      const check=()=>{if(stopped||received)return;if(context.state!=='running'){watch=setTimeout(check,1000);return;}try{fallback();}catch{stop();}};
      watch=setTimeout(check,3000);
    }catch{fallback();}
    return{stop};
  }catch(error){stop();throw error;}
}
