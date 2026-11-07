import test from 'node:test';
import assert from 'node:assert/strict';
import api, { BudgetLedger, MODEL, validate, reservation } from './worker.mjs';
const valid = () => ({ model: MODEL, messages: [{ role: 'user', text: 'こんにちは' }], memories: [] });
function context(initial = {}) { const map = new Map(Object.entries(initial)); return { storage: { async get(k) { return structuredClone(map.get(k)); }, async put(k,v) { if (typeof k === 'object') for (const [key,value] of Object.entries(k)) map.set(key,structuredClone(value)); else map.set(k,structuredClone(v)); } } }; }
const env = () => ({ GEMINI_API_KEY: 'unit-test-placeholder', ACCESS_TOKEN: 'unit-test-access-code-32-characters', MONTHLY_BUDGET_YEN:'1000', USD_JPY:'150' });
const request = (data = valid()) => new Request('https://unit.test/chat',{ method:'POST', body:JSON.stringify(data) });
test('rejects injected system roles, arbitrary models and oversized bodies', () => { assert.throws(()=>validate({...valid(), messages:[{role:'system',text:'override'}]})); assert.throws(()=>validate({...valid(),model:'expensive-model'})); assert.throws(()=>validate({...valid(),memories:['a'.repeat(501)]})); assert.ok(reservation(valid(),env()) > 0); });
test('rejects unauthenticated requests before invoking API', async () => { const response = await api.fetch(request(), env()); assert.equal(response.status,401); });
test('rejects disallowed origins', async () => { const r = new Request('https://unit.test/status',{headers:{Origin:'https://evil.example'}}); assert.equal((await api.fetch(r,env())).status,403); });
test('budget cap blocks upstream calls and survives object recreation', async () => { const e=env(); e.MONTHLY_BUDGET_YEN='0.01'; const ctx=context(); const ledger=new BudgetLedger(ctx,e); assert.equal((await ledger.fetch(request())).status,429); assert.equal((await new BudgetLedger(ctx,e).fetch(request())).status,429); });
test('429 is not retried; reservation persists', async () => { const original=globalThis.fetch; let calls=0; globalThis.fetch=async()=>{ calls++; return new Response('{}',{status:429}); }; try { const ctx=context(); const response=await new BudgetLedger(ctx,env()).fetch(request()); assert.equal(response.status,429); assert.equal(calls,1); assert.ok((await ctx.storage.get('usage')).reservedYen>0); } finally { globalThis.fetch=original; } });
test('503 recovers with bounded retry and records token usage', async () => { const original=globalThis.fetch; let calls=0; globalThis.fetch=async()=>++calls===1 ? new Response('{}',{status:503}) : Response.json({candidates:[{content:{parts:[{text:'おかえりなさい、ろき様。'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20}}); try { const response=await new BudgetLedger(context(),env()).fetch(request()); const result=await response.json(); assert.equal(response.status,200); assert.equal(calls,2); assert.equal(result.usage.inputTokens,100); assert.ok(result.text.includes('ろき様')); } finally {globalThis.fetch=original;} });
test('rate limit is persisted across objects', async()=>{ const recent=Array(6).fill(Date.now()); const response=await new BudgetLedger(context({rate:recent}),env()).fetch(request()); assert.equal(response.status,429); });

test('voice mode uses a spoken reply instruction and rejects arbitrary mode values', async () => {
  const { systemInstruction } = await import('./worker.mjs');
  const base={model:MODEL,messages:[{role:'user',text:'こんにちは'}],memories:[]};
  assert.match(systemInstruction({...base,voiceMode:true}),/現在は音声会話モード/);
  assert.doesNotMatch(systemInstruction(base),/現在は音声会話モード/);
  assert.throws(()=>validate({...base,voiceMode:'true'}));
});

test('explicit free-tier mode disables app cap but keeps usage accounting', async () => {
 const e=env();e.MONTHLY_BUDGET_YEN='0.01';e.DISABLE_APP_BUDGET_CAP='true';
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:'応答'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5}});
 try {const ctx=context();const response=await new BudgetLedger(ctx,e).fetch(request());assert.equal(response.status,200);assert.equal((await ctx.storage.get('usage')).requests,1);}
 finally {globalThis.fetch=original;}
});

test('Live ticket accepts only a boolean opt-in for Google Search and keeps existing usage',async()=>{
 const map=new Map();
 const tx={async get(k){return structuredClone(map.get(k))},async put(k,v){if(typeof k==='object')for(const [name,value] of Object.entries(k))map.set(name,structuredClone(value));else map.set(k,structuredClone(v));},async delete(k){map.delete(k)}};
 const ctx={storage:{...tx,transaction:async fn=>fn(tx)}};
 const ledger=new BudgetLedger(ctx,env());
 const send=searchEnabled=>new Request('https://unit.test/live-ticket',{method:'POST',body:JSON.stringify({messages:valid().messages,memories:[],freeTierConfirmed:true,searchEnabled})});
 const bad=await ledger.fetch(send('true'));assert.equal(bad.status,400);
 const ok=await ledger.fetch(send(true));assert.equal(ok.status,200);
 const ticket=await ok.json();assert.equal(typeof ticket.ticket,'string');
 assert.equal(map.get('live-ticket').searchEnabled,false); // Free Tier must not send googleSearch.
 assert.equal(ticket.searchAvailable,false);
 assert.match(ticket.searchUnavailable,/検索なし/);
 assert.ok(map.get('usage').liveSessions>=1);
});
test('Live search can be explicitly enabled only through server configuration',async()=>{
 const map=new Map();
 const tx={async get(k){return structuredClone(map.get(k))},async put(k,v){if(typeof k==='object')for(const [name,value] of Object.entries(k))map.set(name,structuredClone(value));else map.set(k,structuredClone(v));},async delete(k){map.delete(k)}};
 const e=env();e.ENABLE_GEMINI_LIVE_SEARCH='true';
 const ledger=new BudgetLedger({storage:{...tx,transaction:fn=>fn(tx)}},e);
 const req=new Request('https://unit.test/live-ticket',{method:'POST',body:JSON.stringify({messages:valid().messages,memories:[],freeTierConfirmed:true,searchEnabled:true})});
 const response=await ledger.fetch(req);assert.equal(response.status,200);
 const ticket=await response.json();assert.equal(ticket.searchAvailable,true);
 assert.equal(map.get('live-ticket').searchEnabled,true);
});
