import type { Annotation, Paragraph, RawAnnotation, SegmentedDoc } from './types';

/* ------------------------------------------------------------------ */
/* Normalisation with an index map back to the original string          */
/* ------------------------------------------------------------------ */

interface Normalised {
  text: string;
  /** map[i] = index in the original string of normalised char i */
  map: number[];
}

const CHAR_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '″': '"',
  '–': '-', '—': '-', '‒': '-', '−': '-', '‐': '-', '‑': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', '…': '...',
};

function normalise(s: string): Normalised {
  let text = '';
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    let ch = CHAR_MAP[s[i]] ?? s[i];
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      ch = ' ';
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    for (const c of ch.toLowerCase()) {
      text += c;
      map.push(i);
    }
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); map.pop(); }
  return { text, map };
}

function trimQuote(q: string): string {
  return q.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/^…|…$/g, '').replace(/^\.\.\.|\.\.\.$/g, '').trim();
}

/* ------------------------------------------------------------------ */
/* Fuzzy word-window match                                              */
/* ------------------------------------------------------------------ */

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyFind(hay: string, needle: string): { start: number; end: number } | null {
  const n = normalise(needle).text;
  const words: { s: number; e: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay))) words.push({ s: m.index, e: m.index + m[0].length });
  const qWords = n.split(' ').length;
  if (!qWords || !words.length || n.length < 4) return null;
  let best: { start: number; end: number; score: number } | null = null;
  for (let len = Math.max(1, qWords - 2); len <= qWords + 2; len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const start = words[i].s;
      const end = words[i + len - 1].e;
      const cand = normalise(hay.slice(start, end)).text;
      const score = 1 - levenshtein(cand, n) / Math.max(cand.length, n.length);
      if (!best || score > best.score) best = { start, end, score };
    }
  }
  if (best && best.score >= 0.8) {
    // Trim trailing punctuation the quote didn't include.
    let { start, end } = best;
    while (end > start && /[,;:.]/.test(hay[end - 1]) && !/[,;:.]$/.test(needle.trim())) end--;
    return { start, end };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Locate a quote inside a string                                        */
/* ------------------------------------------------------------------ */

type Found = { start: number; end: number; method: 'exact' | 'normalised' | 'fuzzy' };

export function findQuote(hay: string, quote: string): Found | null {
  const q = quote.trim();
  if (!q) return null;
  let i = hay.indexOf(q);
  if (i >= 0) return { start: i, end: i + q.length, method: 'exact' };
  const tq = trimQuote(q);
  if (tq && tq !== q) {
    i = hay.indexOf(tq);
    if (i >= 0) return { start: i, end: i + tq.length, method: 'exact' };
  }
  const H = normalise(hay);
  const N = normalise(tq || q);
  if (N.text) {
    const j = H.text.indexOf(N.text);
    if (j >= 0) {
      return { start: H.map[j], end: H.map[j + N.text.length - 1] + 1, method: 'normalised' };
    }
  }
  const f = fuzzyFind(hay, tq || q);
  return f ? { ...f, method: 'fuzzy' } : null;
}

/* ------------------------------------------------------------------ */
/* Resolve annotations against the segmented document                   */
/* ------------------------------------------------------------------ */

let uidCounter = 0;

export function anchorAnnotations(raw: RawAnnotation[], doc: SegmentedDoc): Annotation[] {
  const out: Annotation[] = [];
  for (const r of raw) {
    const base = { ...r, uid: ++uidCounter };
    const target = doc.byId.get(r.target_id);
    const quote = r.quote ?? '';

    if (target) {
      const isSentence = !('sentences' in target);
      const para: Paragraph = isSentence ? doc.parentOf.get(r.target_id)! : (target as Paragraph);
      const offset = isSentence ? target.start : 0;
      if (!quote.trim()) {
        out.push({ ...base, paragraphId: para.id, start: offset, end: offset + target.text.length, anchorMethod: 'whole' });
        continue;
      }
      // Inside the target unit first, then the whole paragraph (the model got the sentence number wrong).
      const inUnit = findQuote(target.text, quote);
      if (inUnit) {
        out.push({ ...base, paragraphId: para.id, start: offset + inUnit.start, end: offset + inUnit.end, anchorMethod: inUnit.method });
        continue;
      }
      if (isSentence) {
        const inPara = findQuote(para.text, quote);
        if (inPara) {
          out.push({ ...base, paragraphId: para.id, start: inPara.start, end: inPara.end, anchorMethod: 'relocated' });
          continue;
        }
      }
    }

    // Unknown ID, or quote not where it was said to be: look for a unique exact/normalised match anywhere.
    if (quote.trim().length >= 8) {
      const hits: { para: Paragraph; f: Found }[] = [];
      for (const p of doc.paragraphs) {
        const f = findQuote(p.text, quote);
        if (f && f.method !== 'fuzzy') hits.push({ para: p, f });
        if (hits.length > 1) break;
      }
      if (hits.length === 1) {
        const { para, f } = hits[0];
        out.push({ ...base, paragraphId: para.id, start: f.start, end: f.end, anchorMethod: 'relocated' });
        continue;
      }
    }
    // Paragraph ID valid but quote lost: keep the paragraph so it still shows in context.
    const pid = target ? ('sentences' in target ? target.id : doc.parentOf.get(r.target_id)?.id ?? null) : null;
    out.push({ ...base, paragraphId: pid, start: null, end: null, anchorMethod: 'none' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Flatten overlapping spans into segments                               */
/* ------------------------------------------------------------------ */

export interface Segment {
  start: number;
  end: number;
  /** Covering annotations, outermost (longest) first. */
  covers: Annotation[];
}

export function flatten(text: string, anns: Annotation[]): Segment[] {
  const spans = anns.filter((a) => a.start != null && a.end != null && a.end > a.start);
  const cuts = new Set<number>([0, text.length]);
  for (const a of spans) { cuts.add(a.start!); cuts.add(a.end!); }
  const pts = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((x, y) => x - y);
  const segs: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    if (e <= s) continue;
    const covers = spans
      .filter((a) => a.start! <= s && a.end! >= e)
      .sort((x, y) => (y.end! - y.start!) - (x.end! - x.start!) || x.uid - y.uid);
    segs.push({ start: s, end: e, covers });
  }
  return segs;
}
