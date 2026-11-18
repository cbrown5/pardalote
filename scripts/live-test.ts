/* Live check against the Anthropic API: npx tsx scripts/live-test.ts [mode] [model] */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parsePlainText, segment } from '../src/segment';
import { parsePromptFile } from '../src/prompt';
import { runAnalysis, estimate } from '../src/analyse';
import { buildSystemPrompt } from '../src/prompt';
import type { Mode } from '../src/types';

const key = process.env.ANTHROPIC_API_KEY ?? '';
if (!key) throw new Error('Set ANTHROPIC_API_KEY to run this test.');
const modes = (process.argv[2] ? [process.argv[2]] : ['sentence', 'paragraph', 'manuscript']) as Mode[];
const model = process.argv[3] ?? 'claude-sonnet-5-5';
const prices: Record<string, [number, number]> = { 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-haiku-5-5': [0.1, 0.5] };
const doc = segment(parsePlainText(readFileSync('tests/fixtures/sample.md', 'utf8')));
const prompt = parsePromptFile(readFileSync('public/system-prompt.md', 'utf8'));
mkdirSync('out', { recursive: true });

await Promise.all(modes.map(async (mode) => {
  const est = estimate(doc, mode, buildSystemPrompt(prompt, mode), ...(prices[model] ?? []));
  const t0 = Date.now();
  const r = await runAnalysis({
    doc, mode, prompt, provider: 'anthropic', apiKey: key, model, structured: true,
    inPrice: prices[model]?.[0], outPrice: prices[model]?.[1],
  });
  const by: Record<string, number> = {};
  for (const a of r.annotations) by[a.anchorMethod] = (by[a.anchorMethod] ?? 0) + 1;
  console.log(`\n== ${mode} (${model}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`estimate: in ${est.input} out ${est.output} $${est.cost?.toFixed(4)} | actual: in ${r.usage.input} out ${r.usage.output} $${r.usage.cost?.toFixed(4)}`);
  console.log(`annotations: ${r.annotations.length}  anchoring:`, by, 'warnings:', r.warnings);
  writeFileSync(`out/${mode}.json`, JSON.stringify(r, null, 2));
}));
