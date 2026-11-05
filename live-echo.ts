/** Local hardware test only. Buffers at most eight seconds, never uses a server. */
export class LiveEcho {
  private chunks: Uint8Array[] = [];
  private samples = 0;
  private voiced = 0;
  private quiet = 0;
  private cooldown = 0;
  private reply: (samples: Float32Array) => void;
  constructor(reply: (samples: Float32Array) => void) { this.reply = reply; }
  reset() { this.chunks = []; this.samples = this.voiced = this.quiet = 0; }
  push(pcm: ArrayBuffer, level: number, blocked: boolean) {
    const count = pcm.byteLength / 2;
    if (!Number.isInteger(count) || count <= 0 || count > 16000) return;
    if (blocked) { this.reset(); this.cooldown = 4800; return; }
    if (this.cooldown > 0) { this.cooldown -= count; return; }
    const speech = level >= .015;
    if (!speech && !this.samples) return;
    const accepted = Math.min(count, 128000 - this.samples);
    this.chunks.push(new Uint8Array(pcm, 0, accepted * 2).slice());
    this.samples += accepted;
    if (speech) { this.voiced += accepted; this.quiet = 0; } else this.quiet += accepted;
    if (this.quiet < 14400 && this.samples < 128000) return;
    if (this.voiced >= 4800) {
      const result = new Float32Array(this.samples); let offset = 0;
      for (const chunk of this.chunks) {
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (let i = 0; i < chunk.byteLength; i += 2) result[offset++] = view.getInt16(i, true) / 32768;
      }
      this.reset(); this.reply(result);
    } else this.reset();
  }
}
