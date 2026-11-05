import { deadline, startMicCapture } from './mic-capture.ts';
import { LiveOutput, pcmToFloat, audioBase64 } from './live-output.ts';
import { LiveEcho } from './live-echo.ts';
import type { VoicePhase } from './voice-session.ts';
export { pcmToFloat, audioBase64 } from './live-output.ts';
export type LiveHealth = {
  stage: string; inputLevel: number; sentFrames: number; receivedChunks: number; needsResume: boolean;
  muted?: boolean; localTest?: boolean; completedTurns?: number;
};
type LivePorts = {
  phase(value: VoicePhase): void; error(text: string): void; diagnostic(event: string): void;
  transcript(user: string, assistant: string): void; preview(text: string): void;
  ticket(signal: AbortSignal): Promise<{ticket: string; seconds: number; endpoint: string}>;
  health?(value: LiveHealth): void;
};
const idleHealth = (): LiveHealth => ({stage: '停止中', inputLevel: 0, sentFrames: 0, receivedChunks: 0, needsResume: false, muted: false, localTest: false, completedTurns: 0});

/** One capture and audio context per conversation; no SpeechRecognition/SpeechSynthesis. */
export class LiveConversation {
  private generation = 0;
  private aborter: AbortController | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: {stop(): void} | null = null;
  private socket: WebSocket | null = null;
  private output: LiveOutput | null = null;
  private echo: LiveEcho | null = null;
  private ready = false;
  private userText = '';
  private assistantText = '';
  private turnChunks = 0;
  private health = idleHealth();
  private restoreAudioSession: (() => void) | null = null;
  private rejectCapture: ((reason: Error) => void) | null = null;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private limit: ReturnType<typeof setTimeout> | undefined;
  private ports: LivePorts;
  constructor(ports: LivePorts) { this.ports = ports; }
  private report(stage = this.health.stage) {
    this.health = {...this.health, stage}; this.ports.health?.({...this.health});
  }
  private active(generation: number) { return this.generation === generation && !!this.aborter && !this.aborter.signal.aborted; }
  private flush() {
    if (this.userText.trim() || this.assistantText.trim()) this.ports.transcript(this.userText.trim(), this.assistantText.trim());
    this.userText = ''; this.assistantText = '';
  }
  stop(message = '') {
    const wasReady = this.ready;
    if (message) this.ports.diagnostic(wasReady ? 'live:ended-after-ready' : 'live:ended-before-ready');
    ++this.generation; this.ready = false;
    clearTimeout(this.handshake); clearTimeout(this.limit); clearInterval(this.monitor);
    this.aborter?.abort(); this.aborter = null;
    this.rejectCapture?.(Error('音声準備を中止しました。')); this.rejectCapture = null;
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
      try { this.socket.close(1000, 'User ended'); } catch {}
      this.socket = null;
    }
    this.capture?.stop(); this.capture = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.output?.clear(); this.output = null;
    this.echo?.reset(); this.echo = null;
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => {}); this.context = null; }
    this.restoreAudioSession?.(); this.restoreAudioSession = null;
    this.flush(); this.turnChunks = 0;
    this.health = {...this.health, inputLevel: 0, needsResume: false, muted: false};
    this.report(message || '停止中'); this.ports.phase('idle'); this.ports.diagnostic('live:stopped');
    if (message) this.ports.error(message);
  }
  setMuted(muted: boolean) {
    if (!this.aborter) return;
    this.health.muted = muted;
    if (muted) this.health.inputLevel = 0;
    this.stream?.getAudioTracks?.().forEach(track => { track.enabled = !muted; });
    this.echo?.reset();
    this.ports.diagnostic(muted ? 'live:microphone-muted' : 'live:microphone-unmuted');
    this.report(muted ? 'マイクはミュート中です。解除すると同じ接続で続けられます。' : 'マイクのミュートを解除しました。');
  }
  async resumeAudio() {
    const context = this.context, generation = this.generation;
    if (!context) return;
    this.ports.diagnostic('live:audio-resume-request');
    try {
      await context.resume(); if (!this.active(generation)) return;
      this.audioState();
      this.ports.diagnostic(this.health.needsResume ? 'live:audio-resume-blocked' : 'live:audio-resumed');
    } catch {
      if (!this.active(generation)) return;
      this.health.needsResume = true; this.ports.diagnostic('live:audio-resume-failed');
      this.report('音声を再開できません。終了して開始し直してください。');
    }
  }
  private audioState() {
    if (!this.context) return;
    this.health.needsResume = this.context.state !== 'running';
    this.ports.diagnostic(`live:audio-${this.context.state}`);
    if (this.output?.busy) this.ports.phase(this.health.needsResume ? 'paused' : 'speaking');
    this.report(this.health.needsResume ? '音声が一時停止中です。「音声を有効にする」を押してください。' : this.ready ? this.health.localTest ? '端末テスト中です。一言話し、少し間を空けてください。' : '接続済み。お話しください。返答中も話しかけられます。' : 'マイクの音声を確認しています。');
  }
  private play(samples: Float32Array, rate: number) {
    if (!this.context || !this.output) return;
    this.health.needsResume = this.context.state !== 'running';
    if (this.health.needsResume) this.ports.diagnostic('live:playback-blocked');
    this.output.enqueue(samples, rate);
    this.ports.phase(this.health.needsResume ? 'paused' : 'speaking');
    this.report(this.health.needsResume ? '音声が届きました。「音声を有効にする」を押してください。' : this.health.localTest ? '今話した声を再生しています。聞き終わったら次の一言をどうぞ。' : 'ルクスがお話し中です。話しかけると割り込めます。');
  }
  async start(options: {localTest?: boolean} = {}) {
    this.stop(); this.ports.error(''); this.ports.preview('');
    const generation = ++this.generation;
    this.aborter = new AbortController(); const signal = this.aborter.signal;
    this.health = {...idleHealth(), localTest: !!options.localTest};
    this.ports.phase('starting'); this.ports.diagnostic('live:connecting');
    if (options.localTest) this.ports.diagnostic('live:local-test');
    this.report('マイクの許可を確認しています。');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw Error('このブラウザではライブ音声を開始できません。Safariでお試しください。');
      const session = (navigator as Navigator & {audioSession?: {type: string}}).audioSession;
      if (session) {
        const previous = session.type;
        try { session.type = 'play-and-record'; this.restoreAudioSession = () => { try { session.type = previous; } catch {} }; } catch {}
      }
      // Keep resume in the start-button call stack, before permission/network awaits.
      const context = new AudioContext(); this.context = context;
      this.output = new LiveOutput(context, event => this.ports.diagnostic(event), () => {
        if (!this.active(generation) || !this.ready) return;
        if (this.health.localTest) this.health.completedTurns = (this.health.completedTurns || 0) + 1;
        this.ports.phase('listening');
        this.report(this.health.localTest ? `声の往復を${this.health.completedTurns}回確認しました。次の一言をどうぞ。` : '返答音声の再生が終了しました。お話しください。');
      });
      this.ports.diagnostic('live:audio-created'); void context.resume().catch(() => {});
      this.ports.diagnostic('live:microphone-request');
      const permission = navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: false});
      void permission.then(stream => { if (!this.active(generation)) stream.getTracks().forEach(track => track.stop()); }, () => {});
      const stream = await deadline(permission, 20000, 'マイクの許可を確認できません。Safariのサイト設定をご確認ください。');
      if (!this.active(generation)) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks?.().forEach(track => { track.enabled = !this.health.muted; });
      this.ports.diagnostic('live:microphone-granted');
      this.report('マイクの音声処理を読み込んでいます。');
      let captured = false, lastFrame = Date.now(), lastReport = 0;
      let frame: (pcm: ArrayBuffer, level: number) => void = () => {};
      const firstFrame = new Promise<void>((resolve, reject) => {
        this.rejectCapture = reject;
        frame = (pcm, level) => {
          if (!this.active(generation)) return;
          lastFrame = Date.now(); this.health.inputLevel = this.health.muted ? 0 : Math.max(0, Math.min(1, level || 0));
          if (!captured) { captured = true; this.rejectCapture = null; this.ports.diagnostic('live:microphone-frames'); resolve(); }
          if (this.ready && context.state === 'running') {
            if (this.echo) this.echo.push(pcm, this.health.inputLevel, !!this.health.muted || !!this.output?.busy);
            else this.sendAudio(this.health.muted ? new ArrayBuffer(pcm.byteLength) : pcm);
          }
          if (Date.now() - lastReport > 500) { lastReport = Date.now(); this.report(); }
        };
      });
      void firstFrame.catch(() => {});
      const capture = await startMicCapture(context, stream, (pcm, level) => {
        try { frame(pcm, level); } catch { if (this.active(generation)) this.stop('音声の処理を続けられませんでした。'); }
      }, event => this.ports.diagnostic(event), signal);
      if (!this.active(generation)) { capture.stop(); return; }
      this.capture = capture;
      context.onstatechange = () => { if (this.active(generation)) this.audioState(); };
      void context.resume().catch(() => {}); this.audioState();
      this.monitor = setInterval(() => {
        if (!this.active(generation)) return;
        if (context.state !== 'running') { if (!this.health.needsResume) this.audioState(); return; }
        if (Date.now() - lastFrame > 10000) { this.ports.diagnostic('live:microphone-no-frames'); this.stop('マイクから音声データが届いていません。Safariのマイク許可をご確認ください。'); }
      }, 1000);
      await deadline(firstFrame, 30000, 'マイクの準備が完了しません。「音声を有効にする」を試してから開始し直してください。');
      if (!this.active(generation)) return;
      if (options.localTest) {
        this.echo = new LiveEcho(samples => {
          if (!this.active(generation)) return;
          this.ports.diagnostic('live:local-voice-captured'); this.play(samples, 16000);
        });
        this.ready = true; this.ports.phase('listening');
        this.report('端末テストです。一言話し、1秒ほど間を空けてください。同じ声が返ります。');
        this.limit = setTimeout(() => { if (this.active(generation)) this.stop('2分間の端末テストを終了しました。'); }, 120000);
        return;
      }
      this.report('マイク確認済み。LUXサーバーに接続しています。'); this.ports.diagnostic('live:ticket-request');
      const ticket = await deadline(this.ports.ticket(signal), 15000, '音声会話の接続準備がタイムアウトしました。');
      if (!this.active(generation)) return;
      this.connect(ticket, generation);
    } catch (error) {
      if (!this.active(generation)) return;
      const name = error instanceof Error ? error.name : '';
      this.ports.diagnostic(name === 'NotAllowedError' ? 'live:microphone-denied' : ['NotFoundError', 'NotReadableError'].includes(name) ? 'live:microphone-unavailable' : 'live:start-failed');
      this.stop(name === 'NotAllowedError' ? 'マイクの許可が必要です。Safariのサイト設定をご確認ください。' : error instanceof Error ? error.message : '音声会話を開始できませんでした。');
    }
  }
  private connect(ticket: {ticket: string; seconds: number; endpoint: string}, generation: number) {
    if (!ticket.ticket || !Number.isFinite(ticket.seconds) || ticket.seconds <= 0) throw Error('サーバーの音声会話設定を確認できません。');
    const url = new URL(ticket.endpoint);
    if (url.protocol !== 'https:') throw Error('音声会話にはHTTPSのサーバーが必要です。');
    url.protocol = 'wss:'; url.pathname = '/live'; url.search = ''; url.hash = ''; url.searchParams.set('ticket', ticket.ticket);
    const socket = new WebSocket(url); this.socket = socket; socket.binaryType = 'arraybuffer';
    this.report('音声会話の接続完了を待っています。'); this.ports.diagnostic('live:ticket-issued'); this.ports.diagnostic('live:websocket-connecting');
    this.handshake = setTimeout(() => { if (this.active(generation)) { this.ports.diagnostic('live:setup-timeout'); this.stop('接続設定が受理されませんでした。サーバーとモデルの利用権限をご確認ください。'); } }, 20000);
    this.limit = setTimeout(() => { if (this.active(generation)) this.stop('2分間のライブ試用を終了しました。'); }, Math.min(ticket.seconds, 120) * 1000);
    socket.onopen = () => { if (this.active(generation)) this.ports.diagnostic('live:websocket-open'); };
    // Blob decoding is asynchronous: serialize messages so audio/interruption order is retained.
    let messages = Promise.resolve(); let queued = 0;
    socket.onmessage = event => {
      if (!this.active(generation)) return;
      if (!queued && (typeof event.data === 'string' || event.data instanceof ArrayBuffer)) {
        // The usual path is synchronous, preserving ordering with the audio callbacks.
        try { this.message(JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))); }
        catch { this.messageFailure(generation); }
      } else {
        queued++;
        messages = messages.then(async () => {
          const raw = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : await event.data.text();
          if (this.active(generation)) this.message(JSON.parse(raw));
        }).catch(() => this.messageFailure(generation)).finally(() => { queued--; });
      }
    };
    socket.onerror = () => { if (this.active(generation)) { this.ports.diagnostic('live:websocket-error'); this.stop('音声会話に接続できません。通信とサーバーをご確認ください。'); } };
    socket.onclose = event => { if (this.active(generation)) { this.ports.diagnostic(`live:socket-close-${event.code}`); this.stop(`音声会話の接続が終了しました（${event.code}）。`); } };
  }
  private messageFailure(generation: number) {
    if (!this.active(generation)) return;
    this.ports.diagnostic('live:message-processing-failed'); this.stop('音声応答の処理に失敗しました。');
  }
  private sendAudio(pcm: ArrayBuffer) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 128000) { this.stop('通信が追いつかないため音声会話を終了しました。'); return; }
    try {
      socket.send(JSON.stringify({realtimeInput: {audio: {mimeType: 'audio/pcm;rate=16000', data: audioBase64(pcm)}}}));
      if (++this.health.sentFrames === 1) this.ports.diagnostic('live:audio-sent');
    } catch { this.stop('マイク音声を送信できませんでした。'); }
  }
  private message(value: any) {
    if (value.luxClosed) {
      if (/^live:(upstream-close-[0-9]{4}|upstream-error-(400|401|403|404|429|500|503)|upstream-(error|model-rejected|config-rejected|quota|access-denied)|setup-timeout)$/.test(value.luxDiagnostic)) this.ports.diagnostic(value.luxDiagnostic);
      this.stop(String(value.luxClosed)); return;
    }
    if (value.setupComplete) {
      this.ready = true; clearTimeout(this.handshake);
      this.ports.phase('listening'); this.ports.diagnostic('live:ready');
      this.report('接続済み。お話しください。返答中も話しかけられます。');
    }
    const content = value.serverContent; if (!content) return;
    if (content.interrupted) {
      this.output?.clear(); this.flush(); this.turnChunks = 0;
      this.ports.phase('listening'); this.ports.diagnostic('live:interrupted');
    }
    if (content.inputTranscription?.text) { this.userText = (this.userText + content.inputTranscription.text).slice(0, 4000); this.ports.preview(this.userText); }
    if (content.outputTranscription?.text) this.assistantText = (this.assistantText + content.outputTranscription.text).slice(0, 4000);
    for (const part of content.modelTurn?.parts || []) {
      const audio = part.inlineData;
      if (audio?.data && audio.mimeType?.startsWith('audio/pcm')) {
        this.health.receivedChunks++;
        if (!this.turnChunks++) this.ports.diagnostic('live:audio-received');
        let samples: Float32Array;
        try { samples = pcmToFloat(audio.data); }
        catch (error) { this.ports.diagnostic('live:playback-failed'); throw error; }
        this.play(samples, Number(/rate=(\d+)/.exec(audio.mimeType)?.[1] || 24000));
      }
    }
    if (content.turnComplete) {
      if (!this.turnChunks && !content.interrupted) this.ports.diagnostic('live:turn-without-audio');
      this.turnChunks = 0; this.flush(); this.health.completedTurns = (this.health.completedTurns || 0) + 1;
      if (!this.output?.busy) this.ports.phase('listening');
      this.ports.diagnostic('live:turn-complete'); this.report();
    }
  }
}
