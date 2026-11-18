import './styles.css';
import { estimate, runAnalysis } from './analyse';
import { blocksToText, readDocx } from './docx';
import { clear, download, h } from './dom';
import { exportHtml, exportMarkdown } from './export';
import { Keyring, kvGet, kvSet } from './keys';
import { buildSystemPrompt, checkCategories, parsePromptFile, type PromptSections } from './prompt';
import { listModels, priceFor, PROVIDERS, STATIC_MODELS, type ModelInfo, type ProviderId } from './providers';
import {
  fillPopover, positionPopover, renderFindings, renderLegend, renderPage, renderSummary, type ViewState,
} from './render';
import { parsePlainText, segment, wordCount } from './segment';
import type { Annotation, Mode, SegmentedDoc } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  text: $<HTMLTextAreaElement>('text'),
  file: $<HTMLInputElement>('file'),
  dropzone: $('dropzone'),
  stats: $('text-stats'),
  provider: $<HTMLSelectElement>('provider'),
  model: $<HTMLSelectElement>('model'),
  structured: $<HTMLInputElement>('structured'),
  estimate: $('estimate'),
  run: $<HTMLButtonElement>('run'),
  runNote: $('run-note'),
  privacy: $<HTMLAnchorElement>('privacy-link'),
  compose: $('compose'),
  result: $('result'),
  back: $('back'),
  legend: $('legend'),
  usage: $('usage'),
  warnings: $('warnings'),
  summary: $('summary'),
  page: $('page'),
  findings: $('findings-list'),
  progress: $('progress'),
  progressText: $('progress-text'),
  cancel: $('cancel'),
  popover: $('popover'),
  keysDialog: $<HTMLDialogElement>('keys-dialog'),
  keysBody: $('keys-body'),
};

const keyring = new Keyring();
let prompt: PromptSections | null = null;
let promptSource: 'default' | 'custom' = 'default';
let promptText = ''; // raw file, kept so "Download current prompt" can save it without an await
let promptWarnings: string[] = [];
let models: ModelInfo[] = [];
let view: ViewState | null = null;
let lastModel = '';
let abort: AbortController | null = null;

const mode = () => (document.querySelector<HTMLInputElement>('input[name=mode]:checked')!.value as Mode);
const provider = () => els.provider.value as ProviderId;
const fmt = (n: number) => n.toLocaleString('en-GB');

/* ------------------------------------------------------------------ */
/* Prompt file                                                          */
/* ------------------------------------------------------------------ */

async function loadPrompt() {
  const custom = await kvGet<string>('customPrompt').catch(() => undefined);
  if (custom) {
    try {
      prompt = parsePromptFile(custom);
      promptText = custom;
      promptSource = 'custom';
      promptWarnings = checkCategories(prompt);
      return;
    } catch { /* fall back to default */ }
  }
  const r = await fetch('./system-prompt.md', { cache: 'no-cache' });
  promptText = await r.text();
  prompt = parsePromptFile(promptText);
  promptSource = 'default';
  promptWarnings = checkCategories(prompt);
}

/* ------------------------------------------------------------------ */
/* Compose view                                                          */
/* ------------------------------------------------------------------ */

let parsedCache: { text: string; doc: SegmentedDoc } | null = null;
function currentDoc(): SegmentedDoc {
  const text = els.text.value;
  if (parsedCache?.text !== text) parsedCache = { text, doc: segment(parsePlainText(text)) };
  return parsedCache.doc;
}

function updateStats() {
  const text = els.text.value.trim();
  if (!text) {
    els.stats.textContent = '';
    els.estimate.textContent = 'Paste or open some text to see what the analysis will cost.';
    return;
  }
  const doc = currentDoc();
  const sections = doc.blocks.filter((b) => b.kind === 'heading').length;
  els.stats.textContent = `${fmt(wordCount(text))} words, ${doc.paragraphs.length} paragraph${doc.paragraphs.length === 1 ? '' : 's'}${sections ? `, ${sections} heading${sections === 1 ? '' : 's'}` : ''}`;
  if (!prompt) return;
  const m = els.model.value;
  const p = priceFor(models, m);
  const e = estimate(doc, mode(), buildSystemPrompt(prompt, mode()), p.inPrice, p.outPrice);
  const name = models.find((x) => x.id === m)?.name ?? m;
  const cost = e.cost != null ? `, roughly ${e.cost < 0.01 ? 'under 1 cent' : '$' + e.cost.toFixed(2)} with ${name}` : '';
  const big = mode() === 'sentence' && wordCount(text) > 4000 ? ' Sentence mode on a whole paper produces a lot of output; a section at a time is easier to work through.' : '';
  els.estimate.textContent = `About ${fmt(Math.round(e.input / 100) * 100)} tokens in and ${fmt(Math.round(e.output / 100) * 100)} out${cost}, in ${e.batches} request${e.batches === 1 ? '' : 's'}.${big}`;
}

async function populateModels() {
  const p = provider();
  els.privacy.href = PROVIDERS[p].privacyUrl;
  const saved = localStorage.getItem(`pardalote.model.${p}`);
  const fill = (list: ModelInfo[]) => {
    models = list;
    clear(els.model);
    for (const m of list) els.model.append(h('option', { value: m.id }, m.name));
    if (!list.length) els.model.append(h('option', { value: '' }, p === 'openai' ? 'Add your OpenAI key to list models' : 'Loading…'));
    if (saved && list.some((m) => m.id === saved)) els.model.value = saved;
    updateStats();
  };
  fill(STATIC_MODELS[p]);
  try {
    const key = keyring.get(p);
    if (p === 'openrouter' || key) {
      const live = await listModels(p, key);
      if (provider() !== p) return;
      // Keep the curated order for Anthropic; add any others after.
      if (p === 'anthropic') {
        const known = new Set(STATIC_MODELS.anthropic.map((m) => m.id));
        fill([...STATIC_MODELS.anthropic, ...live.filter((m) => !known.has(m.id))]);
      } else {
        fill(live);
      }
    }
  } catch (e) {
    if (provider() === p && !models.length) {
      clear(els.model);
      els.model.append(h('option', { value: '' }, 'Couldn’t load models'));
    }
    console.warn(e);
  }
}

async function loadFile(f: File) {
  els.runNote.textContent = '';
  els.runNote.classList.remove('error');
  try {
    if (/\.docx$/i.test(f.name)) {
      const { blocks, messages } = await readDocx(await f.arrayBuffer());
      els.text.value = blocksToText(blocks);
      if (messages.length) console.info('docx import:', messages);
    } else {
      els.text.value = await f.text();
    }
    saveDraft();
    els.runNote.textContent = `Loaded ${f.name}.`;
  } catch (e) {
    els.runNote.textContent = `Couldn’t read ${f.name}: ${(e as Error).message}`;
    els.runNote.classList.add('error');
  }
  updateStats();
}

/* ------------------------------------------------------------------ */
/* Run                                                                   */
/* ------------------------------------------------------------------ */

async function run() {
  els.runNote.textContent = '';
  els.runNote.classList.remove('error');
  const doc = currentDoc();
  if (!doc.paragraphs.length) {
    els.runNote.textContent = 'Add some text first.';
    els.runNote.classList.add('error');
    els.text.focus();
    return;
  }
  if (!prompt) return;
  const p = provider();
  const key = keyring.get(p);
  if (!key) {
    openKeys(`Add your ${PROVIDERS[p].label} key to run the analysis.`, p);
    return;
  }
  const model = els.model.value;
  if (!model) {
    els.runNote.textContent = 'Choose a model.';
    els.runNote.classList.add('error');
    return;
  }
  localStorage.setItem('pardalote.provider', p);
  localStorage.setItem(`pardalote.model.${p}`, model);
  const price = priceFor(models, model);
  abort = new AbortController();
  els.progress.hidden = false;
  els.progressText.textContent = 'Sending your text…';
  try {
    const result = await runAnalysis({
      doc, mode: mode(), prompt, provider: p, apiKey: key, model, structured: els.structured.checked,
      inPrice: price.inPrice, outPrice: price.outPrice, signal: abort.signal,
      onProgress: ({ done, total, streamedChars }) => {
        const part = total > 1 ? `Part ${Math.min(done + 1, total)} of ${total}. ` : '';
        els.progressText.textContent = streamedChars
          ? `${part}Writing comments (${fmt(streamedChars)} characters so far)…`
          : `${part}Reading your text…`;
      },
    });
    lastModel = models.find((m) => m.id === model)?.name ?? model;
    showResult(doc, result);
  } catch (e) {
    if (abort.signal.aborted) {
      els.runNote.textContent = 'Cancelled.';
    } else {
      els.runNote.textContent = (e as Error).message;
      els.runNote.classList.add('error');
    }
  } finally {
    els.progress.hidden = true;
    abort = null;
  }
}

/* ------------------------------------------------------------------ */
/* Result view                                                           */
/* ------------------------------------------------------------------ */

function showResult(doc: SegmentedDoc, result: ViewState['result']) {
  view = { doc, result, hiddenCategories: new Set(), kinds: new Set(['issue', 'strength', 'structure']), threadAim: null, selected: null };
  for (const cb of document.querySelectorAll<HTMLInputElement>('.kind-filter input')) cb.checked = true;
  els.compose.hidden = true;
  els.result.hidden = false;
  const u = result.usage;
  els.usage.textContent = `${result.annotations.length} findings, ${fmt(u.input + u.output)} tokens${u.cost != null ? `, $${u.cost.toFixed(u.cost < 0.1 ? 3 : 2)}` : ''}`;
  clear(els.warnings);
  els.warnings.hidden = !result.warnings.length;
  for (const w of result.warnings) els.warnings.append(h('p', {}, w));
  rerender();
  window.scrollTo({ top: 0 });
}

function rerender() {
  if (!view) return;
  renderLegend(els.legend, view, (cat) => {
    if (view!.hiddenCategories.has(cat)) view!.hiddenCategories.delete(cat);
    else view!.hiddenCategories.add(cat);
    rerender();
  });
  renderSummary(els.summary, view, (aim) => {
    view!.threadAim = view!.threadAim === aim ? null : aim;
    rerender();
  }, goTo);
  renderPage(els.page, view);
  renderFindings(els.findings, view, { go: (a) => focusAnnotation(a), toggleHidden });
}

function toggleHidden(a: Annotation) {
  a.hidden = !a.hidden;
  closePopover();
  rerender();
}

function annByUid(uid: number) {
  return view?.result.annotations.find((a) => a.uid === uid);
}

function flash(el: Element) {
  el.classList.remove('flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('flash');
}

/** Scroll to a sentence or paragraph ID mentioned in a comment. */
function goTo(id: string) {
  const el = document.getElementById(id.includes('.') ? `sent-${id}` : `para-${id}`) ?? document.getElementById(`para-${id.split('.')[0]}`);
  if (!el) return;
  closePopover();
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  flash(el.classList.contains('para') ? el.querySelector('.text') ?? el : el);
}

function focusAnnotation(a: Annotation) {
  if (!view) return;
  if (a.hidden || view.hiddenCategories.has(a.category)) {
    view.hiddenCategories.delete(a.category);
    a.hidden = false;
    rerender();
  }
  view.selected = a.uid;
  document.querySelectorAll('.finding.selected').forEach((x) => x.classList.remove('selected'));
  document.getElementById(`finding-${a.uid}`)?.classList.add('selected');
  const target = els.page.querySelector<HTMLElement>(`[data-uids~="${a.uid}"]`)
    ?? (a.paragraphId ? document.getElementById(`para-${a.paragraphId}`) : null);
  if (!target) return;
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  els.page.querySelectorAll(`[data-uids~="${a.uid}"]`).forEach(flash);
  setTimeout(() => openPopover(target, a.uid, true), 350);
}

/* ------------------------------------------------------------------ */
/* Popover behaviour                                                     */
/* ------------------------------------------------------------------ */

let popState: { anchor: HTMLElement; uids: number[]; active: number; pinned: boolean } | null = null;
let hideTimer = 0;

function openPopover(anchor: HTMLElement, activeUid: number | null, pinned: boolean) {
  const uids = (anchor.dataset.uids ?? '').split(' ').map(Number).filter(Boolean);
  const anns = uids.map(annByUid).filter((x): x is Annotation => !!x);
  if (!anns.length) return;
  // Innermost (most specific) first in the tabs, so a hover shows what's directly under the pointer.
  anns.reverse();
  const active = activeUid ?? anns[0].uid;
  popState?.anchor.classList.remove('active');
  popState = { anchor, uids: anns.map((x) => x.uid), active, pinned };
  anchor.classList.add('active');
  drawPopover();
}

function drawPopover() {
  if (!popState) return;
  const anns = popState.uids.map(annByUid).filter((x): x is Annotation => !!x);
  fillPopover(els.popover, anns, popState.active, popState.pinned, {
    select: (uid) => { popState!.active = uid; popState!.pinned = true; drawPopover(); },
    hide: toggleHidden,
    goTo,
    close: closePopover,
  });
  positionPopover(els.popover, popState.anchor.getBoundingClientRect());
}

function closePopover() {
  popState?.anchor.classList.remove('active');
  popState = null;
  els.popover.hidden = true;
}

function hlFrom(t: EventTarget | null): HTMLElement | null {
  return (t as HTMLElement | null)?.closest?.('[data-uids]') ?? null;
}

els.page.addEventListener('mouseover', (e) => {
  const el = hlFrom(e.target);
  if (!el || popState?.pinned) return;
  clearTimeout(hideTimer);
  if (popState?.anchor !== el) openPopover(el, null, false);
});
els.page.addEventListener('mouseout', (e) => {
  if (popState?.pinned) return;
  const to = e.relatedTarget as Node | null;
  if (to && (els.popover.contains(to) || hlFrom(to) === popState?.anchor)) return;
  hideTimer = window.setTimeout(closePopover, 250);
});
els.popover.addEventListener('mouseenter', () => clearTimeout(hideTimer));
els.popover.addEventListener('mouseleave', () => { if (!popState?.pinned) hideTimer = window.setTimeout(closePopover, 250); });
els.page.addEventListener('click', (e) => {
  const el = hlFrom(e.target);
  if (!el) return;
  if (popState?.anchor === el && popState.pinned) { closePopover(); return; }
  openPopover(el, null, true);
});
els.page.addEventListener('keydown', (e) => {
  const el = hlFrom(e.target);
  if (el && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openPopover(el, null, true);
    els.popover.querySelector<HTMLElement>('button')?.focus();
  }
});
els.page.addEventListener('focusin', (e) => {
  const el = hlFrom(e.target);
  if (el && !popState?.pinned) openPopover(el, null, false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popState) {
    const a = popState.anchor;
    closePopover();
    if (a.tabIndex >= 0) a.focus();
  }
});
document.addEventListener('click', (e) => {
  if (!popState?.pinned) return;
  const t = e.target as Node;
  if (els.popover.contains(t) || hlFrom(t) || (t as HTMLElement).closest?.('.findings')) return;
  closePopover();
});
window.addEventListener('scroll', () => { if (popState && !popState.pinned) closePopover(); else if (popState) positionPopover(els.popover, popState.anchor.getBoundingClientRect()); }, { passive: true });
window.addEventListener('resize', () => { if (popState) positionPopover(els.popover, popState.anchor.getBoundingClientRect()); });

/* ------------------------------------------------------------------ */
/* Keys dialog                                                           */
/* ------------------------------------------------------------------ */

function openKeys(message?: string, focusProvider?: ProviderId) {
  renderKeys(message, focusProvider);
  if (!els.keysDialog.open) els.keysDialog.showModal();
}

function renderKeys(message?: string, focusProvider?: ProviderId) {
  const body = els.keysBody;
  clear(body);
  const msg = h('p', { class: 'msg', role: 'status' }, message ?? '');
  body.append(msg);
  const say = (text: string, kind: 'ok' | 'error' | '' = '') => { msg.textContent = text; msg.className = `msg ${kind}`; };
  const busy = async (btn: HTMLButtonElement, fn: () => Promise<void>) => {
    btn.disabled = true;
    try { await fn(); } catch (e) { say((e as Error).message, 'error'); } finally { btn.disabled = false; }
  };

  // --- Key store ---
  body.append(h('h3', {}, 'Saved keys'));
  if (!keyring.hasVault) {
    const p1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Choose a passphrase', 'aria-label': 'New passphrase' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again', 'aria-label': 'Repeat passphrase' });
    const btn = h('button', { type: 'button', class: 'btn' }, 'Create passphrase');
    btn.addEventListener('click', () => busy(btn, async () => {
      if (p1.value.length < 8) throw new Error('Use at least 8 characters.');
      if (p1.value !== p2.value) throw new Error('The two passphrases don’t match.');
      await keyring.create(p1.value);
      renderKeys('Passphrase set. Keys you save are now encrypted with it.');
    }));
    body.append(
      h('p', { class: 'small' }, 'Keys are encrypted with a passphrase before they’re stored in this browser. You’ll type the passphrase once each time you open Pardalote.'),
      h('div', { class: 'row' }, p1, p2, btn));
  } else if (!keyring.unlocked) {
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passphrase', 'aria-label': 'Passphrase' });
    const btn = h('button', { type: 'button', class: 'btn' }, 'Unlock');
    const go = () => busy(btn, async () => {
      await keyring.unlock(pass.value);
      renderKeys('Unlocked. Keys stay in memory until you close this tab.', focusProvider);
      populateModels();
    });
    btn.addEventListener('click', go);
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const forget = h('button', { type: 'button', class: 'btn ghost danger' }, 'Forget saved keys');
    forget.addEventListener('click', () => busy(forget, async () => {
      if (!confirm('Delete the saved keys from this browser? You can import a key file later if you exported one.')) return;
      await keyring.forgetAll();
      renderKeys('Saved keys deleted.');
    }));
    body.append(
      h('p', { class: 'small' }, `Keys saved for ${keyring.storedProviders().map((p) => PROVIDERS[p].label).join(', ') || 'no providers yet'}. Enter your passphrase to use them.`),
      h('div', { class: 'row' }, pass, btn, forget));
    setTimeout(() => pass.focus(), 0);
  } else {
    const lock = h('button', { type: 'button', class: 'btn ghost' }, 'Lock now');
    lock.addEventListener('click', () => { keyring.lock(); renderKeys('Locked.'); populateModels(); });
    const exp = h('button', { type: 'button', class: 'btn ghost' }, 'Export key file');
    exp.addEventListener('click', () => download('pardalote-keys.json', keyring.exportFile(), 'application/json'));
    body.append(h('p', { class: 'small' }, 'Unlocked for this tab.'), h('div', { class: 'row' }, lock, exp));
  }
  const imp = h('label', { class: 'btn ghost file-btn' }, 'Import key file…', h('input', { type: 'file', accept: '.json,application/json' }));
  imp.querySelector('input')!.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      await keyring.importFile(await f.text());
      renderKeys('Key file imported. Enter its passphrase to unlock it.');
    } catch (err) { say((err as Error).message, 'error'); }
  });
  body.append(h('div', { class: 'row small' }, imp, h('span', { class: 'muted' }, 'The file stays encrypted; it needs the passphrase it was made with.')));

  // --- Providers ---
  for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
    const info = PROVIDERS[p];
    const has = !!keyring.get(p);
    const stored = keyring.storedProviders().includes(p);
    const status = has ? (keyring.isSessionOnly(p) ? 'Using for this session only' : 'Saved and unlocked')
      : stored ? 'Saved, locked' : 'No key';
    const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: has ? 'Replace key' : info.keyHint, 'aria-label': `${info.label} API key` });
    const save = h('button', { type: 'button', class: 'btn', disabled: !keyring.unlocked }, 'Save');
    const session = h('button', { type: 'button', class: 'btn ghost' }, 'Use this session only');
    const remove = h('button', { type: 'button', class: 'btn ghost danger' }, 'Remove');
    const setKey = (sessionOnly: boolean, btn: HTMLButtonElement) => busy(btn, async () => {
      const v = input.value.trim();
      if (!v) throw new Error(`Paste your ${info.label} key first.`);
      await keyring.set(p, v, sessionOnly);
      renderKeys(`${info.label} key ${sessionOnly ? 'set for this session' : 'saved'}.`);
      if (p === provider()) populateModels();
    });
    save.addEventListener('click', () => setKey(false, save));
    session.addEventListener('click', () => setKey(true, session));
    remove.addEventListener('click', () => busy(remove, async () => { await keyring.remove(p); renderKeys(`${info.label} key removed.`); }));
    const block = h('div', { class: 'provider-block' },
      h('h4', {}, info.label, h('span', { class: `status${has ? ' ok' : ''}` }, status)),
      h('div', { class: 'row' }, input, save, session, (has || stored) ? remove : null),
      h('p', { class: 'small muted' }, 'Set a spending limit on this key in ', h('a', { href: info.consoleUrl, target: '_blank', rel: 'noopener' }, `your ${info.label} console`), '.'));
    body.append(block);
    if (p === focusProvider && keyring.unlocked !== false) setTimeout(() => input.focus(), 0);
  }

  // --- Prompt ---
  const promptInput = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain' });
  const loadBtn = h('label', { class: 'btn ghost file-btn' }, 'Load a prompt file…', promptInput);
  promptInput.addEventListener('change', async () => {
    const f = promptInput.files?.[0];
    if (!f) return;
    const txt = await f.text();
    try {
      prompt = parsePromptFile(txt);
      promptText = txt;
      promptWarnings = checkCategories(prompt);
      await kvSet('customPrompt', txt);
      promptSource = 'custom';
      renderKeys(`Loaded ${f.name}.`);
      updateStats();
    } catch (e) { say((e as Error).message, 'error'); }
  });
  const dl = h('button', { type: 'button', class: 'btn ghost' }, 'Download current prompt');
  dl.addEventListener('click', async () => {
    const txt = promptText || await (await fetch('./system-prompt.md')).text(); // clicked before loadPrompt finished
    download('system-prompt.md', txt, 'text/markdown');
  });
  const reset = h('button', { type: 'button', class: 'btn ghost' }, 'Use the default');
  reset.addEventListener('click', async () => { await kvSet('customPrompt', undefined); await loadPrompt(); renderKeys('Back to the default prompt.'); updateStats(); });
  body.append(
    h('h3', {}, 'Analysis rules'),
    h('p', { class: 'small' }, promptSource === 'custom'
      ? 'Using your own prompt file.'
      : 'Using the built-in prompt. Download it, edit it in any text editor, and load it back to change how Pardalote comments.'),
    h('div', { class: 'row' }, loadBtn, dl, promptSource === 'custom' ? reset : null),
    ...promptWarnings.map((w) => h('p', { class: 'small msg error' }, w)));

  body.append(h('p', { class: 'honest' },
    'Your keys never leave this browser except to go to the provider they belong to. While unlocked, a key sits in this tab’s memory, so anything able to run code in the page could read it. Pardalote loads no third-party scripts and restricts network access to the three providers, but a spending limit on each key is still the best protection.'));
}

/* ------------------------------------------------------------------ */
/* Wiring                                                                */
/* ------------------------------------------------------------------ */

let statsTimer = 0;
// The draft survives a reload but not closing the tab (sessionStorage is per tab).
const saveDraft = () => { try { sessionStorage.setItem('pardalote.draft', els.text.value); } catch { /* storage full or blocked */ } };
els.text.addEventListener('input', () => { clearTimeout(statsTimer); statsTimer = window.setTimeout(() => { updateStats(); saveDraft(); }, 250); });
els.file.addEventListener('change', () => { const f = els.file.files?.[0]; if (f) loadFile(f); els.file.value = ''; });
for (const ev of ['dragenter', 'dragover']) els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('dragging'); });
for (const ev of ['dragleave', 'drop']) els.dropzone.addEventListener(ev, () => els.dropzone.classList.remove('dragging'));
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) loadFile(f);
});
$('load-sample').addEventListener('click', async () => {
  els.text.value = await (await fetch('./sample.md')).text();
  saveDraft();
  updateStats();
});
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', updateStats));
els.provider.addEventListener('change', () => { localStorage.setItem('pardalote.provider', provider()); populateModels(); });
els.model.addEventListener('change', () => { localStorage.setItem(`pardalote.model.${provider()}`, els.model.value); updateStats(); });
els.run.addEventListener('click', run);
els.cancel.addEventListener('click', () => abort?.abort());
els.back.addEventListener('click', () => { closePopover(); els.result.hidden = true; els.compose.hidden = false; els.text.focus(); });
$('open-keys').addEventListener('click', () => openKeys());
$('export-html').addEventListener('click', () => view && download(`pardalote-${view.result.mode}.html`, exportHtml(view.doc, view.result, lastModel), 'text/html'));
$('export-md').addEventListener('click', () => view && download(`pardalote-${view.result.mode}-findings.md`, exportMarkdown(view.doc, view.result, lastModel), 'text/markdown'));
document.querySelectorAll<HTMLInputElement>('.kind-filter input').forEach((cb) => cb.addEventListener('change', () => {
  if (!view) return;
  if (cb.checked) view.kinds.add(cb.dataset.kind!); else view.kinds.delete(cb.dataset.kind!);
  closePopover();
  rerender();
}));
els.keysDialog.addEventListener('close', () => updateStats());

(async () => {
  const savedProvider = localStorage.getItem('pardalote.provider') as ProviderId | null;
  if (savedProvider && savedProvider in PROVIDERS) els.provider.value = savedProvider;
  try { const d = sessionStorage.getItem('pardalote.draft'); if (d && !els.text.value) els.text.value = d; } catch { /* ignore */ }
  await Promise.all([keyring.load().catch(() => undefined), loadPrompt().catch((e) => {
    els.runNote.textContent = `Couldn’t load the analysis rules: ${(e as Error).message}`;
    els.runNote.classList.add('error');
  })]);
  await populateModels();
  updateStats();
})();
