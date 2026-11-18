import { flatten } from './anchor';
import { META } from './schema';
import type { AnalysisResult, Annotation, SegmentedDoc } from './types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lab = (a: Annotation) => META[a.category]?.label ?? a.category;
const col = (a: Annotation) => META[a.category]?.color ?? '#64748b';
const kindText = (a: Annotation) => a.kind === 'issue' ? (a.severity === 'major' ? 'Major issue' : 'Minor issue') : a.kind === 'strength' ? 'Strength' : 'Structure';
const MODE_NAME = { sentence: 'Sentence construction', paragraph: 'Paragraph flow', manuscript: 'Manuscript coherence' } as const;

/** A self-contained HTML page: highlighted text with numbered notes, then the notes. No scripts. */
export function exportHtml(doc: SegmentedDoc, r: AnalysisResult, model: string): string {
  const anns = r.annotations.filter((a) => !a.hidden);
  const num = new Map(anns.map((a, i) => [a.uid, i + 1]));
  const topics = new Map(r.topics.map((t) => [t.paragraph_id, t.label]));
  const body: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind === 'heading') { body.push(`<h2>${esc(b.text)}</h2>`); continue; }
    const pa = anns.filter((a) => a.paragraphId === b.id);
    const inline = pa.filter((a) => a.start != null && !(a.target_id === b.id && !a.quote.trim()));
    const notes = pa.filter((a) => !inline.includes(a));
    let html = '';
    for (const seg of flatten(b.text, inline)) {
      const t = esc(b.text.slice(seg.start, seg.end));
      if (!seg.covers.length) { html += t; continue; }
      const outer = seg.covers[0];
      const inner = seg.covers[seg.covers.length - 1];
      const style = inner.kind === 'issue' ? 'wavy' : inner.kind === 'strength' ? 'double' : 'solid';
      html += `<mark style="background:${col(outer)}26;text-decoration:underline ${style} ${col(inner)} 2px;text-underline-offset:4px">${t}</mark>`;
      const ending = seg.covers.filter((a) => a.end === seg.end);
      for (const a of ending) html += `<sup><a href="#n${num.get(a.uid)}" id="r${num.get(a.uid)}">${num.get(a.uid)}</a></sup>`;
    }
    const margin = [`<span class="pid">${b.id}</span>`];
    if (topics.get(b.id)) margin.push(`<span class="topic">${esc(topics.get(b.id)!)}</span>`);
    for (const a of notes) margin.push(`<a class="badge" style="border-color:${col(a)}" href="#n${num.get(a.uid)}" id="r${num.get(a.uid)}">${num.get(a.uid)} ${esc(lab(a))}</a>`);
    body.push(`<div class="para"><div class="margin">${margin.join('')}</div><p>${html}</p></div>`);
  }
  const notes = anns.map((a) => `<li id="n${num.get(a.uid)}" style="border-left-color:${col(a)}"><strong>${esc(lab(a))}</strong> <span class="k">${kindText(a)}, ${a.target_id}</span>${a.quote.trim() ? `<br><em>“${esc(a.quote.trim())}”</em>` : ''}<br>${esc(a.diagnosis)}${a.why_it_matters ? `<br><span class="k">${esc(a.why_it_matters)}</span>` : ''}${a.suggestion ? `<br><b>Try:</b> ${esc(a.suggestion)}` : ''} <a href="#r${num.get(a.uid)}">↩</a></li>`).join('\n');
  let summary = '';
  if (r.summary) {
    const s = r.summary;
    const secs = [...new Set(s.coverage.map((c) => c.section))];
    const aimIds = [...new Set(s.coverage.map((c) => c.aim_id))];
    summary = `<section class="summary"><h2>How the paper holds together</h2>
<ul>${s.aims.map((a) => `<li><b>${esc(a.id)}</b> ${esc(a.text)}</li>`).join('')}</ul>
${secs.length ? `<table><tr><th>Aim</th>${secs.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>${aimIds.map((id) => `<tr><th>${esc(id)}</th>${secs.map((sec) => `<td>${esc(s.coverage.find((c) => c.aim_id === id && c.section === sec)?.status ?? '–')}</td>`).join('')}</tr>`).join('')}</table>` : ''}
${s.priorities.length ? `<h3>Fix these first</h3><ol>${s.priorities.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>` : ''}</section>`;
  }
  const date = new Date().toISOString().slice(0, 10);
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pardalote: ${MODE_NAME[r.mode]}</title>
<style>
body{margin:0;background:#f6f7f5;color:#1f2723;font:16px/1.5 system-ui,sans-serif}
main{max-width:60rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font:600 1.6rem/1.2 Georgia,serif;margin:0 0 .3rem} .meta{color:#5e6e66;margin:0 0 2rem}
h2{font:600 1.25rem Georgia,serif;margin:2rem 0 .6rem 9rem}
.para{display:grid;grid-template-columns:9rem 1fr;margin:.8rem 0}
.margin{text-align:right;padding-right:1rem;font-size:.82rem;color:#5e6e66;display:flex;flex-direction:column;align-items:flex-end;gap:.25rem}
.topic{color:#46524c} .badge{border:1px solid;border-radius:4px;padding:0 .35rem;color:#1f2723;text-decoration:none}
p{font:1.05rem/1.85 Georgia,serif;margin:0;max-width:42rem} mark{color:inherit;border-radius:2px}
sup a{font-size:.7rem;color:#5e6e66;text-decoration:none;padding:0 1px}
.notes{list-style:none;padding:0;margin:2.5rem 0 0} .notes li{background:#fff;border-left:4px solid;padding:.5rem .8rem;margin:.4rem 0;font-size:.93rem}
.k{color:#5e6e66} .summary{background:#fff;padding:1rem 1.25rem;border-radius:8px} .summary h2{margin:0 0 .5rem}
table{border-collapse:collapse} th,td{border:1px solid #d9dfdb;padding:.25rem .5rem;text-align:left}
@media (max-width:700px){.para{grid-template-columns:1fr}.margin{flex-direction:row;text-align:left}h2{margin-left:0}}
@media print{body{background:#fff}}
</style></head><body><main>
<h1>${MODE_NAME[r.mode]}</h1>
<p class="meta">Pardalote analysis, ${date}, ${esc(model)}. ${anns.length} findings.</p>
${summary}
${body.join('\n')}
<h2 style="margin-left:0">Notes</h2>
<ol class="notes">${notes}</ol>
</main></body></html>`;
}

export function exportMarkdown(doc: SegmentedDoc, r: AnalysisResult, model: string): string {
  const anns = r.annotations.filter((a) => !a.hidden);
  const lines = [`# Pardalote: ${MODE_NAME[r.mode]}`, '', `${new Date().toISOString().slice(0, 10)}, ${model}. ${anns.length} findings.`, ''];
  if (r.summary) {
    lines.push('## Aims', '', ...r.summary.aims.map((a) => `- **${a.id}** ${a.text} (${a.target_id})`), '');
    if (r.summary.priorities.length) lines.push('## Fix these first', '', ...r.summary.priorities.map((p, i) => `${i + 1}. ${p}`), '');
  }
  const topics = new Map(r.topics.map((t) => [t.paragraph_id, t.label]));
  let section = '';
  for (const p of doc.paragraphs) {
    const pa = anns.filter((a) => a.paragraphId === p.id);
    if (!pa.length && !topics.get(p.id)) continue;
    if (p.section && p.section !== section) { section = p.section; lines.push(`## ${section}`, ''); }
    lines.push(`### ${p.id}${topics.get(p.id) ? `: ${topics.get(p.id)}` : ''}`, '', `> ${p.text.slice(0, 160)}${p.text.length > 160 ? '…' : ''}`, '');
    for (const a of pa) {
      lines.push(`- **${lab(a)}** (${kindText(a).toLowerCase()}, ${a.target_id})${a.quote.trim() ? `: “${a.quote.trim()}”` : ''}`);
      lines.push(`  ${a.diagnosis}${a.why_it_matters ? ' ' + a.why_it_matters : ''}`);
      if (a.suggestion) lines.push(`  *Try:* ${a.suggestion}`);
    }
    lines.push('');
  }
  const loose = anns.filter((a) => !a.paragraphId);
  if (loose.length) {
    lines.push('## Not placed in the text', '');
    for (const a of loose) lines.push(`- **${lab(a)}** (${a.target_id}): ${a.diagnosis}`);
  }
  return lines.join('\n');
}
