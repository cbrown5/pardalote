import { flatten } from './anchor';
import { clear, h, setVars } from './dom';
import { META } from './schema';
import type { AnalysisResult, Annotation, Paragraph, SegmentedDoc } from './types';

const HANDOFF = new Set(['transition_strong', 'transition_weak', 'merge_candidate']);
const TOPIC_COLOURS = ['#7aa6c2', '#c9a26b', '#8fb08a', '#b98bb0', '#d08a7a', '#8a9fd0', '#b3b36b', '#6fb3aa'];

export interface ViewState {
  doc: SegmentedDoc;
  result: AnalysisResult;
  hiddenCategories: Set<string>;
  kinds: Set<string>;
  threadAim: string | null;
  selected: number | null;
}

export function colour(a: { category: string }) {
  return META[a.category]?.color ?? '#64748b';
}
export function label(a: { category: string }) {
  return META[a.category]?.label ?? a.category;
}

/** Visible = not hidden by the user, category shown, kind shown. */
export function visible(a: Annotation, s: ViewState) {
  return !a.hidden && !s.hiddenCategories.has(a.category) && s.kinds.has(a.kind);
}

/** Paragraph-level findings with no quote are shown as margin badges, not tinted text. */
function isMarginNote(a: Annotation, doc: SegmentedDoc) {
  const t = doc.byId.get(a.target_id);
  return !!t && 'sentences' in t && !a.quote.trim();
}
function isHandoff(a: Annotation) {
  return HANDOFF.has(a.category);
}

/* ------------------------------------------------------------------ */
/* Threads (manuscript mode): everything connected to an aim             */
/* ------------------------------------------------------------------ */

export function threadFor(aimId: string, s: ViewState): { uids: Set<number>; paras: Set<string> } {
  const re = new RegExp(`\\b${aimId}\\b`);
  const uids = new Set<number>();
  const paras = new Set<string>();
  const aim = s.result.summary?.aims.find((x) => x.id === aimId);
  const aimPara = aim?.target_id.split('.')[0];
  if (aimPara) paras.add(aimPara);
  for (const a of s.result.annotations) {
    if (!re.test(a.diagnosis) && !re.test(a.why_it_matters)) continue;
    uids.add(a.uid);
    if (a.paragraphId) paras.add(a.paragraphId);
    // Follow the model's cross-links (e.g. an aim to the intro sentence that set it up).
    for (const l of a.links) paras.add(l.split('.')[0]);
  }
  return { uids, paras };
}

/* ------------------------------------------------------------------ */
/* The page                                                              */
/* ------------------------------------------------------------------ */

export function renderPage(page: HTMLElement, s: ViewState) {
  clear(page);
  const { doc, result } = s;
  const anns = result.annotations.filter((a) => visible(a, s));
  const byPara = new Map<string, Annotation[]>();
  for (const a of anns) {
    if (!a.paragraphId) continue;
    if (!byPara.has(a.paragraphId)) byPara.set(a.paragraphId, []);
    byPara.get(a.paragraphId)!.push(a);
  }
  const topics = new Map(result.topics.map((t) => [t.paragraph_id, t.label]));
  const thread = s.threadAim ? threadFor(s.threadAim, s) : null;
  page.classList.toggle('thread-on', !!thread);
  let topicIdx = 0;
  let lastTopic = '';

  for (const b of doc.blocks) {
    if (b.kind === 'heading') {
      const tag = (`h${Math.min(Math.max(b.level, 2), 4)}`) as 'h2' | 'h3' | 'h4';
      page.append(h(tag, {}, b.text));
      continue;
    }
    const pAnns = byPara.get(b.id) ?? [];
    const margin = h('div', { class: 'margin' }, h('span', { class: 'pid' }, b.id));
    const topic = topics.get(b.id);
    if (topic) {
      if (topic !== lastTopic) topicIdx++;
      lastTopic = topic;
      const t = h('span', { class: 'topic' }, topic);
      setVars(t, { '--topic': TOPIC_COLOURS[(topicIdx - 1) % TOPIC_COLOURS.length] });
      margin.append(t);
    }

    // Hand-off markers sit above the paragraph they introduce.
    const handoffs = pAnns.filter(isHandoff);
    const wrap = h('div', { class: 'para', id: `para-${b.id}`, 'data-pid': b.id });
    if (thread) wrap.classList.add(thread.paras.has(b.id) ? 'in-thread' : 'dim');
    for (const a of handoffs) {
      const row = h('div', { class: 'handoff' },
        h('button', { type: 'button', 'data-uids': String(a.uid), class: 'handoff-btn', 'aria-describedby': `finding-${a.uid}` },
          `${label(a)}${a.diagnosis ? ': ' + shorten(a.diagnosis, 90) : ''}`));
      setVars(row, { '--c': colour(a), '--hs': a.kind === 'issue' ? 'dashed' : 'solid' });
      wrap.append(h('div', {}), row);
    }

    for (const a of pAnns.filter((x) => isMarginNote(x, doc) && !isHandoff(x))) {
      const badge = h('button', { type: 'button', class: 'badge', 'data-uids': String(a.uid), 'aria-describedby': `finding-${a.uid}` }, label(a));
      setVars(badge, { '--c': colour(a) });
      margin.append(badge);
    }

    const inline = pAnns.filter((a) => a.start != null && !isMarginNote(a, doc) && !(isHandoff(a) && !a.quote.trim()));
    const text = h('p', { class: 'text' });
    renderParagraphText(text, b, inline, thread?.uids ?? null);
    wrap.append(margin, text);
    page.append(wrap);
  }
}

function shorten(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function renderParagraphText(target: HTMLElement, p: Paragraph, anns: Annotation[], threadUids: Set<number> | null) {
  // Cut at sentence boundaries too, so every segment belongs to at most one sentence.
  const segs = flatten(p.text, anns);
  const cuts: { start: number; end: number; covers: Annotation[] }[] = [];
  const bounds = new Set<number>();
  for (const s of p.sentences) { bounds.add(s.start); bounds.add(s.end); }
  for (const seg of segs) {
    let s0 = seg.start;
    for (const bnd of [...bounds].filter((x) => x > seg.start && x < seg.end).sort((x, y) => x - y)) {
      cuts.push({ start: s0, end: bnd, covers: seg.covers });
      s0 = bnd;
    }
    cuts.push({ start: s0, end: seg.end, covers: seg.covers });
  }
  const sentenceAt = (i: number) => p.sentences.find((s) => i >= s.start && i < s.end);
  const firstSeg = new Set<number>(); // annotation uids already given a focus stop
  let currentSent: { el: HTMLElement; id: string } | null = null;

  for (const c of cuts) {
    const sent = sentenceAt(c.start);
    let parent: HTMLElement = target;
    if (sent) {
      if (!currentSent || currentSent.id !== sent.id) {
        currentSent = { el: h('span', { class: 'sent', 'data-sid': sent.id, id: `sent-${sent.id}` }), id: sent.id };
        target.append(currentSent.el);
      }
      parent = currentSent.el;
    } else {
      currentSent = null;
    }
    const str = p.text.slice(c.start, c.end);
    if (!c.covers.length) {
      parent.append(str);
      continue;
    }
    const outer = c.covers[0];
    const inner = c.covers[c.covers.length - 1];
    const span = h('span', {
      class: 'hl',
      'data-uids': c.covers.map((a) => a.uid).join(' '),
      'data-style': inner.kind,
    }, str);
    const vars: Record<string, string> = { '--bg': colour(outer), '--ul': colour(inner) };
    if (c.covers.length > 2) {
      span.classList.add('mid');
      vars['--mid'] = colour(c.covers[1]);
    }
    if (outer.kind === 'structure' && c.covers.length === 1) vars['--bga'] = '11%';
    setVars(span, vars);
    if (threadUids && c.covers.some((a) => threadUids.has(a.uid))) span.classList.add('in-thread');
    // One keyboard stop per annotation, at its first segment.
    const starts = c.covers.filter((a) => a.start === c.start && !firstSeg.has(a.uid));
    if (starts.length) {
      starts.forEach((a) => firstSeg.add(a.uid));
      span.tabIndex = 0;
      span.setAttribute('role', 'button');
      span.setAttribute('aria-describedby', starts.map((a) => `finding-${a.uid}`).join(' '));
    }
    parent.append(span);
  }
}

/* ------------------------------------------------------------------ */
/* Legend                                                                */
/* ------------------------------------------------------------------ */

export function renderLegend(el: HTMLElement, s: ViewState, onToggle: (cat: string) => void) {
  clear(el);
  const counts = new Map<string, number>();
  for (const a of s.result.annotations) if (!a.hidden) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  const order = Object.keys(META);
  for (const cat of [...counts.keys()].sort((x, y) => order.indexOf(x) - order.indexOf(y))) {
    const sw = h('span', { class: 'swatch' });
    setVars(sw, { '--c': META[cat]?.color ?? '#64748b' });
    el.append(h('button', {
      type: 'button',
      'aria-pressed': String(!s.hiddenCategories.has(cat)),
      title: s.hiddenCategories.has(cat) ? 'Show these highlights' : 'Hide these highlights',
      onclick: () => onToggle(cat),
    }, sw, META[cat]?.label ?? cat, h('span', { class: 'count' }, String(counts.get(cat)))));
  }
}

/* ------------------------------------------------------------------ */
/* Findings panel                                                        */
/* ------------------------------------------------------------------ */

export function renderFindings(list: HTMLElement, s: ViewState, actions: { go: (a: Annotation) => void; toggleHidden: (a: Annotation) => void }) {
  clear(list);
  const shown = s.result.annotations.filter((a) => !s.hiddenCategories.has(a.category) && s.kinds.has(a.kind));
  const anchored = shown.filter((a) => a.start != null || a.paragraphId);
  const loose = shown.filter((a) => !(a.start != null || a.paragraphId));
  if (!shown.length) {
    list.append(h('li', { class: 'empty' }, s.result.annotations.length
      ? 'Nothing matches the current filters.'
      : 'No findings. The model found nothing worth flagging in this text.'));
  }
  const item = (a: Annotation) => {
    const sev = a.kind === 'issue'
      ? h('span', { class: `sev ${a.severity}` }, a.severity === 'major' ? 'Major' : 'Minor')
      : h('span', { class: `sev ${a.kind}` }, a.kind === 'strength' ? 'Strength' : 'Structure');
    const li = h('li', { class: `finding${a.hidden ? ' hidden-ann' : ''}${s.selected === a.uid ? ' selected' : ''}`, id: `finding-${a.uid}`, 'data-uid': String(a.uid) },
      h('div', { class: 'finding-top' },
        h('span', { class: 'finding-cat' }, label(a)),
        sev),
      h('button', { type: 'button', class: 'finding-go', onclick: () => actions.go(a), 'aria-label': `Show ${label(a)} at ${a.target_id} in the text` },
        a.quote.trim() ? h('span', { class: 'line' }, h('span', { class: 'quote' }, `“${shorten(a.quote.trim(), 110)}”`)) : null,
        h('span', { class: 'line' }, a.diagnosis)),
      a.why_it_matters ? h('p', {}, a.why_it_matters) : null,
      a.suggestion ? h('p', {}, h('b', {}, 'Try: '), a.suggestion) : null,
      h('div', { class: 'finding-top' },
        h('span', { class: 'muted small' }, a.target_id + (a.anchorMethod === 'none' ? ' (not found in text)' : '')),
        h('button', { type: 'button', class: 'finding-where', onclick: () => actions.toggleHidden(a) }, a.hidden ? 'Restore' : 'This is wrong')));
    setVars(li, { '--c': colour(a) });
    return li;
  };
  anchored.forEach((a) => list.append(item(a)));
  if (loose.length) {
    list.append(h('li', { class: 'unanchored-head' }, 'Couldn’t be placed in the text'));
    loose.forEach((a) => list.append(item(a)));
  }
}

/* ------------------------------------------------------------------ */
/* Manuscript summary                                                    */
/* ------------------------------------------------------------------ */

export function renderSummary(el: HTMLElement, s: ViewState, onAim: (id: string) => void, goTo: (id: string) => void) {
  clear(el);
  const sum = s.result.summary;
  if (!sum) { el.hidden = true; return; }
  el.hidden = false;
  el.append(h('h2', {}, 'How the paper holds together'));
  if (sum.aims.length) {
    el.append(h('h3', {}, 'Stated aims'),
      h('p', { class: 'muted small' }, 'Select an aim to trace it through the paper.'),
      h('ul', { class: 'aims' }, sum.aims.map((a) =>
        h('li', {}, h('button', { type: 'button', 'aria-pressed': String(s.threadAim === a.id), onclick: () => onAim(a.id) },
          h('b', {}, a.id), h('span', {}, a.text))))));
  } else {
    el.append(h('p', {}, 'No clear statement of aims was found.'));
  }
  if (sum.coverage.length) {
    const sections: string[] = [];
    for (const c of sum.coverage) if (!sections.includes(c.section)) sections.push(c.section);
    const cell = (aim: string, sec: string) => {
      const c = sum.coverage.find((x) => x.aim_id === aim && x.section === sec);
      if (!c) return h('td', { class: 'muted' }, '–');
      const sym = c.status === 'addressed' ? '✓ ' : c.status === 'partial' ? '◐ ' : '✗ ';
      const word = c.status === 'addressed' ? 'Addressed' : c.status === 'partial' ? 'Partly' : 'Absent';
      return h('td', { class: `cov-${c.status}` }, sym + word);
    };
    const aimIds = [...new Set(sum.coverage.map((c) => c.aim_id))];
    el.append(h('h3', {}, 'Where each aim is followed up'),
      h('table', { class: 'coverage' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Aim'), sections.map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, aimIds.map((id) => h('tr', {}, h('th', { scope: 'row' }, id), sections.map((sec) => cell(id, sec)))))));
  }
  if (sum.priorities.length) {
    el.append(h('h3', {}, 'Fix these first'),
      h('ol', { class: 'priorities' }, sum.priorities.map((p) => h('li', {}, ...linkifyIds(p, goTo)))));
  }
}

/** Turn "P3.S2" mentions in model text into buttons that scroll to the text. */
export function linkifyIds(text: string, goTo: (id: string) => void): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  const re = /\bP\d+(?:\.S\d+)?\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(text.slice(last, m.index));
    const id = m[0];
    out.push(h('button', { type: 'button', class: 'finding-where', onclick: () => goTo(id) }, id));
    last = m.index + id.length;
  }
  out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------------ */
/* Popover                                                               */
/* ------------------------------------------------------------------ */

export function fillPopover(pop: HTMLElement, anns: Annotation[], activeUid: number, pinned: boolean,
  actions: { select: (uid: number) => void; hide: (a: Annotation) => void; goTo: (id: string) => void; close: () => void }) {
  clear(pop);
  const a = anns.find((x) => x.uid === activeUid) ?? anns[0];
  if (anns.length > 1) {
    pop.append(h('div', { class: 'pop-tabs', role: 'tablist' }, anns.map((x) => {
      const sw = h('span', { class: 'swatch' });
      setVars(sw, { '--c': colour(x) });
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(x.uid === a.uid), onclick: () => actions.select(x.uid) }, sw, label(x));
    })));
  }
  const sw = h('span', { class: 'swatch' });
  setVars(sw, { '--c': colour(a) });
  const kind = a.kind === 'issue' ? (a.severity === 'major' ? 'Major issue' : 'Minor issue') : a.kind === 'strength' ? 'Strength' : 'Structure';
  const parts = [
    h('div', { class: 'pop-head' }, sw, h('strong', {}, label(a)), h('span', { class: 'muted small' }, kind),
      pinned ? h('button', { type: 'button', class: 'btn ghost pin', onclick: actions.close }, 'Close') : null),
    h('p', { class: 'pop-diag' }, ...linkifyIds(a.diagnosis, actions.goTo)),
    a.why_it_matters ? h('p', { class: 'pop-why' }, ...linkifyIds(a.why_it_matters, actions.goTo)) : null,
    a.suggestion ? h('p', { class: 'pop-sugg' }, h('b', {}, 'Try: '), ...linkifyIds(a.suggestion, actions.goTo)) : null,
    a.links.length ? h('p', { class: 'pop-links' }, 'Connects to', ...a.links.map((id) => h('button', { type: 'button', onclick: () => actions.goTo(id) }, id))) : null,
    h('div', { class: 'pop-foot' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => actions.hide(a) }, 'This is wrong: hide it')),
  ];
  for (const x of parts) if (x) pop.append(x);
  pop.setAttribute('aria-label', label(a));
}

export function positionPopover(pop: HTMLElement, rect: DOMRect) {
  pop.hidden = false;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const margin = 8;
  let left = Math.min(Math.max(margin, rect.left), window.innerWidth - pw - margin);
  let top = rect.bottom + 8;
  if (top + ph > window.innerHeight - margin) top = Math.max(margin, rect.top - ph - 8);
  pop.style.setProperty('left', `${left}px`);
  pop.style.setProperty('top', `${top}px`);
}
