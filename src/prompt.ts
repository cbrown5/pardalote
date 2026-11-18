import type { Mode } from './types';
import { CATEGORIES } from './schema';

export interface PromptSections {
  core: string;
  sentence: string;
  paragraph: string;
  manuscript: string;
  output: string;
}

const REQUIRED: (keyof PromptSections)[] = ['core', 'sentence', 'paragraph', 'manuscript', 'output'];

/** Split system-prompt.md at its `<!-- section: name -->` markers. */
export function parsePromptFile(md: string): PromptSections {
  const re = /<!--\s*section:\s*([a-z_-]+)\s*-->/gi;
  const marks: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) marks.push({ name: m[1].toLowerCase(), start: m.index, end: re.lastIndex });
  const out: Record<string, string> = {};
  marks.forEach((mk, i) => {
    const next = marks[i + 1]?.start ?? md.length;
    out[mk.name] = md.slice(mk.end, next).trim();
  });
  const missing = REQUIRED.filter((k) => !out[k]);
  if (missing.length) {
    throw new Error(`The prompt file is missing these sections: ${missing.join(', ')}. Keep the "<!-- section: name -->" markers intact.`);
  }
  return out as unknown as PromptSections;
}

export function buildSystemPrompt(sections: PromptSections, mode: Mode): string {
  return [sections.core, sections[mode], sections.output].join('\n\n');
}

/**
 * Categories mentioned in backticks in a mode's section that the schema
 * doesn't know, and schema categories the prompt never mentions. Used to warn
 * when someone edits the prompt without updating schema.ts.
 */
export function checkCategories(sections: PromptSections): string[] {
  const warnings: string[] = [];
  const nonCategory = new Set([
    'structure', 'issue', 'strength', 'minor', 'major', 'info', 'target_id', 'quote', 'links',
    'kind', 'severity', 'diagnosis', 'why_it_matters', 'suggestion', 'annotations',
    'paragraph_topics', 'summary', 'summary.aims', 'summary.coverage', 'summary.priorities',
    'addressed', 'partial', 'absent', 'category', 'aims', 'coverage', 'priorities',
  ]);
  const mentionedIn = (text: string) => new Set(
    [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((c) => !nonCategory.has(c) && !/^[PA]\d/.test(c)),
  );
  // Categories shared by every mode (such as `other`) are described once, in the core section.
  const core = mentionedIn(sections.core);
  for (const mode of ['sentence', 'paragraph', 'manuscript'] as Mode[]) {
    const mentioned = mentionedIn(sections[mode]);
    const known = new Set(CATEGORIES[mode]);
    for (const c of mentioned) if (!known.has(c)) warnings.push(`Prompt (${mode} mode) mentions \`${c}\`, which isn't a category in schema.ts, so the model can't use it.`);
    for (const c of known) if (!mentioned.has(c) && !core.has(c)) warnings.push(`Category \`${c}\` (${mode} mode) isn't described in the prompt.`);
  }
  return warnings;
}
