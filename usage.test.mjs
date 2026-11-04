import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingConversations } from './usage.ts';
test('estimates from the server reservation ledger, not the displayed paid-price estimate', () => {
  assert.equal(remainingConversations({requests:4,reservedYen:12.22,budgetYen:1000}),320);
});
test('does not invent an estimate without usage', () => {
  assert.equal(remainingConversations({requests:0,reservedYen:0,budgetYen:1000}),null);
});
test('exhausted and small remaining budgets stay nonnegative', () => {
  assert.equal(remainingConversations({requests:5,reservedYen:1001,budgetYen:1000}),0);
  assert.equal(remainingConversations({requests:10,reservedYen:990,budgetYen:1000}),0);
  assert.equal(remainingConversations({requests:10,reservedYen:900,budgetYen:1000}),1);
});
test('rejects invalid server values', () => {
  for (const reservedYen of [-1,NaN,Infinity]) assert.equal(remainingConversations({requests:4,reservedYen,budgetYen:1000}),null);
});
