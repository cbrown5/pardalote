import { anchorAnnotations } from './anchor';
import { buildSystemPrompt, type PromptSections } from './prompt';
import { callModel, type ProviderId } from './providers';
import { responseSchema, validateResponse, extractJson, ValidationError } from './schema';
import { formatForModel } from './segment';
import type { AnalysisResult, Block, ManuscriptSummary, Mode, Paragraph, ParagraphTopic, RawAnnotation, SegmentedDoc } from './types';

export interface Batch {
  blocks: Block[]; // may start with a context paragraph
  contextIds: Set<string>;
  targetIds: Set<string>; // paragraph IDs the model may annotate
}

const LIMITS: Record<Mode, { unit: 'sentence' | 'paragraph'; max: number }> = {
  sentence: { unit: 'sentence', max: 40 },
  paragraph: { unit: 'paragraph', max: 14 },
  manuscript: { unit: 'paragraph', max: Infinity },
};

/** Group the document into batches of whole paragraphs, preferring to break at headings. */
export function makeBatches(doc: SegmentedDoc, mode: Mode): Batch[] {
  const { unit, max } = LIMITS[mode];
  const batches: Batch[] = [];
  let cur: Block[] = [];
  let size = 0;
  let lastPara: Paragraph | null = null;
  let prevBatchLastPara: Paragraph | null = null;

  const flush = () => {
    const paras = cur.filter((b): b is Paragraph => b.kind === 'paragraph');
    if (paras.length) {
      const contextIds = new Set<string>();
      const blocks = [...cur];
      if (prevBatchLastPara && mode !== 'manuscript') {
        blocks.unshift(prevBatchLastPara);
        contextIds.add(prevBatchLastPara.id);
      }
      batches.push({ blocks, contextIds, targetIds: new Set(paras.map((p) => p.id)) });
      prevBatchLastPara = paras[paras.length - 1];
    }
    cur = [];
    size = 0;
  };

  for (const b of doc.blocks) {
    if (b.kind === 'heading') {
      // Break at a heading once the batch is reasonably full, so batches follow sections.
      if (size >= max / 2) flush();
      cur.push(b);
      continue;
    }
    const n = unit === 'sentence' ? b.sentences.length : 1;
    if (size > 0 && size + n > max) {
      // Keep a trailing heading with the paragraph it introduces.
      const trailing: Block[] = [];
      while (cur.length && cur[cur.length - 1].kind === 'heading') trailing.unshift(cur.pop()!);
      flush();
      cur.push(...trailing);
    }
    cur.push(b);
    size += n;
    lastPara = b;
  }
  flush();
  void lastPara;
  return batches;
}

export function estimate(doc: SegmentedDoc, mode: Mode, systemPrompt: string, inPrice?: number, outPrice?: number) {
  const batches = makeBatches(doc, mode);
  // Calibrated against live runs (Nov 2026); errs slightly high.
  const sysTokens = systemPrompt.length / 3.6 + JSON.stringify(responseSchema(mode)).length / 3 + 1500;
  let input = 0;
  for (const b of batches) input += sysTokens + formatForModel(b.blocks, { contextIds: b.contextIds }).length / 3.4;
  const nSent = doc.paragraphs.reduce((s, p) => s + p.sentences.length, 0);
  const nPara = doc.paragraphs.length;
  const output = mode === 'sentence' ? nSent * 300 : mode === 'paragraph' ? nPara * 420 + 300 : 3500 + nPara * 300;
  const cost = inPrice != null && outPrice != null ? (input * inPrice + output * outPrice) / 1e6 : null;
  return { batches: batches.length, input: Math.round(input), output: Math.round(output), cost };
}

export interface RunOptions {
  doc: SegmentedDoc;
  mode: Mode;
  prompt: PromptSections;
  provider: ProviderId;
  apiKey: string;
  model: string;
  structured: boolean;
  inPrice?: number;
  outPrice?: number;
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (p: { done: number; total: number; streamedChars: number }) => void;
}

interface BatchOut {
  annotations: RawAnnotation[];
  topics: ParagraphTopic[];
  summary: ManuscriptSummary | null;
  warnings: string[];
  input: number;
  output: number;
}

const MAX_TOKENS: Record<Mode, number> = { sentence: 24000, paragraph: 16000, manuscript: 16000 };

async function runBatch(o: RunOptions, batch: Batch, system: string, onChars: (n: number) => void): Promise<BatchOut> {
  const schema = responseSchema(o.mode);
  const intro =
    o.mode === 'manuscript'
      ? 'Here is the manuscript.'
      : batch.contextIds.size
        ? 'Here is the text. The first paragraph is context only: use it to judge the hand-off into the next paragraph, but do not annotate it.'
        : 'Here is the text.';
  const text = formatForModel(batch.blocks, { contextIds: batch.contextIds });
  let user = `${intro}\n\n${text}`;
  let input = 0;
  let output = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callModel({
      provider: o.provider, apiKey: o.apiKey, model: o.model, system, user, schema,
      structured: o.structured, maxTokens: MAX_TOKENS[o.mode], signal: o.signal, onProgress: onChars,
    });
    input += res.inputTokens;
    output += res.outputTokens;
    if (res.stopReason === 'max_tokens') {
      const paras = batch.blocks.filter((b): b is Paragraph => b.kind === 'paragraph' && !batch.contextIds.has(b.id));
      if (paras.length > 1 && o.mode !== 'manuscript') {
        // Too much output for one call: split the batch in half and run both halves.
        const mid = Math.ceil(paras.length / 2);
        const halves = [paras.slice(0, mid), paras.slice(mid)].map((ps, i): Batch => {
          const ctx = i === 0 ? [...batch.contextIds] : [paras[mid - 1].id];
          const ctxBlocks = ctx.map((id) => o.doc.byId.get(id) as Paragraph).filter(Boolean);
          return { blocks: [...ctxBlocks, ...ps], contextIds: new Set(ctx), targetIds: new Set(ps.map((p) => p.id)) };
        });
        const outs = [];
        for (const h of halves) outs.push(await runBatch(o, h, system, onChars));
        return {
          annotations: outs.flatMap((x) => x.annotations),
          topics: outs.flatMap((x) => x.topics),
          summary: null,
          warnings: outs.flatMap((x) => x.warnings),
          input: input + outs.reduce((s, x) => s + x.input, 0),
          output: output + outs.reduce((s, x) => s + x.output, 0),
        };
      }
      throw new Error('The model ran out of output space before finishing. Try a shorter text or a model with a larger output limit.');
    }
    if (res.stopReason === 'refusal') throw new Error('The model declined to analyse this text.');
    try {
      const parsed = validateResponse(extractJson(res.text), o.mode);
      // Drop anything aimed at context-only paragraphs.
      const inBatch = (id: string) => {
        const pid = id.split('.')[0];
        return !batch.contextIds.has(pid);
      };
      return {
        annotations: parsed.annotations.filter((a) => inBatch(a.target_id)),
        topics: parsed.topics.filter((t) => batch.targetIds.has(t.paragraph_id)),
        summary: parsed.summary,
        warnings: parsed.warnings,
        input,
        output,
      };
    } catch (e) {
      if (!(e instanceof ValidationError) || attempt === 1) throw e;
      user = `${intro}\n\n${text}\n\nYour previous reply could not be used: ${e.message} Return only a JSON object that matches the schema.`;
    }
  }
  throw new Error('unreachable');
}

export async function runAnalysis(o: RunOptions): Promise<AnalysisResult> {
  const system = buildSystemPrompt(o.prompt, o.mode);
  const batches = makeBatches(o.doc, o.mode);
  const chars = new Array(batches.length).fill(0);
  let done = 0;
  const report = () => o.onProgress?.({ done, total: batches.length, streamedChars: chars.reduce((a, b) => a + b, 0) });
  report();

  const results: BatchOut[] = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      results[i] = await runBatch(o, batches[i], system, (n) => { chars[i] = n; report(); });
      done++;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 3, batches.length) }, worker));

  const raw = results.flatMap((r) => r.annotations);
  const annotations = anchorAnnotations(raw, o.doc);
  // Document order: by paragraph, then position.
  const order = new Map(o.doc.paragraphs.map((p, i) => [p.id, i]));
  annotations.sort((a, b) =>
    (order.get(a.paragraphId ?? '') ?? 1e9) - (order.get(b.paragraphId ?? '') ?? 1e9) ||
    (a.start ?? 1e9) - (b.start ?? 1e9) || (b.end ?? 0) - (a.end ?? 0));

  const input = results.reduce((s, r) => s + r.input, 0);
  const output = results.reduce((s, r) => s + r.output, 0);
  const cost = o.inPrice != null && o.outPrice != null ? (input * o.inPrice + output * o.outPrice) / 1e6 : null;
  const warnings = results.flatMap((r) => r.warnings);
  const unanchored = annotations.filter((a) => a.start == null).length;
  if (unanchored) warnings.push(`${unanchored} finding(s) couldn't be placed in the text; they're listed at the end of the findings panel.`);
  return {
    mode: o.mode,
    annotations,
    topics: results.flatMap((r) => r.topics),
    summary: results.find((r) => r.summary)?.summary ?? null,
    warnings,
    usage: { input, output, cost },
  };
}
