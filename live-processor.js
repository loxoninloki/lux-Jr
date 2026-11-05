// Microphone capture: continuous PCM16 mono, 16 kHz, 100 ms per frame.
class LuxLiveCapture extends AudioWorkletProcessor {
  constructor() { super(); this.phase=0;this.sum=0;this.count=0;this.samples=[]; }
  process(inputs, outputs) {
    const input=inputs[0]?.[0];
    // The output is deliberately silent; the microphone must never feed speakers.
    for(const channel of outputs[0]||[]) channel.fill(0);
    if(input)for(const sample of input){
      this.sum+=sample;this.count++;this.phase+=16000;
      if(this.phase>=sampleRate){this.phase-=sampleRate;this.samples.push(this.sum/this.count);this.sum=0;this.count=0;}
      if(this.samples.length===1600){
        const pcm=new ArrayBuffer(3200),view=new DataView(pcm);let energy=0;
        for(let i=0;i<1600;i++){const s=Math.max(-1,Math.min(1,this.samples[i]));energy+=s*s;view.setInt16(i*2,s<0?s*32768:s*32767,true);}
        this.port.postMessage({pcm,level:Math.sqrt(energy/1600)},[pcm]);this.samples=[];
      }
    }
    return true;
  }
}
registerProcessor('lux-live-capture',LuxLiveCapture);
