import { simulateVoiceReply, voiceTestSpeaker } from './voice-simulation.ts';
import type { VoiceTestDelay } from './voice-simulation.ts';
import { loadVoiceDiagnostics, appendVoiceDiagnostic, clearVoiceDiagnostics } from './voice-diagnostics.ts';
import { Dictation } from './dictation.ts';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { remainingConversations } from './usage.ts';
import { VoiceSession, type VoicePhase } from './voice-session.ts';
import { playSpeech } from './voice-playback.ts';
import { readAccessCode, saveAccessCode } from './access-code.ts';
import { LiveConversation, type LiveHealth } from './live-audio.ts';

type Message = { id: string; role: 'user' | 'assistant'; text: string; at: number };
type Memory = { id: string; text: string; at: number };
type Reminder = { id: string; title: string; due: number; repeat: 'none' | 'daily' | 'weekly'; done: boolean };
type Settings = { endpoint: string; voice: boolean; voiceName: string; model: string; voiceEngine: 'live' | 'classic'; freeLive: boolean };
type Usage = { month: string; requests: number; inputTokens: number; outputTokens: number; estimatedYen: number; reservedYen: number; budgetYen: number; liveSessions?: number; appBudgetEnabled?: boolean };
type Data = { messages: Message[]; memories: Memory[]; reminders: Reminder[]; notices: string[]; settings: Settings };
const KEY = 'lux-next:data:v1';
const fresh = (): Data => ({ messages: [], memories: [], reminders: [], notices: [], settings: { endpoint: '', voice: false, voiceName: '', model: 'gemini-3.5-flash-lite', voiceEngine: 'live', freeLive: false } });
function load(): Data {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (!s) return fresh();
    if (!Array.isArray(s.messages) || !Array.isArray(s.memories) || !Array.isArray(s.reminders)) throw Error();
    return { ...fresh(), ...s, settings: { ...fresh().settings, ...s.settings } };
  } catch { return fresh(); }
}
const uuid = () => crypto.randomUUID();
const initial = load();
const initialAccess = readAccessCode();
const dateLabel = (at: number) => new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const yen = (v: number) => `¥${v.toFixed(2)}`;
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    chat: <><path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z"/><path d="M8 10h8M8 14h5"/></>,
    memory: <><path d="M9 3H5v18h14V3h-4M9 3v5l3-2 3 2V3H9Z"/><path d="M8 12h8M8 16h5"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    settings: <><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>,
    send: <><path d="m4 12 16-8-6 17-3-7-7-2Z"/><path d="m11 14 9-10"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    arrow: <path d="m8 5 7 7-7 7"/>,
    stop: <rect x="5" y="5" width="14" height="14" rx="3"/>,
    spark: <><path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z"/></>,
    sound: <><path d="m4 9 5 0 5-5v16l-5-5H4Z"/><path d="M18 8q5 4 0 8"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.spark}</svg>;
}

function App() {
  const [data, setData] = useState<Data>(initial);
  const [page, setPage] = useState('chat');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [token, setToken] = useState(initialAccess.token);
  const [rememberCode, setRememberCode] = useState(initialAccess.remember);
  const [localVoiceTest, setLocalVoiceTest] = useState(false);
  const [localLiveTest,setLocalLiveTest] = useState(false);
  const [voiceButtonPlayback,setVoiceButtonPlayback] = useState(false);
  const [voiceButtonMicrophone,setVoiceButtonMicrophone] = useState(false);
  const [voiceTestDelay,setVoiceTestDelay] = useState<VoiceTestDelay>(3000);
  const [voiceTestLong,setVoiceTestLong] = useState(false);
  const [voiceTestRecognitionOnly,setVoiceTestRecognitionOnly] = useState(false);
  const [voiceEvents, setVoiceEvents] = useState<string[]>(loadVoiceDiagnostics);
  const [connected, setConnected] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [memoryInput, setMemoryInput] = useState('');
  const [query, setQuery] = useState('');
  const [editingMemory, setEditingMemory] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [liveHealth, setLiveHealth] = useState<LiveHealth>({stage:'',inputLevel:0,sentFrames:0,receivedChunks:0,needsResume:false});
  const voiceActive = voicePhase !== 'idle';
  const liveMode = !localVoiceTest && (localLiveTest || data.settings.voiceEngine === 'live');
  const voiceSession = useRef<VoiceSession | null>(null);
  const liveSession = useRef<LiveConversation | null>(null);
  const manualPlayback = useRef<AbortController | null>(null);
  const requestBusy = useRef(false);
  const [now, setNow] = useState(Date.now());
  const [timerMinutes, setTimerMinutes] = useState('10');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [repeat, setRepeat] = useState<Reminder['repeat']>('none');
  const [editingReminder, setEditingReminder] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const historyViewport = useRef<HTMLElement>(null);
  const followHistory = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const recognition = useRef<any>(null);
  const dictation = useRef<Dictation|null>(null);
  const [dictationPhase,setDictationPhase]=useState<'idle'|'starting'|'listening'|'finishing'>('idle');
  const dataRef = useRef(data);
  dataRef.current = data;
  const settings = data.settings;
  const remaining = usage ? remainingConversations({ requests: usage.requests, reservedYen: Math.max(0, usage.reservedYen - (usage.liveSessions || 0) * 100), budgetYen: Math.max(0, usage.budgetYen - (usage.liveSessions || 0) * 100) }) : null;
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 4500); };
  const patchSettings = (patch: Partial<Settings>) => { stopAllVoice(); setLocalLiveTest(false); setLocalVoiceTest(false); setData(d => ({ ...d, settings: { ...d.settings, ...patch } })); setConnected(false); };
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch { setError('端末への保存ができません。容量やSafariの設定をご確認ください。'); }
  }, [data]);
  useEffect(() => {
    const viewport = historyViewport.current;
    if (page === 'chat' && viewport && followHistory.current) viewport.scrollTop = viewport.scrollHeight;
  }, [data.messages, busy, page]);
  useEffect(() => {
    if (!saveAccessCode(rememberCode, token)) setError('アクセスコードを端末に保存できません。Safariの保存設定をご確認ください。');
  }, [rememberCode, token]);
  useEffect(() => { if (initialAccess.remember && initialAccess.token && initial.settings.endpoint) void connect(); }, []);
  useEffect(() => {
    const hidden = () => { if (document.hidden) { stopAllVoice(); manualPlayback.current?.abort(); recognition.current?.abort(); setListening(false); } };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); stopAllVoice(); manualPlayback.current?.abort(); controller.current?.abort(); };
  }, []);
  useEffect(() => { if (page !== 'chat') stopAllVoice(); }, [page]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const refresh = () => setVoices(speechSynthesis.getVoices().filter(v => v.lang.startsWith('ja')));
    refresh(); speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => { speechSynthesis.removeEventListener('voiceschanged', refresh); speechSynthesis.cancel(); recognition.current?.stop(); };
  }, []);
  useEffect(() => {
    const interval = window.setInterval(() => {
      const time = Date.now(); setNow(time);
      const ready = dataRef.current.reminders.filter(r => !r.done && r.due <= time);
      if (!ready.length) return;
      const ids = new Set(ready.map(r => r.id));
      setData(d => ({ ...d, reminders: d.reminders.map(r => {
        if (!ids.has(r.id)) return r;
        if (r.repeat === 'none') return { ...r, done: true };
        let next = new Date(r.due);
        do { next.setDate(next.getDate() + (r.repeat === 'daily' ? 1 : 7)); } while (+next <= time);
        return { ...r, due: +next };
      }), notices: [...ready.map(r => `${new Date(time).toLocaleString('ja-JP')}｜${r.title}`), ...d.notices].slice(0, 50) }));
      notify(`お時間です、ろき様。${ready.map(r => r.title).join('、')}`);
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  const sendLatest = useRef<(text: string, signal: AbortSignal) => Promise<string>>(async () => '');
  sendLatest.current = (text, signal) => send(text, signal);
  const voiceNameRef = useRef(settings.voiceName); voiceNameRef.current = settings.voiceName;
  function stopAllVoice() { dictation.current?.cancel(); voiceSession.current?.stop(); liveSession.current?.stop(); }
  async function startLive(testOnly = false) {
    if (busy || requestBusy.current) return;
    if (!testOnly && (!settings.endpoint || !token)) { setError('設定でサーバーURLとアクセスコードを入力してください。'); return; }
    if (!testOnly && !settings.freeLive) { setError('Liveは無料プランで試します。設定で「Geminiの無料プランを確認済み」をオンにしてください。'); setPage('settings'); return; }
    setLocalVoiceTest(false);setLocalLiveTest(testOnly);stopAllVoice(); recognition.current?.abort(); recognition.current = null; stopPlayback();setPage('chat');setLiveTranscript('');
    const live = new LiveConversation({
      phase: phase => { setVoicePhase(phase); setListening(phase === 'listening'); setSpeaking(phase === 'speaking'); },
      error: setError,
      health: setLiveHealth,
      diagnostic: event => setVoiceEvents(events => appendVoiceDiagnostic(events,event)),
      preview: setLiveTranscript,
      transcript: (user, assistant) => {
        const messages: Message[] = [];
        if (user) messages.push({id:uuid(),role:'user',text:user,at:Date.now()});
        if (assistant) messages.push({id:uuid(),role:'assistant',text:assistant,at:Date.now()});
        const next = {...dataRef.current,messages:[...dataRef.current.messages,...messages]};
        dataRef.current=next;setData(next);followHistory.current=true;
      },
      ticket: async signal => {
        const messages = [...dataRef.current.messages.slice(-3).map(({role,text})=>({role,text})),{role:'user',text:'音声会話に切り替えます。次の発話をお待ちください。'}];
        const response = await fetch(endpointUrl('live-ticket'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({messages,memories:dataRef.current.memories.map(m=>m.text),freeTierConfirmed:true}),signal});
        const result = await response.json();setVoiceEvents(events=>appendVoiceDiagnostic(events,`live:ticket-http-${response.status}`));if(!response.ok)throw Error(result.error||'Liveの接続準備ができませんでした。');
        if(typeof result.ticket!=='string'||!(result.seconds === null || result.seconds === 120))throw Error('サーバーのLive設定を確認できません。');
        setUsage(result.usage);setConnected(true);return {...result,endpoint:settings.endpoint};
      },
    });
    liveSession.current=live;await live.start({localTest:testOnly});
  }
  function stopPlayback() {
    manualPlayback.current?.abort(); manualPlayback.current = null;
    window.speechSynthesis?.cancel(); setSpeaking(false);
  }
  function speak(text: string) {
    stopAllVoice(); recognition.current?.abort(); setListening(false); stopPlayback();
    const playback = new AbortController(); manualPlayback.current = playback;
    void playSpeech(text, settings.voiceName, playback.signal, setSpeaking, event => setVoiceEvents(events => appendVoiceDiagnostic(events,event))).catch(() => {
      if (!playback.signal.aborted) notify('音声を再生できませんでした。端末の音声設定をご確認ください。');
    });
  }
  function copyVoiceLog() {
    if (!voiceEvents.length) { notify('コピーする動作ログはまだありません。'); return; }
    // Call writeText directly from the tap gesture for iOS Safari.
    if (!navigator.clipboard?.writeText) { notify('コピーできません。Safariで開いてお試しください。'); return; }
    void navigator.clipboard.writeText(voiceEvents.join('\n'))
      .then(() => notify(`動作ログ${voiceEvents.length}件をコピーしました。`))
      .catch(() => notify('コピーできませんでした。ブラウザのコピー権限をご確認ください。'));
  }
  function startVoice(testOnly = false) {
    if (!testOnly && settings.voiceEngine === 'live') { void startLive(); return; }
    if (busy || requestBusy.current) return;
    if (!testOnly && (!settings.endpoint || !token)) { setError('「設定」でサーバーURLと専用アクセスコードを入力してください。'); return; }
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition || !('speechSynthesis' in window)) { setError('このブラウザでは音声会話を利用できません。iPhoneのSafariでお試しください。'); return; }
    recognition.current?.abort(); recognition.current = null; stopPlayback();
    stopAllVoice();
    setLocalVoiceTest(testOnly);setLocalLiveTest(false);setPage('chat');
    voiceSession.current = new VoiceSession({
      preferPlaybackGesture: testOnly && voiceTestRecognitionOnly ? false : voiceButtonPlayback,
      preferMicrophoneGesture: testOnly && voiceTestRecognitionOnly ? false : voiceButtonMicrophone,
      playbackGestureRequired: () => setVoiceButtonPlayback(true),
      createRecognition: () => new Recognition(),
      request: (text, signal) => {
        if(testOnly){
          // Match the normal request's busy state without transport, ledger or history writes.
          const testRequest=new AbortController();controller.current=testRequest;
          const abort=()=>testRequest.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
          setBusy(true);requestBusy.current=true;
          return simulateVoiceReply(voiceTestDelay,voiceTestLong,testRequest.signal,event=>setVoiceEvents(events=>appendVoiceDiagnostic(events,event))).finally(()=>{
            signal.removeEventListener('abort',abort);
            if(controller.current===testRequest){controller.current=null;setBusy(false);requestBusy.current=false;}
          });
        }
        return sendLatest.current(text, signal);
      },
      speak: voiceTestSpeaker(testOnly && voiceTestRecognitionOnly, (text, signal) => playSpeech(text, voiceNameRef.current, signal, setSpeaking, event => setVoiceEvents(events => appendVoiceDiagnostic(events,event))), event => setVoiceEvents(events => appendVoiceDiagnostic(events,event))),
      cancelSpeech: stopPlayback,
      phase: phase => { setVoicePhase(phase); setListening(phase === 'listening'); },
      transcript: setLiveTranscript,
      diagnostic: event => setVoiceEvents(events => appendVoiceDiagnostic(events,event)),
      error: setError,
    });
    voiceSession.current.start();
  }
  function mic() {
    if (voiceActive || busy) return;
    if (dictationPhase !== 'idle') { dictation.current?.finish(); return; }
    stopAllVoice(); stopPlayback();
    const base=input;
    const session=new Dictation({
      create:()=>{const Constructor=(window as any).SpeechRecognition||(window as any).webkitSpeechRecognition;if(!Constructor)throw Error('unsupported');return new Constructor();},
      phase:value=>{setDictationPhase(value);setListening(value==='listening');},
      text:value=>setInput(base+value),error:setError,
      diagnostic:event=>setVoiceEvents(events=>appendVoiceDiagnostic(events,event)),
    });
    dictation.current=session;session.start();
  }
  function endpointUrl(path: string) {
    const url = new URL(settings.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('接続先にはHTTPSのWorker URLを入力してください。');
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/${path}`;
  }
  async function connect() {
    setError(''); setBusy(true); setConnected(false);
    try {
      const response = await fetch(endpointUrl('status'), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      const result = await response.json(); if (!response.ok) throw Error(result.error || '接続を確認できません。');
      setUsage(result.usage); setConnected(true); notify('LUXのサーバーに接続しました。');
    } catch (e) { setError(e instanceof Error && e.name === 'TimeoutError' ? '接続確認がタイムアウトしました。' : e instanceof Error ? e.message : '接続できません。'); }
    finally { setBusy(false); }
  }
  async function send(text = input, voiceSignal?: AbortSignal): Promise<string> {
    text = text.trim();
    if (!text || requestBusy.current || busy) { if (voiceSignal) throw Error('前の応答を待ってから再開してください。'); return ''; }
    if (!voiceSignal && (voiceActive || dictationPhase !== 'idle')) return '';
    if (!voiceSignal) dictation.current?.cancel();
    setError('');
    if (!settings.endpoint || !token) {
      const message = 'AIはまだ接続されていません。「設定」でサーバーURLとアクセスコードを設定してください。';
      if (voiceSignal) throw Error(message); setError(message); return '';
    }
    if (voiceSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    followHistory.current = true;
    const user: Message = { id: uuid(), role: 'user', text, at: Date.now() };
    const history = [...dataRef.current.messages, user].slice(-16);
    const nextData = { ...dataRef.current, messages: [...dataRef.current.messages, user] };
    dataRef.current = nextData; setData(nextData);
    if (!voiceSignal) setInput(''); setBusy(true); requestBusy.current = true;
    const request = new AbortController(); controller.current = request;
    const cancel = () => request.abort(); voiceSignal?.addEventListener('abort', cancel, { once: true });
    const timeout = window.setTimeout(cancel, 75000);
    try {
      const response = await fetch(endpointUrl('chat'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: request.signal,
        body: JSON.stringify({ messages: history.map(({ role, text }) => ({ role, text })), memories: dataRef.current.memories.map(m => m.text), model: settings.model, voiceMode: !!voiceSignal }),
      });
      const result = await response.json();
      if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!response.ok) throw Error(result.error || (response.status === 429 ? '利用上限です。時間を置いてお試しください。' : '応答を取得できませんでした。'));
      if (typeof result.text !== 'string' || !result.text.trim()) throw Error('回答が空でした。もう一度お試しください。');
      const reply: Message = { id: uuid(), role: 'assistant', text: result.text, at: Date.now() };
      const withReply = { ...dataRef.current, messages: [...dataRef.current.messages, reply] };
      dataRef.current = withReply; setData(withReply);
      setUsage(result.usage); setConnected(true);
      if (!voiceSignal && settings.voice) speak(result.text);
      return result.text;
    } catch (e) {
      const message = e instanceof Error && e.name === 'AbortError' ? '応答待ちを終了しました。履歴には入力内容が残っています。' : e instanceof Error ? e.message : '通信できませんでした。';
      if (!voiceSignal?.aborted) { setError(message); setConnected(false); }
      if (voiceSignal) throw Error(message);
      return '';
    } finally {
      clearTimeout(timeout); voiceSignal?.removeEventListener('abort', cancel);
      setBusy(false); requestBusy.current = false;
      if (controller.current === request) controller.current = null;
    }
  }
  function saveMemory() {
    const text = memoryInput.trim(); if (!text) return;
    if (text.length > 500 || data.memories.length >= 30 && !editingMemory) { notify('記憶は1件500文字、30件までです。'); return; }
    setData(d => ({ ...d, memories: editingMemory ? d.memories.map(m => m.id === editingMemory ? { ...m, text } : m) : [...d.memories, { id: uuid(), text, at: Date.now() }] }));
    setMemoryInput(''); setEditingMemory(null); notify('ろき様が指定した内容を記憶しました。');
  }
  function addReminder() {
    const time = new Date(due).getTime(); if (!title.trim() || !Number.isFinite(time) || time <= Date.now()) { notify('予定名と未来の時刻を入力してください。'); return; }
    setData(d => ({ ...d, reminders: editingReminder ? d.reminders.map(r => r.id === editingReminder ? { ...r, title: title.trim(), due: time, repeat, done: false } : r) : [...d.reminders, { id: uuid(), title: title.trim(), due: time, repeat, done: false }] }));
    setTitle(''); setDue(''); setEditingReminder(null); notify('予定を登録しました。この画面を開いている間にお知らせします。');
  }
  function exportData() {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `lux-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const nav = [{ id: 'chat', icon: 'chat', name: '会話' }, { id: 'memory', icon: 'memory', name: '記憶' }, { id: 'reminder', icon: 'clock', name: '予定' }, { id: 'settings', icon: 'settings', name: '設定' }];
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="./" aria-label="LUX ホーム"><span className="brand-mark">✧</span><span>LUX<span className="brand-caption">PERSONAL COMPANION</span></span></a><div className="side-label">YOUR SPACE</div><nav aria-label="メインメニュー">{nav.map(n => <button key={n.id} className={page === n.id ? 'nav-item active' : 'nav-item'} onClick={() => setPage(n.id)} aria-current={page === n.id ? 'page' : undefined}><Icon name={n.icon}/><span>{n.name}</span>{n.id === 'memory' && <small>{data.memories.length.toString().padStart(2,'0')}</small>}</button>)}</nav><div className="side-bottom"><div className="mini-orb"/><div><strong>ろき様のLUX</strong><p>あなたと、少しずつ。</p></div><span className="little-dot"/></div></aside>
    <div className="workspace"><header className="topbar"><div className="mobile-brand">✧ LUX</div><div className="breadcrumb">MY COMPANION <span>/</span> {nav.find(n => n.id === page)?.name}</div><div className="status-chip"><span className={connected ? 'little-dot online' : 'little-dot'}/>{connected ? 'AI 接続済み' : 'AI 未接続'}</div><button className="icon-button top-settings" onClick={() => setPage('settings')} aria-label="設定を開く"><Icon name="settings"/></button></header>
    <main className={`main-content ${page === 'chat' ? 'chat-page' : ''}`}>
    {page === 'chat' && <>
      <section className={data.messages.length ? 'companion-hero compact' : 'companion-hero'} aria-label="LUXの状態"><div className="hero-eyebrow"><span/> ALWAYS BY YOUR SIDE</div><div className={`orb-scene avatar-scene ${busy ? 'thinking' : ''} ${speaking ? 'speaking' : ''} ${listening ? 'listening' : ''}`}><div className="orb-halo halo-one"/><div className="orb-halo halo-two"/><div className="orb-ring ring-one"/><div className="orb-ring ring-two"/><img className="lux-avatar" src={new URL('./lux-avatar.png', import.meta.url).href} alt="微笑むルクス" width="260" height="300" fetchPriority="high"/><span className="star star-one">✦</span><span className="star star-two">✧</span><span className="orb-ground"/></div><div className="hero-copy"><p className="hero-kicker">YOUR PERSONAL AI COMPANION</p><h1>{listening ? 'お話を聞いています。' : speaking ? 'ろき様へ、お伝えします。' : busy ? '少し、お待ちください。' : 'おかえりなさい、ろき様。'}</h1><p>今日も、あなたのそばに。<br className="mobile-break"/> どんなことから始めましょうか。</p></div></section>

      <section className="conversation" ref={historyViewport} tabIndex={0} onScroll={e => { const el = e.currentTarget; followHistory.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-label="会話履歴。スクロールで過去の会話を表示" aria-live="polite">{!data.messages.length && <section className="suggestions" aria-label="会話のきっかけ"><button onClick={() => setInput('今日の気持ちを聞いてほしいです。')}><Icon name="spark"/><span><strong>少し、話しませんか</strong><small>今日の気持ちを、ゆっくりと</small></span><Icon name="arrow" size={16}/></button><button onClick={() => setPage('memory')}><Icon name="memory"/><span><strong>私に覚えてほしいこと</strong><small>大切なことを、一つずつ</small></span><Icon name="arrow" size={16}/></button><button onClick={() => setPage('reminder')}><Icon name="clock"/><span><strong>日常を、整える</strong><small>予定やタイマーを確認する</small></span><Icon name="arrow" size={16}/></button></section>}{data.messages.map(m => <article key={m.id} className={`message ${m.role}`}><div className="message-avatar">{m.role === 'assistant' ? '✧' : 'R'}</div><div className="message-body"><div className="message-meta">{m.role === 'assistant' ? 'LUX' : 'ろき様'}<time>{dateLabel(m.at)}</time></div><p>{m.text.replaceAll('ロキ様','ろき様')}</p>{m.role === 'assistant' && <button className="text-button" onClick={() => speak(m.text.replaceAll('ロキ様','ろき様'))}><Icon name="sound" size={14}/> 読み上げ</button>}</div></article>)}{busy && <div className="thinking-label"><span className="pulse-dots">•••</span> LUXが応答を準備しています</div>}<div ref={bottom}/></section>
      <div className="composer-area"><section className={`voice-controls ${voiceActive ? 'active' : ''}`} aria-label="音声会話モード"><div><strong>{voiceActive ? localLiveTest ? '端末往復テスト中 · AI利用なし' : localVoiceTest ? voiceTestRecognitionOnly ? '端末音声テスト中 · 認識のみ・AI利用なし' : '端末音声テスト中 · 待ち時間あり・AI利用なし' : liveMode ? voicePhase === 'starting' ? 'ライブを準備しています' : 'ライブ会話中 · 声で割り込みできます' : '音声会話中 · ルクスの音声応答 ON' : 'ルクスと音声で話す'}</strong><p role="status">{voicePhase === 'finishing' ? 'お話を送信する準備をしています。' : voicePhase === 'starting' ? 'マイクを起動しています。少しお待ちください。' : voicePhase === 'recovering' ? 'マイクを再接続しています。' : voicePhase === 'mic-ready' ? '返答の再生が終わりました。「マイクを再開」を押してからお話しください。' : voicePhase === 'mic-paused' ? 'マイクの再開操作をお待ちしています。' : voicePhase === 'listening' ? liveMode ? localLiveTest ? '一言話し、1秒ほど間を空けてください。話した声をそのまま返します。文字起こしはしません。' : 'お話しください。返答中もマイクを保持して会話を続けます。' : 'マイクを起動しました。お話しください。文字が出るか確認してください。' : voicePhase === 'waiting' ? localVoiceTest ? 'AIの応答待ちを再現しています。利用回数は減りません。' : 'ルクスが声でのお返事を考えています。' : voicePhase === 'speaking' ? liveMode ? localLiveTest ? '今話した声を再生しています。聞き終わったら次の一言をどうぞ。' : 'ルクスがお話し中です。そのまま話しかけて割り込めます。' : '返答の音声再生を準備・実行中です。再生後は画面の案内に沿ってお話しください。' : voicePhase === 'paused' ? '再生待ちです。下のボタンを押してください。' : liveMode ? 'Live音声会話：アプリ独自の時間・往復制限なし。Google側の接続制限は適用されます。' : '聞く → 自動送信 → 声で返答。画面を開いたままご利用ください。'}</p></div><button type="button" className={voiceActive ? 'voice-end' : 'primary'} disabled={!voiceActive && (busy || listening)} onClick={() => voiceActive ? stopAllVoice() : localLiveTest ? void startLive(true) : startVoice()}><Icon name={voiceActive ? 'stop' : 'mic'} size={17}/>{voiceActive ? '音声会話を終了' : localLiveTest ? '往復テストを再開' : liveMode ? '音声会話を開始' : '音声会話を開始'}</button>{liveMode && liveHealth.stage && <div className="live-health"><p role="status">{liveHealth.stage}</p>{voiceActive && <><label>マイクの反応<meter min={0} max={1} value={Math.min(1,liveHealth.inputLevel*5)} aria-label="マイクの音量"/></label><small>音声送信 {liveHealth.sentFrames} ・ 返答音声受信 {liveHealth.receivedChunks}</small></>}{voiceActive && <button type="button" className="text-button" aria-pressed={!!liveHealth.muted} onClick={()=>liveSession.current?.setMuted(!liveHealth.muted)}>{liveHealth.muted ? 'ミュートを解除' : 'マイクをミュート'}</button>}{voiceActive && liveHealth.needsResume && <button type="button" className="primary" onClick={()=>void liveSession.current?.resumeAudio()}>音声を有効にする</button>}</div>}{(!liveMode) && voicePhase === 'listening' && <button type="button" className="primary" onClick={() => voiceSession.current?.finishSpeaking()}>話し終わり</button>}{(!liveMode) && voiceActive && ['starting','listening','recovering','mic-ready','mic-paused'].includes(voicePhase) && <button type="button" className="text-button mic-restart" onClick={() => voiceSession.current?.restartMicrophone()}>マイクを再開</button>}{(!liveMode) && voicePhase === 'paused' && <button type="button" className="primary" onClick={() => voiceSession.current?.resume()}>返答を再生して続ける</button>}{voiceActive && liveTranscript && <p className="live-transcript">{liveTranscript}</p>}</section>{error && <div className="error" role="alert">{error}{voiceEvents.length > 0 && <button type="button" className="text-button" onClick={copyVoiceLog}>動作ログをコピー</button>}<button className="text-button" onClick={() => setPage('settings')}>設定を開く</button><button className="text-button" onClick={() => setError('')}>閉じる</button></div>}{!settings.endpoint && <div className="connection-note"><Icon name="lock" size={13}/> 安全なAI接続の準備中です <button onClick={() => setPage('settings')}>接続設定 <span>↗</span></button></div>}{dictationPhase !== 'idle' && <p className="dictation-status" role="status">{dictationPhase === 'starting' ? '音声入力を起動しています…' : dictationPhase === 'listening' ? '聞き取り中です。マイクを押すと確定します。' : '認識した言葉を入力しています…'}</p>}<form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="LUXへのメッセージ" placeholder="ルクス、少し話そう。" value={input} maxLength={4000} rows={1} disabled={voiceActive || dictationPhase !== 'idle'} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}/><div className="composer-actions"><span className="input-hint" role="status">{dictationPhase === 'starting' ? '音声入力を起動しています…' : dictationPhase === 'listening' ? '聞き取り中です。マイクを押すと確定します。' : dictationPhase === 'finishing' ? '認識した言葉を入力しています…' : 'あなたのペースで、お話しください。'}</span><button type="button" className={`icon-button ${listening ? 'recording' : ''}`} onClick={mic} disabled={voiceActive || busy} aria-label={dictationPhase !== 'idle' ? '音声入力を確定' : '音声入力'}><Icon name={listening ? 'stop' : 'mic'}/></button>{speaking && <button type="button" className="icon-button" onClick={() => { stopAllVoice(); stopPlayback(); }} aria-label="読み上げを停止"><Icon name="stop"/></button>}<button type={busy ? 'button' : 'submit'} className="send-button" disabled={voiceActive || dictationPhase !== 'idle' || (!busy && !input.trim())} onClick={busy ? () => controller.current?.abort() : undefined} aria-label={busy ? '応答待ちを停止' : '送信'}><Icon name={busy ? 'stop' : 'send'} size={19}/></button></div></form><p className="privacy-foot"><span className="little-dot"/> 会話はこの端末に保存 <span className="separator">·</span> LUX NEXT <span className="version">v0.1</span></p></div>
    </>}
    {page === 'memory' && <section className="panel-page"><div className="page-eyebrow">MEMORY</div><h1>あなたを、少しずつ知る。</h1><p className="page-description">覚えておきたいことを、ろき様自身で選べます。会話履歴とは別に、この端末へ保存します。</p><div className="info-note"><Icon name="lock"/> 自動では記憶しません。AIに話すときは、登録した記憶が会話の文脈として送られます。</div><div className="card"><h2>{editingMemory ? '記憶を編集' : '新しい記憶'}</h2><label>覚えてほしいこと<textarea value={memoryInput} onChange={e => setMemoryInput(e.target.value)} maxLength={500} placeholder="例：落ち着いた丁寧な話し方が好きです。"/></label><button className="primary" onClick={saveMemory}><Icon name="plus" size={16}/>{editingMemory ? '変更を保存' : 'この内容を記憶する'}</button>{editingMemory && <button className="text-button" onClick={() => { setEditingMemory(null); setMemoryInput(''); }}>キャンセル</button>}</div><label className="search-label">記憶を検索<input placeholder="キーワードを入力" value={query} onChange={e => setQuery(e.target.value)}/></label><div className="section-title"><h2>大切な記憶</h2><span>{data.memories.length} / 30</span></div>{data.memories.filter(m => m.text.includes(query)).map(m => <article className="card memory-card" key={m.id}><Icon name="memory"/><div><p>{m.text.replaceAll('ロキ様','ろき様')}</p><small>{new Date(m.at).toLocaleDateString('ja-JP')}</small><div className="row-actions"><button onClick={() => { setEditingMemory(m.id); setMemoryInput(m.text); }}>編集</button><button onClick={() => { if (confirm('この記憶を削除しますか？')) setData(d => ({ ...d, memories: d.memories.filter(x => x.id !== m.id) })); }}>削除</button></div></div></article>)}{!data.memories.length && <div className="empty-state"><Icon name="memory" size={32}/><h3>記憶は、ここから。</h3><p>あなたが覚えてほしいと思ったことだけを。</p></div>}</section>}
    {page === 'reminder' && <section className="panel-page"><div className="page-eyebrow">DAILY SUPPORT</div><h1>日常に、小さな余白を。</h1><p className="page-description">予定と時間の管理を、ひとつの場所に。</p><div className="info-note">この段階では、アプリを開いている間のお知らせです。画面を閉じている間の通知・音声からの自動登録は未接続です。</div><div className="card"><h2>タイマー</h2><div className="inline-form"><input type="number" min="1" max="1440" aria-label="タイマーの分数" value={timerMinutes} onChange={e => setTimerMinutes(e.target.value)}/><span>分</span><button className="primary" onClick={() => { const minutes = Number(timerMinutes); if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return notify('1〜1440分で指定してください。'); setData(d => ({ ...d, reminders: [...d.reminders, { id: uuid(), title: `${minutes}分タイマー`, due: Date.now() + minutes*60000, done: false, repeat: 'none' }] })); notify('タイマーを開始しました。'); }}>開始</button></div></div><div className="card"><h2>{editingReminder ? '予定を編集' : '予定を追加'}</h2><label>予定名<input value={title} maxLength={100} onChange={e => setTitle(e.target.value)} placeholder="例：病院の予定"/></label><label>日時<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)}/></label><label>繰り返し<select value={repeat} onChange={e => setRepeat(e.target.value as Reminder['repeat'])}><option value="none">繰り返しなし</option><option value="daily">毎日</option><option value="weekly">毎週（同じ曜日）</option></select></label><button className="primary" onClick={addReminder}>{editingReminder ? '変更を保存' : '予定を登録'}</button></div><h2>予定一覧</h2>{data.reminders.filter(r => !r.done).sort((a,b) => a.due-b.due).map(r => <div className="card" key={r.id}><h3>{r.title}</h3><p>{new Date(r.due).toLocaleString('ja-JP')} {r.repeat === 'daily' ? '・毎日' : r.repeat === 'weekly' ? '・毎週' : ''}</p><small>あと {Math.max(0,Math.ceil((r.due-now)/60000))} 分</small><div className="row-actions"><button onClick={() => { setEditingReminder(r.id); setTitle(r.title); const t = new Date(r.due); setDue(new Date(+t-t.getTimezoneOffset()*60000).toISOString().slice(0,16)); setRepeat(r.repeat); }}>編集</button><button onClick={() => setData(d => ({ ...d, reminders: d.reminders.filter(x => x.id !== r.id) }))}>削除</button></div></div>)}{!data.reminders.some(r=>!r.done) && <p className="muted">次の予定は、まだありません。</p>}<h2>お知らせの履歴</h2>{data.notices.map((n,i) => <p className="notice-row" key={i}>{n}</p>)}{!data.notices.length && <p className="muted">お知らせはまだありません。</p>}</section>}
    {page === 'settings' && <section className="panel-page"><div className="page-eyebrow">SETTINGS</div><h1>あなたに合う、ルクスへ。</h1><p className="page-description">接続、声、そして大切なデータを管理します。</p>{error && <div className="error" role="alert">{error}</div>}<div className="card"><div className="section-title"><h2>AIとの接続</h2><span className="tag">{connected ? '接続済み' : '未接続'}</span></div><p className="muted">GeminiのAPIキーはサーバー側だけに保存します。この画面にAPIキーを入力しないでください。</p><label>バックエンドURL<input type="url" value={settings.endpoint} onChange={e => patchSettings({ endpoint: e.target.value.trim() })} placeholder="https://lux-next-api.example.workers.dev" autoCapitalize="none" spellCheck={false}/></label><label>専用アクセスコード<input type="password" value={token} onChange={e => { setToken(e.target.value); setConnected(false); }} placeholder="サーバーに設定した専用コード" autoComplete="off"/></label><small>保存しない場合、アクセスコードはページを閉じると消えます。</small><label className="switch-row">この端末にアクセスコードを保存<input type="checkbox" checked={rememberCode} onChange={e => setRememberCode(e.target.checked)}/></label><p className="muted">オンにすると次回から入力を省けます。このブラウザに保存するため、ご自身専用の端末でご利用ください。GeminiのAPIキーは保存しません。</p><label>モデル<select value={settings.model} onChange={e => patchSettings({ model: e.target.value })}><option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite</option></select></label><button className="primary" disabled={busy || !token || !settings.endpoint} onClick={() => void connect()}>接続を確認</button></div><div className="card"><h2>音声</h2><p>新しい音声会話はマイクを保持したまま音声を直接送受信します。従来の認識・読み上げは設定から引き続き使えます。</p><div className="row-actions"><button className="primary" disabled={busy} onClick={()=>void startLive(false)}>新しい音声会話を開始</button><button disabled={busy} onClick={()=>void startLive(true)}>音声の往復テスト（AI利用なし）</button></div><p className="muted">往復テストは一言話して約1秒黙ると、今話した声をそのまま再生します。AIの返答や文字起こしはありません。音声は一時的に端末メモリだけで扱い、サーバー送信・履歴保存・予算消費はしません。再生後に二言目・三言目も試せます。2分で終了します。</p><label>音声会話の方式<select value={settings.voiceEngine} onChange={e => patchSettings({voiceEngine:e.target.value as Settings['voiceEngine']})}><option value="live">音声を直接送受信（Gemini Live）</option><option value="classic">従来の認識・読み上げ方式</option></select></label><label className="switch-row">Geminiの無料プランを確認済み<input type="checkbox" checked={settings.freeLive} onChange={e=>patchSettings({freeLive:e.target.checked})}/></label><p className="muted">Liveは音声をGeminiへ送受信します。Google AI Studioでキーのプロジェクトが無料プランであることを確認してください。LUXから課金設定は変更しません。無料枠の上限はGoogle側の設定によります。</p><p className="muted">LUX独自の1回あたりの時間・往復数制限はありません。Google側の接続時間や無料枠の利用制限によって終了する場合があります。Liveの予算記録は請求額ではありません。アプリ独自の予算上限が無効の場合、記録による停止はしません。無料枠でも会話がサービス改善に使われる場合があります。Liveの声はKore、従来方式の声は下で選択します。</p><p className="muted">会話画面の開始ボタンで、聞き取りと返答の読み上げを繰り返します。音声会話中は下の設定にかかわらず返答を読み上げます。従来方式は割り込み未対応です。Liveは割り込みに対応する設計ですが、iPhone実機では未検証です。画面を閉じると終了します。</p><label className="switch-row">回答を自動で読み上げる<input type="checkbox" checked={settings.voice} onChange={e => patchSettings({ voice: e.target.checked })}/></label><label>日本語の声<select value={settings.voiceName} onChange={e => patchSettings({ voiceName: e.target.value })}><option value="">端末の標準音声</option>{voices.map(v => <option key={v.voiceURI} value={v.name}>{v.name}</option>)}</select></label><p className="muted">声は端末により異なります。自動再生が制限される場合は、回答の「読み上げ」を押してください。iPhone実機での検証は未完了です。</p><label className="switch-row">返答をボタンで再生（自動再生が止まる場合）<input type="checkbox" checked={voiceButtonPlayback} onChange={e=>setVoiceButtonPlayback(e.target.checked)}/></label><p className="muted">従来方式と端末テストに適用します。オンの間は返答が届いたら「返答を再生して続ける」を押してください。自動再生が起動しなかった場合も、このページではオンになります。再生ボタンはAIへ再送しません。</p><label className="switch-row">読み上げ後はボタンでマイクを再開<input type="checkbox" checked={voiceButtonMicrophone} onChange={e=>setVoiceButtonMicrophone(e.target.checked)}/></label><p className="muted">従来方式と端末テストの次回開始から適用します。オンの間は読み上げ完了後にマイクを自動起動せず、「マイクを再開」を押した操作で起動します。再生とマイクの両方をボタン操作にする場合は上の設定もオンにしてください。ページ再読み込みでオフに戻ります。実機での改善は確認中です。</p><label className="switch-row">音声テストは認識だけを確認（読み上げなし）<input type="checkbox" checked={voiceTestRecognitionOnly} onChange={e=>setVoiceTestRecognitionOnly(e.target.checked)}/></label><p className="muted">次の端末テストで適用します。オンでは読み上げを呼ばず、指定秒数待って次の認識を自動開始します。上の再生・マイクのボタン設定はこのテスト中だけ適用しません。声が返らないのは正常です。文字が2回目も出るかを確認し、通常会話やLiveへの送信は行いません。</p><label>音声テストの応答待ち時間<select value={voiceTestDelay} onChange={e=>setVoiceTestDelay(Number(e.target.value) as VoiceTestDelay)}><option value={0}>待ち時間なし（比較用）</option><option value={3000}>3秒</option><option value={10000}>10秒</option><option value={30000}>30秒</option></select></label><label className="switch-row">音声テストで長い返答を使う<input type="checkbox" checked={voiceTestLong} onChange={e=>setVoiceTestLong(e.target.checked)}/></label><div className="row-actions"><button onClick={() => speak('おかえりなさい、ろき様。私がそばにいます。')}>声を試す</button><button onClick={() => startVoice(true)} disabled={busy}>端末音声テスト（AI利用なし）</button><button onClick={() => { stopAllVoice(); stopPlayback(); }}>停止</button></div><p className="muted">端末音声テストは、聞き取り→指定秒数の応答待ち→固定文の読み上げ→再び聞き取りを試します。通常会話と同じ応答待ち表示も再現します。AIへの送信・会話履歴への保存・アプリの予算消費はありません。端末の音声認識サービスは利用します。声が聞こえることと、2回目も文字が表示されることを確認してください。</p></div><div className="card voice-log-card"><div className="voice-log-toolbar"><div><h2>音声の動作ログ</h2><p className="muted">直近100件の状態記録をこの端末に保存します。会話内容やアクセスコードは記録しません。</p></div><button type="button" className="primary voice-log-copy" disabled={!voiceEvents.length} onClick={copyVoiceLog}>動作ログを一括コピー</button></div><details><summary>記録を表示（{voiceEvents.length}件）</summary><pre className="voice-diagnostics">{voiceEvents.length ? voiceEvents.join('\n') : '音声会話を開始すると表示します。'}</pre><div className="voice-log-danger-area"><button type="button" className="text-button voice-log-delete" disabled={!voiceEvents.length} onClick={() => { if (!window.confirm(`動作ログ${voiceEvents.length}件をすべて削除しますか？\n削除後は復元できません。コピーしてから削除することをおすすめします。`)) return; clearVoiceDiagnostics(); setVoiceEvents([]); notify('動作ログを削除しました。'); }}>動作ログを削除</button></div></details></div><div className="card usage-card"><h2>API利用状況（{usage?.month || '今月'}）</h2>{usage ? <>
        <p>呼び出し回数：{usage.requests.toLocaleString('ja-JP')}</p>
        <p>トークン：入力 {usage.inputTokens.toLocaleString('ja-JP')} / 出力 {usage.outputTokens.toLocaleString('ja-JP')}</p>
        <p>Live試用：{usage.liveSessions || 0} 回</p>
        <p>参考費用：{yen(usage.estimatedYen)}</p>
        <p>アプリ独自の月額上限：{usage.appBudgetEnabled === false ? '無効' : '有効'}</p>
        <p>APIプラン：{settings.freeLive ? '無料プランを確認済み（自己申告）' : '未確認'}</p>
        <p className="muted">参考費用は有料料金で換算した推定値であり、実際の請求額ではありません。Liveの利用料金はこの推定値に含まれません。Google側の利用制限・課金設定は変更されません。課金状況はGoogle AI Studioで確認してください。</p>
        <details className="usage-details"><summary>予算管理の記録</summary><p>過去の確保額：{yen(usage.reservedYen)}（請求額ではありません）</p><p>Googleの無料枠残量は取得できません。</p></details>
      </> : <p className="muted">サーバーへ接続すると、今月のAPI利用状況を表示します。</p>}</div><div className="card"><h2>ホーム画面に追加</h2><p>iPhoneのSafariでこのページを開き、共有ボタン →「ホーム画面に追加」を選んでください。</p><p className="muted">初回はオンラインで開いてください。オフラインでは保存済みの記憶や会話を閲覧できます。AIとの通信にはインターネット接続が必要です。</p></div><div className="card"><h2>データとプライバシー</h2><p className="muted">会話と記憶は、このブラウザ内に保存します。暗号化された保管庫ではありません。共有端末での利用は避けてください。AI送信時には直近16件の会話と登録した記憶をサーバー経由でGeminiへ送ります。無料API枠では入力がサービス改善に使われる場合があります。クラウド同期・暗号化・自動記憶は未実装です。</p><div className="row-actions"><button onClick={exportData}>データをエクスポート</button><button onClick={() => { if (confirm('会話履歴をすべて削除しますか？記憶は残ります。')) setData(d => ({ ...d, messages: [] })); }}>会話を消去</button><button className="danger" onClick={() => { if (confirm('この端末のLUXデータをすべて初期化します。エクスポートはお済みですか？')) { stopAllVoice(); controller.current?.abort(); recognition.current?.stop(); speechSynthesis?.cancel(); clearVoiceDiagnostics(); setVoiceEvents([]); setData(fresh()); setRememberCode(false); saveAccessCode(false, ''); setToken(''); setConnected(false); setUsage(null); notify('データを初期化しました。'); } }}>すべて初期化</button></div></div><p className="footer-note">LUX NEXT · v0.1 · あなたと育つ、静かな光。<br/>AI接続はサーバー設定待ち。閉じた状態の通知は未実装です。</p></section>}
    </main><nav className="mobile-nav" aria-label="下部メニュー">{nav.map(n => <button className={page === n.id ? 'active' : ''} key={n.id} onClick={() => setPage(n.id)} aria-label={n.name}><Icon name={n.icon}/><span>{n.name}</span></button>)}</nav></div>{toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="panel-page"><h1>画面を開けませんでした。</h1><p>保存データを保ったまま、ページを再読み込みしてください。</p><button className="primary" onClick={() => location.reload()}>再読み込み</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
if ('serviceWorker' in navigator) window.addEventListener('load', () => { void navigator.serviceWorker.register(`${import.meta.url.includes('/assets/') ? '/lux-next/' : './'}sw.js`, { scope: '/lux-next/' }).catch(() => {}); });
