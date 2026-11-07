// Phase 0 only: opt-in Gemini Search Grounding probe. No application integration.
// Run in a trusted environment with GEMINI_API_KEY stored as a secret.
// Do not execute unless AI Studio confirms the project is on the Free tier
// and the official pricing page confirms this model's grounding allowance.
const model = 'gemini-2.5-flash-lite';
if (process.env.CONFIRMED_FREE_TIER !== 'true') {
  console.error('NOT_RUN: Confirm Free tier and current Google Search pricing first; set CONFIRMED_FREE_TIER=true.');
  process.exitCode = 2;
} else if (!process.env.GEMINI_API_KEY) {
  console.error('NOT_RUN: GEMINI_API_KEY must be provided securely as an environment secret.');
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: 'POST', signal: controller.signal, headers: {
        'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY
      }, body: JSON.stringify({
        contents: [{ parts: [{ text: '今日の日付を確認し、最新のニュースを1件調べてください。' }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 512 }
      }) }
    );
    if (!response.ok) {
      // No response body: it can contain query text or provider diagnostics.
      console.log(JSON.stringify({ status: 'API_ERROR', httpStatus: response.status, model }));
      process.exitCode = 1;
    } else {
      const data = await response.json();
      const metadata = data.candidates?.[0]?.groundingMetadata;
      const sources = (metadata?.groundingChunks || [])
        .map(chunk => chunk.web).filter(Boolean)
        .filter(web => { try { return new URL(web.uri).protocol === 'https:'; } catch { return false; } })
        .map(web => ({ title: String(web.title || '').slice(0, 120), url: web.uri }));
      const searched = Array.isArray(metadata?.webSearchQueries) && metadata.webSearchQueries.length > 0;
      const grounded = searched && sources.length > 0;
      console.log(JSON.stringify({
        status: grounded ? 'GROUNDED' : 'NOT_GROUNDED',
        httpStatus: response.status, model,
        searchPerformed: searched, sourceCount: sources.length,
        hasGroundingSupports: Array.isArray(metadata?.groundingSupports),
        hasSearchEntryPoint: Boolean(metadata?.searchEntryPoint),
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? null,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? null
        }
      }, null, 2));
      if (!grounded) process.exitCode = 1;
    }
  } catch (error) {
    console.log(JSON.stringify({ status: 'REQUEST_FAILED', kind: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' }));
    process.exitCode = 1;
  } finally { clearTimeout(timeout); }
}
