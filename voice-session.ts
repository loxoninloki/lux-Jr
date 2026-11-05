export type VoicePhase = 'idle' | 'finishing' | 'starting' | 'listening' | 'recovering' | 'mic-paused' | 'waiting' | 'speaking' | 'paused';
export type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: null | (() => void);
  onresult: null | ((event: any) => void); onend: null | (() => void);
  onerror: null | ((event: { error: string }) => void);
  onaudiostart?: null | (() => void); onaudioend?: null | (() => void);
  onspeechstart?: null | (() => void);
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
  diagnostic?: (event: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
};
/** Each capture is disposable: fully release it before TTS, and verify restart. */
export class VoiceSession {
  phase: VoicePhase = 'idle';
  private epoch = 0;
  private aborter: AbortController | null = null;
  private rec: Recognition | null = null;
  private pending = '';
  private finishCapture: (() => void) | null = null;
  private retries = 0;
  private afterPlayback = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private ports: Ports;
  constructor(ports: Ports) { this.ports = ports; }
  private set(phase: VoicePhase) { this.ports.diagnostic?.(`phase:${phase}`); this.phase = phase; this.ports.phase(phase); }
  private current(epoch: number) { return this.epoch === epoch && !!this.aborter && !this.aborter.signal.aborted; }
  private wait(ms: number) { return this.ports.wait?.(ms) ?? new Promise<void>(resolve => setTimeout(resolve, ms)); }
  private release() {
    clearTimeout(this.watchdog); this.finishCapture = null;
    const rec = this.rec; this.rec = null;
    if (rec) {
      rec.onstart = rec.onend = rec.onresult = rec.onerror = null;
      rec.onaudiostart = rec.onaudioend = rec.onspeechstart = null;
      // stop/end alone may leave Safari's capture session attached across TTS.
      try { rec.abort(); } catch {}
    }
  }
  start() {
    this.stop(); this.retries = 0; this.ports.error(''); this.aborter = new AbortController();
    this.listen(this.epoch);
  }
  stop() {
    ++this.epoch; this.release();
    this.aborter?.abort(); this.aborter = null;
    this.pending = ''; this.afterPlayback = false; this.ports.cancelSpeech(); this.set('idle');
  }
  private fail(text: string) { this.stop(); this.ports.error(text); }
  private pauseMic(text: string) {
    this.release(); this.set('mic-paused'); this.ports.error(text);
  }
  private recover(epoch: number) {
    if (!this.current(epoch)) return;
    this.release();
    if (++this.retries > 2) { this.pauseMic('マイクの自動再開を確認できません。「マイクを再開」を押してください。'); return; }
    this.set('recovering');
    void this.wait(1200 * this.retries).then(() => { if (this.current(epoch)) this.listen(epoch); });
  }
  restartMicrophone() {
    if (!this.aborter || !['starting','listening','recovering','mic-paused'].includes(this.phase)) return;
    this.ports.diagnostic?.('recognition:manual-restart');
    ++this.epoch; this.release(); this.retries = 0; this.ports.error('');
    // A user gesture provides a recovery route where Safari denies automatic start.
    this.listen(this.epoch);
  }
  finishSpeaking() { if (this.phase === 'listening') this.finishCapture?.(); }
  private listen(epoch: number) {
    if (!this.current(epoch)) return;
    let rec: Recognition;
    try { rec = this.ports.createRecognition(); } catch { this.fail('このブラウザでは音声会話を開始できません。Safariの音声入力をご確認ください。'); return; }
    this.rec = rec; rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
    const finals = new Map<number, string>(); let ended = false; let closing = false; let draft = ''; let manualFinish = false;
    const valid = () => this.current(epoch) && this.rec === rec && !ended;
    const submit = () => {
      if (!valid()) return; ended = true;
      const text = (manualFinish ? draft : [...finals.values()].join('')).trim();
      this.release();
      if (!text) { this.recover(epoch); return; }
      if (text.length > 4000) { this.fail('一度のお話が長すぎました。短く区切ってお話しください。'); return; }
      void this.respond(text, epoch);
    };
    const close = (manual = false) => {
      if (!valid() || closing) return; closing = true; manualFinish = manual;
      this.set('finishing'); clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (!valid()) return;
        this.ports.diagnostic?.('recognition:end-timeout');
        // Preserve an already-final result (or explicitly submitted draft) even
        // when Safari omits end. release() aborts capture before the API/TTS.
        submit();
      }, 4000);
      try { rec.stop(); } catch { submit(); }
    };
    this.finishCapture = () => close(true);
    rec.onstart = () => {
      if (!valid() || closing) return;
      this.set('listening'); clearTimeout(this.watchdog);
      // Safari can fire start but never deliver a result/error/end after TTS.
      // Silence cannot be distinguished from that failure; retry capture only, never API.
      this.watchdog = setTimeout(() => {
        if (!valid()) return;
        this.ports.diagnostic?.('recognition:no-results');
        if (this.afterPlayback) this.pauseMic('読み上げ後の認識結果が届きません。「マイクを再開」を一度お試しください。改善しない場合は音声会話を終了してSafariのページを開き直してください。');
        else this.recover(epoch);
      }, this.afterPlayback ? 10000 : 25000);
    };
    rec.onaudiostart = () => { if (valid()) this.ports.diagnostic?.('recognition:audio-start'); };
    rec.onaudioend = () => { if (valid()) this.ports.diagnostic?.('recognition:audio-end'); };
    rec.onspeechstart = () => { if (valid()) this.ports.diagnostic?.('recognition:speech-start'); };
    rec.onresult = event => {
      if (!valid()) return;
      this.ports.diagnostic?.('recognition:result');
      this.afterPlayback = false;
      this.retries = 0; let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finals.set(i, result[0].transcript);
        else interim += result[0].transcript;
      }
      draft = [...finals.values()].join('') + interim; this.ports.transcript(draft);
      if (closing) return;
      clearTimeout(this.watchdog); this.watchdog = setTimeout(() => close(), finals.size ? 1800 : 5000);
    };
    rec.onerror = event => {
      if (!valid()) return;
      const code = ['not-allowed','service-not-allowed','audio-capture','no-speech','network','aborted'].includes(event.error) ? event.error : 'other';
      this.ports.diagnostic?.(`recognition:error-${code}`);
      if ((closing || event.error === 'aborted') && (finals.size || manualFinish && draft.trim())) { submit(); return; }
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.pauseMic('マイクを再開できませんでした。Safariのマイク許可を確認し、「マイクを再開」を押してください。');
      } else if (['no-speech','aborted','network','audio-capture'].includes(event.error)) this.recover(epoch);
      else this.pauseMic('聞き取りが中断されました。「マイクを再開」を押してください。');
    };
    rec.onend = () => { this.ports.diagnostic?.('recognition:end'); submit(); };
    this.set('starting'); this.ports.transcript('');
    this.watchdog = setTimeout(() => { if (valid()) this.recover(epoch); }, 8000);
    try { rec.start(); } catch { this.recover(epoch); }
  }
  private async respond(text: string, epoch: number) {
    this.set('waiting');
    try {
      const reply = await this.ports.request(text, this.aborter!.signal);
      if (!this.current(epoch)) return;
      this.pending = reply; await this.play(epoch);
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
    this.pending = ''; this.afterPlayback = true; this.ports.cancelSpeech(); this.set('recovering');
    await this.wait(1200);
    if (this.current(epoch)) this.listen(epoch);
  }
  resume() {
    if (this.phase !== 'paused' || !this.pending || !this.aborter) return;
    this.ports.error(''); void this.play(this.epoch);
  }
}
