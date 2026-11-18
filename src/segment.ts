import type { Block, Paragraph, RawBlock, SegmentedDoc, Sentence } from './types';

/* ------------------------------------------------------------------ */
/* Plain text → raw blocks                                              */
/* ------------------------------------------------------------------ */

const SECTION_NAMES = [
  'abstract', 'summary', 'introduction', 'background', 'methods', 'method', 'methodology',
  'materials and methods', 'methods and materials', 'material and methods', 'experimental',
  'experimental procedures', 'results', 'results and discussion', 'discussion', 'conclusion',
  'conclusions', 'acknowledgements', 'acknowledgments', 'references', 'literature cited',
  'bibliography', 'supplementary material', 'supporting information', 'appendix',
  'data availability', 'author contributions', 'funding', 'limitations', 'study area',
  'study site', 'statistical analysis', 'statistical analyses', 'keywords',
];

function isHeadingLine(line: string): { level: number; text: string } | null {
  const md = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (md) return { level: md[1].length, text: md[2] };
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 90) return null;
  // "2. Methods", "2.1 Study site", "II. RESULTS"
  const numbered = /^((?:\d+\.)*\d+\.?|[IVX]+\.)\s+([A-Z][^.!?]*)$/.exec(trimmed);
  if (numbered && numbered[2].split(/\s+/).length <= 10) {
    const depth = numbered[1].replace(/\.$/, '').split('.').length;
    return { level: Math.min(depth + 1, 6), text: trimmed };
  }
  const bare = trimmed.replace(/[:.]$/, '').toLowerCase();
  if (SECTION_NAMES.includes(bare)) return { level: 2, text: trimmed.replace(/[:.]$/, '') };
  return null;
}

/**
 * Turn pasted text into blocks. If the text uses blank lines between
 * paragraphs, single newlines inside a paragraph are treated as soft wraps.
 * Otherwise each non-empty line is its own paragraph (typical of text
 * pasted from Word).
 */
export function parsePlainText(input: string): RawBlock[] {
  const text = input.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const hasBlankLines = /\n[ \t]*\n/.test(text.trim());
  const blocks: RawBlock[] = [];
  const pushPara = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ kind: 'paragraph', text: t });
  };

  if (hasBlankLines) {
    for (const chunk of text.split(/\n[ \t]*\n/)) {
      const lines = chunk.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      // A heading may sit directly above its first paragraph.
      const h = isHeadingLine(lines[0]);
      if (h) {
        blocks.push({ kind: 'heading', level: h.level, text: h.text });
        pushPara(lines.slice(1).join(' '));
      } else {
        pushPara(lines.join(' '));
      }
    }
  } else {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const h = isHeadingLine(line);
      if (h) blocks.push({ kind: 'heading', level: h.level, text: h.text });
      else pushPara(line);
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Sentence splitting                                                   */
/* ------------------------------------------------------------------ */

// Abbreviations that end in a full stop but rarely end a sentence.
const GUARD = new Set(
  [
    'et al', 'fig', 'figs', 'e.g', 'i.e', 'approx', 'vs', 'cf', 'eq', 'eqs', 'ref', 'refs', 'no',
    'nos', 'dr', 'prof', 'ca', 'resp', 'spp', 'sp', 'subsp', 'var', 'tab', 'suppl', 'sect',
    'ch', 'pp', 'vol', 'mr', 'ms', 'mrs', 'st', 'viz', 'al', 'est', 'inc', 'ltd', 'co', 'corp',
    'dept', 'univ', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
    'nov', 'dec', 'approx', 'max', 'min', 'avg', 'std', 'sd', 'n.b', 'p.s',
  ].map((s) => s.toLowerCase()),
);
// Abbreviations that may or may not end a sentence: merge only if the next piece starts lowercase or with a digit.
const SOFT_GUARD = new Set(['etc', 'al', 'resp', 'min', 'max']);

let segmenter: Intl.Segmenter | null = null;
function getSegmenter(): Intl.Segmenter {
  if (!segmenter) segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return segmenter;
}

function lastToken(piece: string): string {
  const m = /([A-Za-z][A-Za-z.]*)\.\s*$/.exec(piece.trimEnd());
  return m ? m[1].toLowerCase() : '';
}

function shouldMerge(prev: string, next: string): boolean {
  const p = prev.trimEnd();
  const n = next.trimStart();
  if (!n) return true;
  // The next piece starts like a continuation, not a new sentence.
  if (/^[a-z0-9(\[,;:%)]/.test(n)) return true;
  if (!p.endsWith('.')) return false;
  const tok = lastToken(p);
  if (!tok) return false;
  if (SOFT_GUARD.has(tok)) return /^[a-z0-9]/.test(n);
  if (GUARD.has(tok) || GUARD.has(tok.replace(/\.$/, ''))) return true;
  // "et al." written as the last two words
  if (/\bet al\.$/i.test(p)) return true;
  // Single capital initial: "E. coli", "J. Smith"
  if (/(^|[\s(])[A-Z]\.$/.test(p)) return true;
  // Dotted abbreviations: "U.S.", "e.g."
  if (/(^|\s)([A-Za-z]\.){2,}$/.test(p)) return true;
  return false;
}

/** Split a paragraph into sentences, returning offsets into `text`. */
export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const pieces: { start: number; end: number }[] = [];
  for (const seg of getSegmenter().segment(text)) {
    pieces.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  const merged: { start: number; end: number }[] = [];
  for (const piece of pieces) {
    const prev = merged[merged.length - 1];
    if (prev && shouldMerge(text.slice(prev.start, prev.end), text.slice(piece.start, piece.end))) {
      prev.end = piece.end;
    } else {
      merged.push({ ...piece });
    }
  }
  const out: { text: string; start: number; end: number }[] = [];
  for (const m of merged) {
    let s = m.start;
    let e = m.end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ text: text.slice(s, e), start: s, end: e });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Raw blocks → numbered document                                       */
/* ------------------------------------------------------------------ */

export function segment(raw: RawBlock[]): SegmentedDoc {
  const blocks: Block[] = [];
  const paragraphs: Paragraph[] = [];
  const byId = new Map<string, Paragraph | Sentence>();
  const parentOf = new Map<string, Paragraph>();
  let section = '';
  let pn = 0;
  for (const b of raw) {
    if (b.kind === 'heading') {
      section = b.text;
      blocks.push({ kind: 'heading', level: b.level ?? 2, text: b.text });
      continue;
    }
    pn++;
    const id = `P${pn}`;
    const sentences: Sentence[] = splitSentences(b.text).map((s, i) => ({
      id: `${id}.S${i + 1}`,
      ...s,
    }));
    const para: Paragraph = { kind: 'paragraph', id, text: b.text, sentences, section };
    blocks.push(para);
    paragraphs.push(para);
    byId.set(id, para);
    for (const s of sentences) {
      byId.set(s.id, s);
      parentOf.set(s.id, para);
    }
  }
  return { blocks, paragraphs, byId, parentOf };
}

/* ------------------------------------------------------------------ */
/* Numbered text for the model                                          */
/* ------------------------------------------------------------------ */

function firstWords(text: string, n = 8): string {
  const words = text.split(/\s+/);
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '');
}

/**
 * Format blocks as the model sees them. `contextIds` are paragraphs included
 * for reference only (they are marked so the model doesn't annotate them).
 */
export function formatForModel(
  blocks: Block[],
  opts: { contextIds?: Set<string>; sentenceLevel?: boolean } = {},
): string {
  const lines: string[] = [];
  const sentenceLevel = opts.sentenceLevel ?? true;
  for (const b of blocks) {
    if (b.kind === 'heading') {
      lines.push('', `[H${b.level}] ${b.text}`, '');
      continue;
    }
    const isContext = opts.contextIds?.has(b.id);
    lines.push(`[${b.id}] (${firstWords(b.text)})${isContext ? ' [CONTEXT ONLY: do not annotate]' : ''}`);
    if (sentenceLevel) {
      for (const s of b.sentences) lines.push(`[${s.id}] ${s.text}`);
    } else {
      lines.push(b.text);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function wordCount(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}
