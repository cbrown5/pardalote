/* End-to-end test in headless Chrome against the built app (vite preview on :4173). */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const key = process.env.ANTHROPIC_API_KEY ?? '';
if (!key) throw new Error('Set ANTHROPIC_API_KEY to run this test.');
const URL = 'http://localhost:4173/';
const shots = 'out/shots';
mkdirSync(shots, { recursive: true });
const only = process.argv[2]; // optional: run one mode

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const problems: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

async function setup(p: Page) {
  await p.goto(URL);
  await p.screenshot({ path: `${shots}/01-compose-empty.png` });
  await p.click('#open-keys');
  await p.fill('input[aria-label="New passphrase"]', 'test passphrase 123');
  await p.fill('input[aria-label="Repeat passphrase"]', 'test passphrase 123');
  await p.click('text=Create passphrase');
  await p.waitForSelector('text=Passphrase set');
  await p.fill('input[aria-label="Anthropic API key"]', key);
  await p.click('.provider-block >> nth=0 >> text=Save');
  await p.waitForSelector('text=Anthropic key saved');
  await p.screenshot({ path: `${shots}/02-keys.png` });
  await p.click('.dialog-close button');
  await p.click('#load-sample');
  await p.waitForFunction(() => (document.getElementById('text') as HTMLTextAreaElement).value.length > 100);
  await p.selectOption('#model', 'claude-sonnet-5-5');
  await p.waitForTimeout(300);
}

async function runMode(p: Page, mode: string, n: string) {
  await p.check(`input[name=mode][value=${mode}]`);
  await p.waitForTimeout(300);
  const est = await p.textContent('#estimate');
  if (mode === 'sentence') await p.screenshot({ path: `${shots}/03-compose-ready.png` });
  const t0 = Date.now();
  await p.click('#run');
  await p.waitForSelector('#result:not([hidden])', { timeout: 300_000 }).catch(async (e) => {
    console.log('run-note:', await p.textContent('#run-note'));
    throw e;
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const stats = await p.evaluate(() => ({
    usage: document.getElementById('usage')!.textContent,
    hl: document.querySelectorAll('#page .hl').length,
    badges: document.querySelectorAll('#page .badge').length,
    handoffs: document.querySelectorAll('#page .handoff').length,
    topics: document.querySelectorAll('#page .topic').length,
    findings: document.querySelectorAll('#findings-list .finding').length,
    warnings: document.getElementById('warnings')!.textContent,
  }));
  console.log(`\n[${mode}] ${secs}s  estimate: ${est}\n  ${JSON.stringify(stats)}`);
  await p.screenshot({ path: `${shots}/${n}-${mode}.png` });
  await p.screenshot({ path: `${shots}/${n}-${mode}-full.png`, fullPage: true });

  // Hover the first issue highlight and capture the popover.
  const target = p.locator('#page .hl[data-style=issue]').first();
  if (await target.count()) {
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await p.waitForSelector('#popover:not([hidden])');
    await p.screenshot({ path: `${shots}/${n}-${mode}-popover.png` });
  }
  if (mode === 'manuscript') {
    await p.evaluate(() => window.scrollTo(0, 0));
    const aims = p.locator('.aims button');
    if (await aims.count() >= 3) {
      await aims.nth(2).click();
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${shots}/${n}-manuscript-thread.png`, fullPage: true });
      await aims.nth(2).click();
    }
  }
  // Exports
  for (const id of ['#export-html', '#export-md']) {
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click(id)]);
    await dl.saveAs(`out/${dl.suggestedFilename()}`);
  }
  // Click a finding, check the popover pins
  await p.locator('.finding-go').nth(1).click();
  await p.waitForTimeout(700);
  const pinned = await p.isVisible('#popover .pin');
  console.log(`  finding click pins popover: ${pinned}`);
  await p.click('#back');
}

await setup(page);
for (const [i, m] of ['sentence', 'paragraph', 'manuscript'].entries()) {
  if (only && only !== m) continue;
  await runMode(page, m, String(i + 4).padStart(2, '0'));
}

// Reload: draft should survive; keys should be locked and unlockable.
await page.reload();
await page.waitForTimeout(500);
console.log('draft kept after reload:', (await page.inputValue('#text')).length > 100);
await page.click('#run');
await page.waitForSelector('dialog[open] input[aria-label="Passphrase"]');
await page.fill('input[aria-label="Passphrase"]', 'wrong one');
await page.click('dialog >> text=Unlock');
await page.waitForSelector('text=Wrong passphrase');
await page.fill('input[aria-label="Passphrase"]', 'test passphrase 123');
await page.click('dialog >> text=Unlock');
await page.waitForSelector('text=Unlocked.');
console.log('\nunlock after reload: ok');
const stored = await page.evaluate(() => new Promise<string>((res) => {
  const r = indexedDB.open('pardalote');
  r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('vault'); g.onsuccess = () => res(JSON.stringify(g.result)); };
}));
console.log('plaintext key in IndexedDB:', stored.includes(key.slice(10, 30)));

// Mobile layout
await page.click('.dialog-close button');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${shots}/10-mobile-compose.png` });

console.log('\nproblems:', problems.length ? problems : 'none');
await browser.close();
