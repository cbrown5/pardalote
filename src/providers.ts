export type ProviderId = 'anthropic' | 'openai' | 'openrouter';

export interface ModelInfo {
  id: string;
  name: string;
  /** USD per million tokens, when known */
  inPrice?: number;
  outPrice?: number;
  structured?: boolean;
}

export interface CallOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  /** false = put the schema in the prompt instead (for models without structured outputs) */
  structured: boolean;
  maxTokens: number;
  signal?: AbortSignal;
  onProgress?: (chars: number) => void;
}

export interface CallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
  }
}

export const PROVIDERS: Record<ProviderId, { label: string; keyHint: string; consoleUrl: string; privacyUrl: string }> = {
  anthropic: {
    label: 'Anthropic',
    keyHint: 'sk-ant-…',
    consoleUrl: 'https://console.anthropic.com/settings/limits',
    privacyUrl: 'https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data',
  },
  openai: {
    label: 'OpenAI',
    keyHint: 'sk-…',
    consoleUrl: 'https://platform.openai.com/settings/organization/limits',
    privacyUrl: 'https://platform.openai.com/docs/guides/your-data',
  },
  openrouter: {
    label: 'OpenRouter',
    keyHint: 'sk-or-…',
    consoleUrl: 'https://openrouter.ai/settings/keys',
    privacyUrl: 'https://openrouter.ai/docs/features/privacy-and-logging',
  },
};

/* Prices checked November 2026 (USD per million tokens). The live model list may add others. */
export const STATIC_MODELS: Record<ProviderId, ModelInfo[]> = {
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inPrice: 2, outPrice: 10, structured: true },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', inPrice: 4, outPrice: 20, structured: true },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', inPrice: 0.1, outPrice: 0.5, structured: true },
  ],
  openai: [],
  openrouter: [],
};

const ANTHROPIC_PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-1': [10, 50], 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10],
};

/* ------------------------------------------------------------------ */
/* Model lists                                                          */
/* ------------------------------------------------------------------ */

export async function listModels(provider: ProviderId, apiKey: string | null): Promise<ModelInfo[]> {
  if (provider === 'openrouter') {
    const r = await fetch('https://openrouter.ai/api/v1/models?supported_parameters=structured_outputs');
    if (!r.ok) throw new ProviderError(`Couldn't load OpenRouter models (${r.status}).`, r.status);
    const d = await r.json();
    return (d.data as any[])
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        inPrice: m.pricing?.prompt != null ? Number(m.pricing.prompt) * 1e6 : undefined,
        outPrice: m.pricing?.completion != null ? Number(m.pricing.completion) * 1e6 : undefined,
        structured: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (!apiKey) return STATIC_MODELS[provider];
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: anthropicHeaders(apiKey) });
    if (!r.ok) throw await toError(r, provider);
    const d = await r.json();
    return (d.data as any[]).map((m) => {
      const p = ANTHROPIC_PRICES[m.id];
      return { id: m.id, name: m.display_name ?? m.id, inPrice: p?.[0], outPrice: p?.[1], structured: true };
    });
  }
  const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!r.ok) throw await toError(r, provider);
  const d = await r.json();
  return (d.data as any[])
    .map((m) => m.id as string)
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct)/.test(id))
    .sort()
    .reverse()
    .map((id) => ({ id, name: id, structured: true }));
}

/* ------------------------------------------------------------------ */
/* Calls                                                                */
/* ------------------------------------------------------------------ */

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

async function toError(r: Response, provider: ProviderId): Promise<ProviderError> {
  let detail = '';
  try {
    const j = await r.json();
    detail = j?.error?.message ?? j?.message ?? JSON.stringify(j).slice(0, 300);
  } catch {
    detail = r.statusText;
  }
  const name = PROVIDERS[provider].label;
  const retryable = r.status === 429 || r.status === 529 || r.status >= 500;
  if (r.status === 401 || r.status === 403) return new ProviderError(`${name} rejected the API key: ${detail}`, r.status);
  if (r.status === 429) return new ProviderError(`${name} rate limit reached: ${detail}`, r.status, true);
  return new ProviderError(`${name} error ${r.status}: ${detail}`, r.status, retryable);
}

/** Read a server-sent-events stream, yielding each parsed JSON `data:` payload. */
async function* sse(r: Response): AsyncGenerator<any> {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch { /* comment or keep-alive */ }
    }
  }
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return `\n\nReturn ONLY a JSON object (no markdown fences, no prose) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

async function callAnthropic(o: CallOptions): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model: o.model,
    max_tokens: o.maxTokens,
    system: o.structured ? o.system : o.system + schemaInstruction(o.schema),
    messages: [{ role: 'user', content: o.user }],
    stream: true,
  };
  if (o.structured) body.output_config = { format: { type: 'json_schema', schema: o.schema } };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: anthropicHeaders(o.apiKey),
    body: JSON.stringify(body),
    signal: o.signal,
  });
  if (!r.ok) throw await toError(r, 'anthropic');
  let text = '';
  let input = 0;
  let output = 0;
  let stop = '';
  for await (const ev of sse(r)) {
    if (ev.type === 'message_start') {
      const u = ev.message?.usage ?? {};
      input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      text += ev.delta.text;
      o.onProgress?.(text.length);
    } else if (ev.type === 'message_delta') {
      output = ev.usage?.output_tokens ?? output;
      stop = ev.delta?.stop_reason ?? stop;
    } else if (ev.type === 'error') {
      const overloaded = ev.error?.type === 'overloaded_error';
      throw new ProviderError(`Anthropic error: ${ev.error?.message ?? 'stream error'}`, overloaded ? 529 : undefined, overloaded);
    }
  }
  return { text, inputTokens: input, outputTokens: output, stopReason: stop };
}

async function callOpenAICompatible(o: CallOptions): Promise<CallResult> {
  const isOR = o.provider === 'openrouter';
  const url = isOR ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const body: Record<string, unknown> = {
    model: o.model,
    messages: [
      { role: 'system', content: o.structured ? o.system : o.system + schemaInstruction(o.schema) },
      { role: 'user', content: o.user },
    ],
    stream: true,
  };
  if (o.structured) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'pardalote_annotations', strict: true, schema: o.schema } };
  } else {
    body.response_format = { type: 'json_object' };
  }
  if (isOR) {
    body.max_tokens = o.maxTokens;
    body.provider = { require_parameters: o.structured };
    body.usage = { include: true };
  } else {
    body.max_completion_tokens = o.maxTokens;
    body.stream_options = { include_usage: true };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${o.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (isOR) {
    headers['X-Title'] = 'Pardalote';
    if (location.origin.startsWith('http')) headers['HTTP-Referer'] = location.origin;
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal });
  if (!r.ok) throw await toError(r, o.provider);
  let text = '';
  let input = 0;
  let output = 0;
  let stop = '';
  for await (const ev of sse(r)) {
    if (ev.error) throw new ProviderError(`${PROVIDERS[o.provider].label} error: ${ev.error.message ?? JSON.stringify(ev.error)}`);
    const ch = ev.choices?.[0];
    if (ch?.delta?.content) {
      text += ch.delta.content;
      o.onProgress?.(text.length);
    }
    if (ch?.finish_reason) stop = ch.finish_reason;
    if (ev.usage) {
      input = ev.usage.prompt_tokens ?? input;
      output = ev.usage.completion_tokens ?? output;
    }
  }
  return { text, inputTokens: input, outputTokens: output, stopReason: stop === 'length' ? 'max_tokens' : stop };
}

export async function callModel(o: CallOptions): Promise<CallResult> {
  const fn = o.provider === 'anthropic' ? callAnthropic : callOpenAICompatible;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(o);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const retryable = e instanceof ProviderError ? e.retryable : e instanceof TypeError; // TypeError = network
      if (!retryable || attempt >= 2) {
        if (e instanceof TypeError) {
          throw new ProviderError(`Couldn't reach ${PROVIDERS[o.provider].label}. Check your connection (or an ad blocker) and try again.`);
        }
        throw e;
      }
      attempt++;
      await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
    }
  }
}

export function priceFor(models: ModelInfo[], id: string): { inPrice?: number; outPrice?: number } {
  const m = models.find((x) => x.id === id);
  if (m) return m;
  const p = ANTHROPIC_PRICES[id];
  return p ? { inPrice: p[0], outPrice: p[1] } : {};
}
