import type { RawBlock } from './types';

/**
 * Read a .docx into blocks. Headings, paragraphs and list items are kept;
 * comments, footnotes, endnotes, images and tables are dropped.
 */
export async function readDocx(buf: ArrayBuffer): Promise<{ blocks: RawBlock[]; messages: string[] }> {
  const mammoth = (await import('mammoth')).default;
  const res = await mammoth.convertToHtml({ arrayBuffer: buf }, { includeDefaultStyleMap: true, ignoreEmptyParagraphs: true });
  const parsed = new DOMParser().parseFromString(res.value, 'text/html');
  const blocks: RawBlock[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (/^h[1-6]$/.test(tag)) {
        if (text) blocks.push({ kind: 'heading', level: Number(tag[1]), text });
      } else if (tag === 'p') {
        if (text) blocks.push({ kind: 'paragraph', text });
      } else if (tag === 'ul' || tag === 'ol') {
        if (child.querySelector(':scope > li[id^="footnote"], :scope > li[id^="endnote"], :scope > li[id^="comment"]')) continue;
        for (const li of Array.from(child.querySelectorAll(':scope > li'))) {
          const t = (li.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (t) blocks.push({ kind: 'paragraph', text: t });
        }
      } else if (tag === 'table') {
        continue;
      } else {
        walk(child);
      }
    }
  };
  walk(parsed.body);
  // Drop footnote/endnote back-references like "[1]" that mammoth inserts.
  for (const b of blocks) b.text = b.text.replace(/\[\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
  return { blocks: blocks.filter((b) => b.text), messages: res.messages.map((m: { message: string }) => m.message) };
}

/** Turn blocks back into plain text for the editor (headings as "# Heading"). */
export function blocksToText(blocks: RawBlock[]): string {
  return blocks.map((b) => (b.kind === 'heading' ? `${'#'.repeat(b.level ?? 2)} ${b.text}` : b.text)).join('\n\n');
}
