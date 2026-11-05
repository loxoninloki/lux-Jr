/** Signed PCM16 little endian. No audio or transcript is persisted here. */
export function pcmToFloat(data: string): Float32Array {
  const raw = atob(data);
  if (!raw.length || raw.length % 2) throw Error('Invalid PCM');
  const view = new DataView(Uint8Array.from(raw, c => c.charCodeAt(0)).buffer);
  const samples = new Float32Array(raw.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}
export function audioBase64(buffer: ArrayBuffer): string {
  let raw = '';
  for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
  return btoa(raw);
}

/** The audio clock, not network timing, orders chunks. Suspended queues stay bounded. */
export class LiveOutput {
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private context: AudioContext;
  private diagnostic: (event: string) => void;
  private ended: () => void;
  constructor(context: AudioContext, diagnostic: (event: string) => void, ended: () => void) { this.context = context; this.diagnostic = diagnostic; this.ended = ended; }
  get busy() { return this.sources.size > 0; }
  enqueue(samples: Float32Array, rate: number) {
    try {
      if (!samples.length || ![16000, 24000, 48000].includes(rate)) throw Error('Invalid audio');
      const start = Math.max(this.context.currentTime + .04, this.next);
      if (start + samples.length / rate - this.context.currentTime > 30) throw Error('Audio queue full');
      const buffer = this.context.createBuffer(1, samples.length, rate);
      buffer.getChannelData(0).set(samples);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      const first = !this.busy;
      this.sources.add(source);
      this.next = start + buffer.duration;
      source.onended = () => {
        if (!this.sources.delete(source)) return;
        source.onended = null; source.disconnect();
        if (!this.busy) { this.next = 0; this.diagnostic('live:playback-ended'); this.ended(); }
      };
      source.start(start);
      if (first) this.diagnostic('live:playback-scheduled');
    } catch (error) { this.diagnostic('live:playback-failed'); this.clear(); throw error; }
  }
  clear() {
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.sources.clear(); this.next = 0;
  }
}
