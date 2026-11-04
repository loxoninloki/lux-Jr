/** A resolved promise means playback ended, never merely that it was queued. */
export function playSpeech(text: string, voiceName: string, signal: AbortSignal, onSpeaking: (value: boolean) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || !('speechSynthesis' in window)) { reject(Error('音声再生を開始できません。')); return; }
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP'; utterance.rate = .9;
    const voice = synth.getVoices().find(v => v.name === voiceName); if (voice) utterance.voice = voice;
    let finished = false; let started = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(startTimer); clearTimeout(endTimer);
      signal.removeEventListener('abort', cancel);
      utterance.onstart = utterance.onend = utterance.onerror = null;
      onSpeaking(false);
      if (error) { synth.cancel(); reject(error); } else resolve();
    };
    const cancel = () => finish(Error('音声再生を終了しました。'));
    const startTimer = setTimeout(() => finish(Error('音声再生には画面の操作が必要です。')), 10000);
    const endTimer = setTimeout(() => finish(Error('音声再生が中断されました。')), Math.min(300000, Math.max(45000, text.length * 500)));
    utterance.onstart = () => { started = true; clearTimeout(startTimer); onSpeaking(true); };
    utterance.onend = () => finish(started ? undefined : Error('音声が開始されませんでした。'));
    utterance.onerror = () => finish(Error('音声を再生できませんでした。'));
    signal.addEventListener('abort', cancel, { once: true });
    try { synth.cancel(); synth.speak(utterance); } catch { finish(Error('音声を再生できませんでした。')); }
  });
}
