import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePlainText, segment, splitSentences, formatForModel } from '../src/segment';
import { findQuote, anchorAnnotations, flatten } from '../src/anchor';
import { parsePromptFile, buildSystemPrompt, checkCategories } from '../src/prompt';
import { validateResponse, extractJson, responseSchema, ValidationError } from '../src/schema';
import { makeBatches } from '../src/analyse';
import type { RawAnnotation } from '../src/types';

const sample = readFileSync(new URL('./fixtures/sample.md', import.meta.url), 'utf8');
const promptMd = readFileSync(new URL('../public/system-prompt.md', import.meta.url), 'utf8');

describe('sentence splitting', () => {
  it('keeps scientific abbreviations inside sentences', () => {
    const t = 'Smith et al. (2020) found this in E. coli cultures, e.g. strain K-12. See Fig. 2 for details. Values were approx. 3.5 mg per L vs. 2.1 in controls. A new sentence starts here.';
    const s = splitSentences(t).map((x) => x.text);
    expect(s).toEqual([
      'Smith et al. (2020) found this in E. coli cultures, e.g. strain K-12.',
      'See Fig. 2 for details.',
      'Values were approx. 3.5 mg per L vs. 2.1 in controls.',
      'A new sentence starts here.',
    ]);
  });
  it('splits after "etc." when a capitalised sentence follows', () => {
    const s = splitSentences('We used sand, gravel, etc. The media were mixed.').map((x) => x.text);
    expect(s).toHaveLength(2);
  });
  it('returns offsets that slice back to the sentence', () => {
    const t = 'First one.  Second (Walsh et al., 2005) one! Third?';
    for (const s of splitSentences(t)) expect(t.slice(s.start, s.end)).toBe(s.text);
  });
});

describe('segmentation', () => {
  const doc = segment(parsePlainText(sample));
  it('finds headings and numbers paragraphs', () => {
    expect(doc.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual(['Introduction', 'Methods', 'Results', 'Discussion']);
    expect(doc.paragraphs.length).toBe(10);
    expect(doc.paragraphs[0].sentences.length).toBe(3);
    expect(doc.paragraphs[3].section).toBe('Methods');
  });
  it('treats single-newline text as one paragraph per line', () => {
    const d = segment(parsePlainText('Introduction\nFirst para. Two sentences.\nSecond para.'));
    expect(d.paragraphs.map((p) => p.id)).toEqual(['P1', 'P2']);
    expect(d.blocks[0].kind).toBe('heading');
  });
  it('formats numbered text with heading markers', () => {
    const txt = formatForModel(doc.blocks.slice(0, 3));
    expect(txt).toContain('[H1] Introduction');
    expect(txt).toContain('[P1.S2] In many cities');
  });
});

describe('anchoring', () => {
  const doc = segment(parsePlainText(sample));
  const mk = (target_id: string, quote: string): RawAnnotation => ({
    target_id, quote, category: 'nominalisation', kind: 'issue', severity: 'minor',
    diagnosis: '', why_it_matters: '', suggestion: '', links: [],
  });
  it('anchors exact, normalised, fuzzy, whole and relocated quotes', () => {
    const anns = anchorAnnotations([
      mk('P1.S2', 'the installation of raingardens'),
      mk('P1.S2', 'The   Installation of raingardens'),
      mk('P1.S2', 'the instalation of raingardens has been undertaken'),
      mk('P1.S3', ''),
      mk('P1.S1', 'the reduction of these pollutant loads'),
      mk('P99', 'evidence from field installations in subtropical cities'),
      mk('P1.S1', 'words that are not there at all anywhere'),
    ], doc);
    const p1 = doc.paragraphs[0].text;
    expect(p1.slice(anns[0].start!, anns[0].end!)).toBe('the installation of raingardens');
    expect(anns[1].anchorMethod).toBe('normalised');
    expect(anns[2].anchorMethod).toBe('fuzzy');
    expect(p1.slice(anns[2].start!, anns[2].end!)).toBe('the installation of raingardens has been undertaken');
    expect(anns[3].anchorMethod).toBe('whole');
    expect(p1.slice(anns[3].start!, anns[3].end!)).toBe(doc.paragraphs[0].sentences[2].text);
    expect(anns[4].anchorMethod).toBe('relocated');
    expect(anns[5].paragraphId).toBe('P1');
    expect(anns[6].anchorMethod).toBe('none');
  });
  it('handles curly quotes and dashes', () => {
    expect(findQuote('the “raingarden” effect—large', '"raingarden" effect-large')?.method).toBe('normalised');
  });
  it('flattens nested spans into segments, outermost first', () => {
    const anns = anchorAnnotations([mk('P1.S1', 'Urban streams receive stormwater runoff'), mk('P1.S1', 'Urban streams')], doc);
    const segs = flatten(doc.paragraphs[0].text, anns);
    expect(segs[0].covers.map((a) => a.quote)).toEqual(['Urban streams receive stormwater runoff', 'Urban streams']);
    expect(segs[1].covers).toHaveLength(1);
    expect(segs.map((s) => doc.paragraphs[0].text.slice(s.start, s.end)).join('')).toBe(doc.paragraphs[0].text);
  });
});

describe('prompt file', () => {
  const sections = parsePromptFile(promptMd);
  it('has all sections and builds per mode', () => {
    const sys = buildSystemPrompt(sections, 'paragraph');
    expect(sys).toContain('Mode: paragraph flow');
    expect(sys).not.toContain('Mode: sentence construction');
    expect(sys).toContain('## Output');
  });
  it('mentions every schema category and nothing extra', () => {
    expect(checkCategories(sections)).toEqual([]);
  });
  it('rejects a file without markers', () => {
    expect(() => parsePromptFile('# nothing')).toThrow(/missing/);
  });
});

describe('schema validation', () => {
  it('normalises casing, drops unknown categories, caps suggestions', () => {
    const r = validateResponse({
      annotations: [
        { target_id: 'p1.s1', quote: 'x', category: 'Nominalisation', kind: 'Issue', severity: 'Major', diagnosis: 'd', why_it_matters: 'w', suggestion: 'a'.repeat(400), links: ['p2'] },
        { target_id: 'P1.S1', quote: 'x', category: 'made_up', kind: 'issue', severity: 'minor', diagnosis: '', why_it_matters: '', suggestion: '', links: [] },
      ],
    }, 'sentence');
    expect(r.annotations).toHaveLength(1);
    expect(r.annotations[0]).toMatchObject({ target_id: 'P1.S1', category: 'nominalisation', kind: 'issue', severity: 'major', links: ['P2'] });
    expect(r.annotations[0].suggestion.length).toBeLessThanOrEqual(280);
    expect(r.warnings[0]).toMatch(/1 finding/);
  });
  it('throws on a missing top-level field', () => {
    expect(() => validateResponse({ annotations: [] }, 'manuscript')).toThrow(ValidationError);
  });
  it('extracts JSON from fenced replies', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
  });
  it('closes every object in the schema (needed for strict mode)', () => {
    const walk = (s: any): void => {
      if (s && typeof s === 'object') {
        if (s.type === 'object') {
          expect(s.additionalProperties).toBe(false);
          expect(new Set(s.required)).toEqual(new Set(Object.keys(s.properties)));
        }
        Object.values(s).forEach(walk);
      }
    };
    (['sentence', 'paragraph', 'manuscript'] as const).forEach((m) => walk(responseSchema(m)));
  });
});

describe('batching', () => {
  const doc = segment(parsePlainText(sample));
  it('keeps manuscript mode in one batch', () => {
    expect(makeBatches(doc, 'manuscript')).toHaveLength(1);
  });
  it('splits sentence mode at about 40 sentences with a context paragraph', () => {
    const big = segment(parsePlainText(Array.from({ length: 30 }, (_, i) => `Para ${i} one. Two here. Three here.`).join('\n\n')));
    const bs = makeBatches(big, 'sentence');
    expect(bs.length).toBeGreaterThan(1);
    for (const b of bs) {
      const n = b.blocks.filter((x) => x.kind === 'paragraph' && b.targetIds.has(x.id)).reduce((s, p: any) => s + p.sentences.length, 0);
      expect(n).toBeLessThanOrEqual(40);
    }
    expect(bs[1].contextIds.size).toBe(1);
    const all = bs.flatMap((b) => [...b.targetIds]);
    expect(new Set(all).size).toBe(30);
  });
});
