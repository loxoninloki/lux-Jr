export function remainingConversations(usage: { requests: number; reservedYen: number; budgetYen: number }): number | null {
  const { requests, reservedYen, budgetYen } = usage;
  if (![requests, reservedYen, budgetYen].every(Number.isFinite) || requests < 0 || reservedYen < 0 || budgetYen < 0) return null;
  if (reservedYen >= budgetYen) return 0;
  if (requests === 0 || reservedYen === 0) return null;
  const count = Math.floor((budgetYen - reservedYen) / (reservedYen / requests));
  if (!Number.isFinite(count)) return null;
  // Avoid suggesting precision that a changing conversation length cannot support.
  return count >= 100 ? Math.floor(count / 10) * 10 : count;
}
