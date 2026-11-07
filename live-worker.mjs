// Fixed model and trial limits. No API keys, instructions or setup controls reach clients.
export const LIVE_MODEL = 'gemini-3.8-live';
export const LIVE_SECONDS = 120;
export const LIVE_RESERVE_YEN = 100; // App-side conservative reservation, not an invoice.
export function liveSetup(instructions) {
  return { setup: { model: `models/${LIVE_MODEL}`,
    generationConfig: { responseModalities: ['AUDIO'], maxOutputTokens: 1024,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    systemInstruction: { parts: [{ text: instructions }] },
    inputAudioTranscription: {}, outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: false, silenceDurationMs: 900, prefixPaddingMs: 300 }, activityHandling: 'START_OF_ACTIVITY_INTERRUPTS' },
  } };
}
export function validateLiveAudio(raw) {
  if (typeof raw !== 'string' || raw.length > 24000) throw Error('frame');
  const value = JSON.parse(raw), input = value.realtimeInput, audio = input?.audio;
  if (Object.keys(value).length !== 1 || !input || Object.keys(input).length !== 1 || !audio || Object.keys(audio).length !== 2 || audio.mimeType !== 'audio/pcm;rate=16000' || typeof audio.data !== 'string' || audio.data.length > 22000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) throw Error('audio');
  const bytes = atob(audio.data).length;
  if (bytes % 2 || !bytes) throw Error('pcm');
  return { raw: JSON.stringify({ realtimeInput: { audio: { data: audio.data, mimeType: audio.mimeType } } }), bytes };
}
export async function issueLiveTicket(ledger, instructions) {
  const baseUsage = await ledger.usage();
  const now = Date.now(), day = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Tokyo'}).format(new Date(now));
  return ledger.ctx.storage.transaction(async tx => {
    const previous = await tx.get('live-trial');
    const record = previous?.day === day ? previous : { day, count: 0, activeUntil: 0 };
    if (record.activeUntil > now) return { error:'前のライブ接続が終了してから、2分ほど待ってお試しください。', status:429 };
    const savedUsage = await tx.get('usage');
    const usage = savedUsage?.month === baseUsage.month ? savedUsage : baseUsage;
    // A ticket that expired without ever opening a WebSocket cannot incur Live usage.
    // Reclaim only that unused reservation; never reclaim a consumed ticket or a
    // connected session, whose provider usage cannot be established here.
    const pending = await tx.get('live-ticket');
    if (pending && pending.expires < now) {
      if (pending.month === usage.month && pending.reservedYen === LIVE_RESERVE_YEN) {
        usage.reservedYen = Math.max(0, usage.reservedYen - LIVE_RESERVE_YEN);
        usage.unusedLiveTickets = (usage.unusedLiveTickets || 0) + 1;
      }
      await tx.delete('live-ticket');
    }
    if (ledger.env.DISABLE_APP_BUDGET_CAP !== 'true' && usage.reservedYen + LIVE_RESERVE_YEN > Number(ledger.env.MONTHLY_BUDGET_YEN || 1000)) {
      await tx.put('usage', usage);
      return { error:'アプリの月間予算上限です。設定で利用量をご確認ください。', status:429 };
    }
    const ticket = crypto.randomUUID();
    record.count++; record.activeUntil = now + (LIVE_SECONDS + 20) * 1000;
    usage.reservedYen += LIVE_RESERVE_YEN; usage.liveSessions = (usage.liveSessions || 0) + 1;
    // Only one outstanding ticket, consumed before opening the upstream connection.
    await tx.put({ 'live-trial':record, 'live-ticket':{ ticket, expires:now+20000, instructions, month:usage.month, reservedYen:LIVE_RESERVE_YEN }, usage });
    return { ticket, seconds:LIVE_SECONDS, model:LIVE_MODEL, usage };
  });
}
export async function openLiveSocket(ledger, request) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required',{status:426});
  const ticket = new URL(request.url).searchParams.get('ticket');
  const saved = await ledger.ctx.storage.transaction(async tx => {
    const value = await tx.get('live-ticket');
    if (!value || value.ticket !== ticket || value.expires < Date.now()) return null;
    await tx.delete('live-ticket'); return value;
  });
  if (!saved) return new Response('接続券の期限が切れました。開始ボタンを押してください。',{status:401});
  let upstream;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(ledger.env.GEMINI_API_KEY)}`, { headers:{Upgrade:'websocket'},signal:AbortSignal.timeout(15000) });
    upstream = response.webSocket;
    if (!upstream) return new Response('Gemini Liveに接続できません。無料枠またはモデルの利用権限をご確認ください。',{status:503});
    upstream.accept();
  } catch { return new Response('Gemini Liveへの接続に失敗しました。',{status:503}); }
  const pair = new WebSocketPair(), client = pair[0], server = pair[1]; server.accept();
  let closed = false, ready = false, turns = 0, bytes = 0;
  const started = Date.now();
  const close = (message = 'ライブ会話を終了しました。', diagnostic = '') => {
    if (closed) return; closed = true; clearTimeout(limit); clearTimeout(handshake);
    try { server.send(JSON.stringify({luxClosed:message,luxDiagnostic:diagnostic})); server.close(1000,'Live trial ended'); } catch {}
    try { upstream.close(1000,'Live trial ended'); } catch {}
  };
  const limit = setTimeout(()=>close('2分間のライブ試用を終了しました。'), LIVE_SECONDS*1000);
  const handshake = setTimeout(()=>close('Gemini Liveの開始を確認できません。無料枠の利用権限をご確認ください。','live:setup-timeout'), 15000);
  server.addEventListener('message', event => {
    if (closed) return;
    try {
      if (!ready) throw Error('not ready');
      const frame = validateLiveAudio(event.data); bytes += frame.bytes;
      if (bytes > 32000 * (Math.min(LIVE_SECONDS,(Date.now()-started)/1000)+2)) throw Error('rate');
      upstream.send(frame.raw);
    } catch { close('音声の形式または送信量を確認できないため終了しました。'); }
  });
  // Decode asynchronously because Cloudflare can deliver binary WebSocket messages
  // as Blob. Serialize decoding so audio chunks and turn markers remain ordered.
  let upstreamMessages = Promise.resolve();
  async function forwardUpstream(data) {
    if (closed) return;
    let value;
    try {
      let raw;
      if (typeof data === 'string') raw = data;
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
        raw = new TextDecoder().decode(data);
      else if (typeof Blob !== 'undefined' && data instanceof Blob)
        raw = await data.text();
      else if (data && typeof data.arrayBuffer === 'function')
        raw = new TextDecoder().decode(await data.arrayBuffer());
      else { close('Gemini Liveから未対応の形式を受信しました。', 'live:upstream-unsupported-frame'); return; }
      if (closed) return;
      if (raw.length > 8 * 1024 * 1024) {
        close('音声データが大きすぎます。', 'live:upstream-oversized-frame'); return;
      }
      value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid response');
    } catch {
      if (!closed) close('Gemini Liveの応答形式を解析できませんでした。', 'live:upstream-invalid-json');
      return;
    }
    if (value.setupComplete) { ready = true; clearTimeout(handshake); }
    if (value.error) {
      const code = Number(value.error.code);
      const label = [400,401,403,404,429,500,503].includes(code) ? `（${code}）` : '';
      close(`Gemini Liveが接続を拒否しました${label}。無料枠・モデルの利用権限をご確認ください。`,[400,401,403,404,429,500,503].includes(code)?`live:upstream-error-${code}`:'live:upstream-error'); return;
    }
    try { server.send(JSON.stringify(value)); }
    catch { close('音声データの転送に失敗しました。', 'live:client-forward-failed'); return; }
    if (value.serverContent?.turnComplete && ++turns >= 12) close('今回の試用は12往復までです。');
    if (value.goAway) close('Geminiが接続を終了しました。再開には開始ボタンを押してください。');
  }
  upstream.addEventListener('message', event => {
    upstreamMessages = upstreamMessages.then(() => forwardUpstream(event.data)).catch(() => {
      if (!closed) close('音声応答の処理を続けられませんでした。', 'live:upstream-processing-failed');
    });
  });
  server.addEventListener('close',()=>close());server.addEventListener('error',()=>close('端末との接続が切れました。'));
  upstream.addEventListener('close',event=>{
    const code = Number(event.code);
    const label = Number.isInteger(code) && code >= 1000 && code < 5000 ? `（${code}）` : '';
    close(`Gemini Liveの接続が終了しました${label}。${ready ? '利用制限の場合は時間を置いてお試しください。' : '開始設定が受理されていません。モデルの利用権限・無料枠をご確認ください。'}`,label?`live:upstream-close-${code}`:'live:upstream-error');
  });
  upstream.addEventListener('error',()=>close('Gemini Liveと通信できませんでした。'));
  try { upstream.send(JSON.stringify(liveSetup(saved.instructions))); } catch { close('音声会話の設定に失敗しました。'); }
  return new Response(null,{status:101,webSocket:client});
}
