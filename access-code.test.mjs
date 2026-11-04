import test from 'node:test';
import assert from 'node:assert/strict';
import {readAccessCode,saveAccessCode} from './access-code.ts';
function store(){const map=new Map([['other-data','preserve']]);return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}}
test('access code persists only after opt-in, and opting out removes it',()=>{
 const s=store(),get=()=>s;
 assert.deepEqual(readAccessCode(get),{remember:false,token:''});
 assert.equal(saveAccessCode(false,'sample-code',get),true);assert.equal(readAccessCode(get).token,'');
 saveAccessCode(true,'sample-code',get);assert.deepEqual(readAccessCode(get),{remember:true,token:'sample-code'});
 saveAccessCode(false,'sample-code',get);assert.equal(readAccessCode(get).remember,false);assert.equal(s.getItem('other-data'),'preserve');
});
test('corrupt or unavailable storage fails safely and reports save failure',()=>{
 assert.equal(readAccessCode(()=>({getItem:()=>'{bad'})).remember,false);
 assert.equal(saveAccessCode(true,'sample-code',()=>{throw Error('blocked')}),false);
 assert.equal(readAccessCode(()=>{throw Error('blocked')}).token,'');
});
