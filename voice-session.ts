export type VoicePhase = 'idle' | 'listening' | 'waiting' | 'speaking' | 'paused';
export type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: null | ((event: any) => void); onend: null | (() => void);
  onerror: null | ((event: { error: string }) => void);
  start(): void; stop(): void; abort(): void;
};
type Ports = {
  createRecognition(): Recognition;
  request(text: string, signal: AbortSignal): Promise<string>;
  speak(text: string, signal: AbortSignal): Promise<void>;
  cancelSpeech(): void;
  phase(value: VoicePhase): void;
  transcript(text: string): void;
  error(text: string): void;
  wait?: () => Promise<void>;
};
/** One session owns microphone, request and playback. Old callbacks cannot revive it. */
export class VoiceSession {
  phase: VoicePhase = 'idle';
  private epoch = 0;
  private aborter: AbortController | null = null;
  private rec: Recognition | null = null;
  private pending = '';
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private ports: Ports;
  constructor(ports: Ports) { this.ports = ports; }
  private set(phase: VoicePhase) { this.phase = phase; this.ports.phase(phase); }
  private current(epoch: number) { return this.epoch === epoch && !!this.aborter && !this.aborter.signal.aborted; }
  start() {
    this.stop(); this.ports.error(''); this.aborter = new AbortController();
    this.listen(this.epoch);
  }
  stop() {
    ++this.epoch; clearTimeout(this.watchdog);
    this.aborter?.abort(); this.aborter = null;
    const rec = this.rec; this.rec = null;
    if (rec) { rec.onend = rec.onresult = rec.onerror = null; try { rec.abort(); } catch {} }
    this.pending = ''; this.ports.cancelSpeech(); this.set('idle');
  }
  private fail(text: string) { this.stop(); this.ports.error(text); }
  private listen(epoch: number) {
    if (!this.current(epoch)) return;
    let rec: Recognition;
    try { rec = this.ports.createRecognition(); } catch { this.fail('このブラウザでは音声会話を開始できません。Safariの音声入力をご確認ください。'); return; }
    this.rec = rec; rec.lang = 'ja-JP'; rec.continuous = false; rec.interimResults = true;
    const finals = new Map<number, string>(); let ended = false; let closing = false;
    const valid = () => this.current(epoch) && this.rec === rec && !ended;
    const close = () => {
      if (!valid() || closing) return; closing = true;
      try { rec.stop(); } catch { this.fail('聞き取りを停止できませんでした。音声会話を再開してください。'); return; }
      // Never send until the recognizer confirms that the microphone has stopped.
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => { if (valid()) this.fail('マイクの停止を確認できません。もう一度開始してください。'); }, 4000);
    };
    rec.onresult = event => {
      if (!valid() || closing) return;
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finals.set(i, result[0].transcript);
        else interim += result[0].transcript;
      }
      this.ports.transcript([...finals.values()].join('') + interim);
      if (finals.size) close();
    };
    rec.onerror = event => {
      if (!valid()) return;
      this.fail(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'マイクが許可されていません。Safariで許可し、音声会話を開始してください。'
        : event.error === 'no-speech' ? '声が聞こえなかったため終了しました。開始ボタンで再開できます。'
        : '音声認識が中断されました。通信とマイクを確認し、開始ボタンで再開してください。');
    };
    rec.onend = () => {
      if (!valid()) return; ended = true; clearTimeout(this.watchdog); this.rec = null;
      const text = [...finals.values()].join('').trim();
      if (!text) { this.fail('聞き取りが終了しました。開始ボタンで再開できます。'); return; }
      if (text.length > 4000) { this.fail('一度のお話が長すぎました。短く区切ってお話しください。'); return; }
      void this.respond(text, epoch);
    };
    this.set('listening'); this.ports.transcript('');
    this.watchdog = setTimeout(close, 60000);
    try { rec.start(); } catch { this.fail('マイクを開始できませんでした。ほかの音声入力を停止して再開してください。'); }
  }
  private async respond(text: string, epoch: number) {
    this.set('waiting');
    try {
      const reply = await this.ports.request(text, this.aborter!.signal);
      if (!this.current(epoch)) return;
      this.pending = reply;
      await this.play(epoch);
    } catch (error) {
      if (this.current(epoch)) this.fail(error instanceof Error ? error.message : '通信できませんでした。音声会話を終了しました。');
    }
  }
  private async play(epoch: number) {
    if (!this.current(epoch)) return;
    this.set('speaking');
    try { await this.ports.speak(this.pending, this.aborter!.signal); }
    catch {
      if (this.current(epoch)) { this.set('paused'); this.ports.error('音声を再生できませんでした。「返答を再生して続ける」を押してください。'); }
      return;
    }
    if (!this.current(epoch)) return;
    this.pending = '';
    await (this.ports.wait?.() ?? new Promise(resolve => setTimeout(resolve, 650)));
    if (this.current(epoch)) this.listen(epoch);
  }
  resume() {
    if (this.phase !== 'paused' || !this.pending || !this.aborter) return;
    this.ports.error(''); void this.play(this.epoch);
  }
}
