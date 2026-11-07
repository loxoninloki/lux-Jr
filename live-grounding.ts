// Grounding metadata can come with an audio turn or in a separate Live packet.
// Keep only bounded HTTPS links and short labels. Never persist or log raw metadata.
export type LiveSource = { title: string; url: string };
export type LiveGrounding = {
  sources: LiveSource[];
  searches: number;
  searchSuggestions: string;
};

export function extractLiveGrounding(value: unknown): LiveGrounding | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  const content = message.serverContent && typeof message.serverContent === 'object'
    ? message.serverContent as Record<string, unknown> : {};
  const meta = (content.groundingMetadata || message.groundingMetadata) as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') return null;
  const raw = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
  const sources: LiveSource[] = [];
  const visited = new Set<string>();
  for (const chunk of raw.slice(0, 20)) {
    if (!chunk || typeof chunk !== 'object') continue;
    const web = (chunk as Record<string, unknown>).web as Record<string, unknown> | undefined;
    if (!web || typeof web.uri !== 'string') continue;
    try {
      if (web.uri.length > 2048) continue;
      const url = new URL(web.uri);
      if (url.protocol !== 'https:' || !url.hostname || visited.has(url.href)) continue;
      const title = typeof web.title === 'string' ? web.title.trim().slice(0, 120) : url.hostname;
      sources.push({title: title || url.hostname, url: url.href});
      visited.add(url.href);
      if (sources.length >= 5) break;
    } catch { /* Ignore malformed provider URLs. */ }
  }
  const searches = Array.isArray(meta.webSearchQueries)
    ? Math.min(100, meta.webSearchQueries.filter(x => typeof x === 'string' && x.trim()).length) : 0;
  const entry = meta.searchEntryPoint && typeof meta.searchEntryPoint === 'object'
    ? meta.searchEntryPoint as Record<string, unknown> : {};
  // Render provider-owned suggestions in a sandboxed iframe (no scripts, no same-origin).
  const searchSuggestions = typeof entry.renderedContent === 'string' && entry.renderedContent.length <= 16000
    ? entry.renderedContent : '';
  if (!sources.length && !searchSuggestions && !searches) return null;
  return {sources,searches,searchSuggestions};
}
