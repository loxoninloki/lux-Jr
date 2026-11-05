const KEY='lux-next:voice-diagnostics:v1';
const MAX=100;
const eventPattern=/^(live|phase|recognition|dictation|speech):[a-z0-9-]{1,70}$/;
const linePattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (live|phase|recognition|dictation|speech):[a-z0-9-]{1,70}$/;
function clean(value:unknown):string[]{return Array.isArray(value)?value.filter((line):line is string=>typeof line==='string'&&linePattern.test(line)).slice(-MAX):[];}
export function loadVoiceDiagnostics():string[]{try{return clean(JSON.parse(localStorage.getItem(KEY)||'[]'));}catch{return [];}}
export function appendVoiceDiagnostic(lines:string[],event:string):string[]{
 if(!eventPattern.test(event))return lines;
 const next=[...clean(lines),`${new Date().toISOString()} ${event}`].slice(-MAX);
 // Write at the event, not on a later effect that may be lost on page close.
 try{localStorage.setItem(KEY,JSON.stringify(next));}catch{}
 return next;
}
export function clearVoiceDiagnostics(){try{localStorage.removeItem(KEY);}catch{}}
