import type {
  Kind, ManuscriptSummary, Mode, ParagraphTopic, RawAnnotation, Severity,
} from './types';

/* If you add or rename a category, also describe it in public/system-prompt.md. */
export const CATEGORIES: Record<Mode, string[]> = {
  sentence: [
    'main_clause', 'subordinate_clause', 'subject', 'verb', 'object',
    'left_branching', 'long_sv_gap', 'nominalisation', 'passive', 'given_new_violation',
    'garden_path', 'metadiscourse', 'hedge_stack', 'unexplained_term', 'noun_stack',
    'dangling_modifier', 'unclear_reference', 'needs_example', 'heavy_late_ok', 'other',
  ],
  paragraph: [
    'topic_sentence', 'missing_topic_sentence', 'off_topic', 'transition_strong',
    'transition_weak', 'paragraph_split_candidate', 'merge_candidate',
    'topic_string_break', 'logic_gap', 'naming_inconsistency', 'wrong_connective', 'missing_connective',
    'other',
  ],
  manuscript: [
    'aim', 'aim_addressed', 'aim_unaddressed', 'intro_setup_unused', 'discussion_new_idea',
    'logic_stub', 'claim_unsupported', 'terminology_drift', 'number_inconsistency',
    'aim_unanswered', 'title_abstract_mismatch', 'other',
  ],
};

export type Group = 'structure' | 'issue' | 'strength';

export interface CategoryMeta {
  label: string;
  group: Group; // default family, used for the legend
  color: string;
}

/* Colour families: blues/purples for structure, warm hues for issues, green for strengths.
   The underline style (solid/wavy/double) is the second cue, so colour is never the only signal. */
export const META: Record<string, CategoryMeta> = {
  main_clause: { label: 'Main clause', group: 'structure', color: '#2563eb' },
  subordinate_clause: { label: 'Subordinate clause', group: 'structure', color: '#8b5cf6' },
  subject: { label: 'Subject', group: 'structure', color: '#0891b2' },
  verb: { label: 'Verb', group: 'structure', color: '#0d9488' },
  object: { label: 'Object', group: 'structure', color: '#4f46e5' },
  left_branching: { label: 'Left-branching', group: 'issue', color: '#ea580c' },
  long_sv_gap: { label: 'Long subject–verb gap', group: 'issue', color: '#d97706' },
  nominalisation: { label: 'Nominalisation', group: 'issue', color: '#dc2626' },
  passive: { label: 'Passive', group: 'issue', color: '#b45309' },
  given_new_violation: { label: 'New before given', group: 'issue', color: '#db2777' },
  garden_path: { label: 'Garden path', group: 'issue', color: '#be123c' },
  metadiscourse: { label: 'Metadiscourse', group: 'issue', color: '#78716c' },
  hedge_stack: { label: 'Stacked hedges', group: 'issue', color: '#a16207' },
  unexplained_term: { label: 'Unexplained term', group: 'issue', color: '#c2410c' },
  noun_stack: { label: 'Noun stack', group: 'issue', color: '#9a3412' },
  dangling_modifier: { label: 'Dangling modifier', group: 'issue', color: '#e11d48' },
  unclear_reference: { label: 'Unclear reference', group: 'issue', color: '#f59e0b' },
  needs_example: { label: 'Needs an example', group: 'issue', color: '#a8a29e' },
  heavy_late_ok: { label: 'Heavy phrase last', group: 'strength', color: '#16a34a' },

  topic_sentence: { label: 'Topic sentence', group: 'structure', color: '#2563eb' },
  missing_topic_sentence: { label: 'Missing topic sentence', group: 'issue', color: '#dc2626' },
  off_topic: { label: 'Off topic', group: 'issue', color: '#ea580c' },
  transition_strong: { label: 'Strong transition', group: 'strength', color: '#16a34a' },
  transition_weak: { label: 'Weak transition', group: 'issue', color: '#d97706' },
  paragraph_split_candidate: { label: 'Could split here', group: 'issue', color: '#db2777' },
  merge_candidate: { label: 'Could merge', group: 'issue', color: '#8b5cf6' },
  topic_string_break: { label: 'Focus shifts', group: 'issue', color: '#be123c' },
  logic_gap: { label: 'Skipped step', group: 'issue', color: '#b45309' },
  naming_inconsistency: { label: 'Inconsistent naming', group: 'issue', color: '#a16207' },
  wrong_connective: { label: 'Wrong connective', group: 'issue', color: '#c2410c' },
  missing_connective: { label: 'Missing connective', group: 'issue', color: '#78716c' },

  aim: { label: 'Aim', group: 'structure', color: '#2563eb' },
  aim_addressed: { label: 'Aim addressed', group: 'structure', color: '#0891b2' },
  aim_unaddressed: { label: 'Aim not addressed', group: 'issue', color: '#dc2626' },
  intro_setup_unused: { label: 'Unused set-up', group: 'issue', color: '#ea580c' },
  discussion_new_idea: { label: 'New idea in discussion', group: 'issue', color: '#db2777' },
  logic_stub: { label: 'Unfinished argument', group: 'issue', color: '#d97706' },
  claim_unsupported: { label: 'Unsupported claim', group: 'issue', color: '#be123c' },
  terminology_drift: { label: 'Terminology drift', group: 'issue', color: '#8b5cf6' },
  number_inconsistency: { label: 'Numbers disagree', group: 'issue', color: '#dc2626' },
  aim_unanswered: { label: 'Aim not answered', group: 'issue', color: '#e11d48' },
  title_abstract_mismatch: { label: 'Title/abstract mismatch', group: 'issue', color: '#c2410c' },

  other: { label: 'Other', group: 'issue', color: '#64748b' },
};

/* ------------------------------------------------------------------ */
/* JSON Schema sent to the provider                                     */
/* Every property is required and every object closed, which both       */
/* Anthropic and OpenAI strict mode need. No length keywords: not all    */
/* providers support them, so limits live in the prompt and validator.   */
/* ------------------------------------------------------------------ */

function annotationSchema(mode: Mode) {
  return {
    type: 'object',
    properties: {
      target_id: { type: 'string', description: 'Sentence ID (P3.S2) or paragraph ID (P3)' },
      quote: { type: 'string', description: 'Exact words from the target, or empty for the whole unit' },
      category: { type: 'string', enum: CATEGORIES[mode] },
      kind: { type: 'string', enum: ['structure', 'issue', 'strength'] },
      severity: { type: 'string', enum: ['info', 'minor', 'major'] },
      diagnosis: { type: 'string' },
      why_it_matters: { type: 'string' },
      suggestion: { type: 'string', description: 'A move, not a rewrite; at most about 200 characters; empty for none' },
      links: { type: 'array', items: { type: 'string' } },
    },
    required: ['target_id', 'quote', 'category', 'kind', 'severity', 'diagnosis', 'why_it_matters', 'suggestion', 'links'],
    additionalProperties: false,
  };
}

export function responseSchema(mode: Mode): Record<string, unknown> {
  const annotations = { type: 'array', items: annotationSchema(mode) };
  if (mode === 'sentence') {
    return { type: 'object', properties: { annotations }, required: ['annotations'], additionalProperties: false };
  }
  if (mode === 'paragraph') {
    return {
      type: 'object',
      properties: {
        paragraph_topics: {
          type: 'array',
          items: {
            type: 'object',
            properties: { paragraph_id: { type: 'string' }, label: { type: 'string' } },
            required: ['paragraph_id', 'label'],
            additionalProperties: false,
          },
        },
        annotations,
      },
      required: ['paragraph_topics', 'annotations'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: {
      summary: {
        type: 'object',
        properties: {
          aims: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A1, A2, …' },
                text: { type: 'string', description: 'The aim, briefly' },
                target_id: { type: 'string', description: 'Where the aim is stated' },
              },
              required: ['id', 'text', 'target_id'],
              additionalProperties: false,
            },
          },
          coverage: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                aim_id: { type: 'string' },
                section: { type: 'string', description: 'Methods, Results or Discussion (or equivalent)' },
                status: { type: 'string', enum: ['addressed', 'partial', 'absent'] },
              },
              required: ['aim_id', 'section', 'status'],
              additionalProperties: false,
            },
          },
          priorities: { type: 'array', items: { type: 'string' } },
        },
        required: ['aims', 'coverage', 'priorities'],
        additionalProperties: false,
      },
      annotations,
    },
    required: ['summary', 'annotations'],
    additionalProperties: false,
  };
}

/* ------------------------------------------------------------------ */
/* Validation of what comes back                                        */
/* Lenient per annotation (drop and warn), strict at the top level      */
/* (throw, so the caller can retry once with the error message).        */
/* ------------------------------------------------------------------ */

export interface ParsedResponse {
  annotations: RawAnnotation[];
  topics: ParagraphTopic[];
  summary: ManuscriptSummary | null;
  warnings: string[];
}

export class ValidationError extends Error {}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch { /* fall through */ }
    }
    throw new ValidationError('The reply was not valid JSON.');
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const normEnum = (v: unknown) => str(v).trim().toLowerCase().replace(/[\s-]+/g, '_');

function defaultKind(category: string): Kind {
  const g = META[category]?.group;
  return g === 'issue' ? 'issue' : g === 'strength' ? 'strength' : 'structure';
}

export function validateResponse(data: unknown, mode: Mode): ParsedResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError('Expected a JSON object at the top level.');
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.annotations)) throw new ValidationError('Missing "annotations" array.');
  const allowed = new Set(CATEGORIES[mode]);
  const warnings: string[] = [];
  const annotations: RawAnnotation[] = [];
  let dropped = 0;
  for (const item of obj.annotations) {
    if (!item || typeof item !== 'object') { dropped++; continue; }
    const a = item as Record<string, unknown>;
    const category = normEnum(a.category);
    const target = str(a.target_id).trim().replace(/^\[|\]$/g, '').toUpperCase();
    if (!allowed.has(category) || !target) { dropped++; continue; }
    let kind = normEnum(a.kind) as Kind;
    if (!['structure', 'issue', 'strength'].includes(kind)) kind = defaultKind(category);
    let severity = normEnum(a.severity) as Severity;
    if (!['info', 'minor', 'major'].includes(severity)) severity = kind === 'issue' ? 'minor' : 'info';
    if (kind !== 'issue') severity = 'info';
    let suggestion = str(a.suggestion).trim();
    if (suggestion.length > 280) suggestion = suggestion.slice(0, 277).trimEnd() + '…';
    annotations.push({
      target_id: target,
      quote: str(a.quote),
      category,
      kind,
      severity,
      diagnosis: str(a.diagnosis).trim(),
      why_it_matters: str(a.why_it_matters).trim(),
      suggestion,
      links: Array.isArray(a.links) ? a.links.map((l) => str(l).trim().replace(/^\[|\]$/g, '').toUpperCase()).filter(Boolean) : [],
    });
  }
  if (dropped) warnings.push(`${dropped} finding(s) had an unknown category or no target and were skipped.`);

  let topics: ParagraphTopic[] = [];
  if (mode === 'paragraph') {
    if (!Array.isArray(obj.paragraph_topics)) throw new ValidationError('Missing "paragraph_topics" array.');
    topics = obj.paragraph_topics
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({ paragraph_id: str(t.paragraph_id).trim().toUpperCase(), label: str(t.label).trim() }))
      .filter((t) => t.paragraph_id && t.label);
  }

  let summary: ManuscriptSummary | null = null;
  if (mode === 'manuscript') {
    const s = obj.summary as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object') throw new ValidationError('Missing "summary" object.');
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[] : []);
    summary = {
      aims: arr(s.aims).map((x) => ({ id: str(x.id).trim().toUpperCase(), text: str(x.text).trim(), target_id: str(x.target_id).trim().toUpperCase() })).filter((x) => x.id),
      coverage: arr(s.coverage).map((x) => {
        const st = normEnum(x.status);
        return {
          aim_id: str(x.aim_id).trim().toUpperCase(),
          section: str(x.section).trim(),
          status: (['addressed', 'partial', 'absent'].includes(st) ? st : 'partial') as 'addressed' | 'partial' | 'absent',
        };
      }).filter((x) => x.aim_id && x.section),
      priorities: Array.isArray(s.priorities) ? s.priorities.map(str).filter(Boolean) : [],
    };
  }
  return { annotations, topics, summary, warnings };
}
