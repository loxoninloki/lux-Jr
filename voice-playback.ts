/** A resolved promise means playback ended, never merely that it was queued. */
export function playSpeech(text: string, voiceName: string, signal: AbortSignal, onSpeaking: (value: boolean) => void, diagnostic: (event:string)=>void = ()=>{}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || !('speechSynthesis' in window)) { reject(Error('音声再生を開始できません。')); return; }
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP'; utterance.rate = .9;
    const voice = synth.getVoices().find(v => v.name === voiceName); if (voice) utterance.voice = voice;
    let finished = false; let started = false;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(startTimer); clearTimeout(endTimer); clearInterval(poll);
      signal.removeEventListener('abort', cancel);
      utterance.onstart = utterance.onend = utterance.onerror = null;
      onSpeaking(false);
      if (error) { synth.cancel(); reject(error); } else resolve();
    };
    const cancel = () => { diagnostic('speech:cancelled'); finish(Error('音声再生を終了しました。')); };
    const startTimer = setTimeout(() => { diagnostic('speech:start-timeout'); finish(Error('音声再生には画面の操作が必要です。')); }, 10000);
    const endTimer = setTimeout(() => { diagnostic('speech:end-timeout'); finish(Error('音声再生が中断されました。')); }, Math.min(300000, Math.max(45000, text.length * 500)));
    let quietChecks = 0;
    const markStarted = () => { if (!finished && !started) { started = true; clearTimeout(startTimer); onSpeaking(true); } };
    // Some Safari sessions miss end/start events. Confirm the synthesis queue is
    // actually empty for 900ms before reopening capture; never guess from text length.
    const poll = setInterval(() => {
      if (synth.speaking) { if(!started)diagnostic('speech:state-started'); markStarted(); quietChecks = 0; }
      else if (started && !synth.pending && !synth.paused) {
        if (++quietChecks >= 3) { diagnostic('speech:end-inferred'); finish(); }
      } else quietChecks = 0;
    }, 300);
    utterance.onstart = () => { if(!finished){ diagnostic('speech:start-event'); markStarted(); } };
    utterance.onend = () => { if(!finished){ diagnostic('speech:end-event'); finish(); } };
    utterance.onerror = event => {
      if(finished)return;
      const code=['not-allowed','audio-busy','audio-hardware','network','synthesis-unavailable','synthesis-failed','language-unavailable','voice-unavailable','text-too-long','invalid-argument','canceled','interrupted'].includes(event.error)?event.error:'other';
      diagnostic(`speech:error-${code}`);finish(Error('音声を再生できませんでした。'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      synth.cancel();
      if(synth.paused){diagnostic('speech:queue-paused');synth.resume();}
      diagnostic('speech:queued');synth.speak(utterance);
    } catch { diagnostic('speech:queue-failed');finish(Error('音声を再生できませんでした。')); }
  });
}
