export type VoiceTestDelay = 0 | 3000 | 10000 | 30000;
export const SHORT_TEST_REPLY = '聞き取れました。もう一度、お話しください。';
export const LONG_TEST_REPLY = 'ろき様、お話を聞き取れました。これは、長めのお返事を読み上げたあとも、マイクが正常に戻るかを確かめるためのテストです。AIには接続していないので、会話の利用回数は減りません。この音声が最後まで聞こえたら、もう一度、短い言葉で話しかけてください。';

/** No transport or conversation data: cancellable provider latency simulation. */
export function simulateVoiceReply(delay: VoiceTestDelay, longReply: boolean, signal: AbortSignal, diagnostic: (event:string)=>void): Promise<string> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}
    if(![0,3000,10000,30000].includes(delay)){reject(Error('音声テストの待ち時間が無効です。'));return;}
    diagnostic(`recognition:test-reply-${longReply?'long':'short'}`);
    diagnostic(`recognition:test-wait-${delay}`);
    if(delay===0){diagnostic('recognition:test-reply-ready');resolve(longReply?LONG_TEST_REPLY:SHORT_TEST_REPLY);return;}
    let timer:ReturnType<typeof setTimeout>|undefined;
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);diagnostic('recognition:test-wait-cancelled');reject(new DOMException('Aborted','AbortError'));};
    signal.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);diagnostic('recognition:test-reply-ready');resolve(longReply?LONG_TEST_REPLY:SHORT_TEST_REPLY);},delay);
  });
}
