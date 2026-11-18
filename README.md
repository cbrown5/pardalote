# Pardalote writing tutor

A browser-only writing tutor for researchers. Paste in a draft, pick a mode, and get your text back with highlights and comments that explain how the writing works: sentence construction, paragraph flow, or whether the manuscript holds together as an argument.

There is no server. The page calls Anthropic, OpenAI or OpenRouter directly from the browser with the user's own key.

## TODO
'Download prompt file' button doesn't work

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (segmenter, anchoring, schema, prompt file, key vault)
npm run build      # static site in dist/
npm run preview    # serve dist/ on http://localhost:4173
```

Live tests (they spend a few cents of API credit):

```bash
ANTHROPIC_API_KEY=sk-ant-… npm run test:live            # all three modes from Node, prints anchoring stats
npm run preview &  ANTHROPIC_API_KEY=sk-ant-… npm run test:browser   # headless Chrome, screenshots in out/shots/
```

`test:browser` needs Chrome at `/usr/bin/google-chrome`; change `executablePath` in `scripts/browser-test.ts` for other systems.

## Deploy

`dist/` is plain static files with relative paths, so any static host works. A GitHub Pages workflow is included (`.github/workflows/pages.yml`): push to `main`, then set Pages → Source to "GitHub Actions" in the repository settings.

The Content-Security-Policy is a `<meta>` tag injected at build time (`vite.config.ts`). If your host can set headers, also send `frame-ancestors 'none'`, which a meta tag can't express.

## Changing how Pardalote comments

The analysis rules live in `public/system-prompt.md`. The app loads it at runtime and sends the `core` section, the chosen mode's section and the `output` section. Keep the `<!-- section: name -->` markers.

Users can also download the prompt from **API keys → Analysis rules**, edit it, and load their copy back; it is kept in the browser.

Highlight categories are an enum in the output schema, so the model can only use categories the app knows. To add or rename one, change `CATEGORIES` and `META` (label and colour) in `src/schema.ts` and describe it in the prompt. The app warns in the API keys dialog if the two disagree.

## How it works

| File | Job |
|---|---|
| `src/segment.ts` | Splits text into paragraphs and sentences and numbers them (`P3`, `P3.S2`). Uses `Intl.Segmenter` with guards for "et al.", "Fig.", "e.g.", "E. coli", etc. Detects headings (Markdown `#`, numbered, or common section names). |
| `src/schema.ts` | JSON Schema per mode (all fields required, objects closed, as strict mode needs) and a lenient validator that normalises casing and drops unknown categories. |
| `src/providers.ts` | Streaming calls. Anthropic uses `output_config.format`; OpenAI and OpenRouter use `response_format: json_schema` (OpenRouter with `require_parameters`). Retries on 429/5xx. Fallback: schema in the prompt plus one validation retry. |
| `src/analyse.ts` | Batching (sentence mode about 40 sentences per request, paragraph mode about 14 paragraphs, breaking at headings; the previous paragraph goes along as read-only context), three requests in parallel, splitting a batch in half if the output runs out. Cost estimate. |
| `src/anchor.ts` | Finds each quote in its sentence: exact, then whitespace- and quote-mark-normalised, then fuzzy, then elsewhere in the paragraph. Anything that still fails is listed as unplaced, never dropped. Flattens nested spans for rendering. |
| `src/render.ts` | Highlights (outermost category as a tint, innermost as an underline whose style shows the kind: wavy = issue, solid = structure, double = strength), margin IDs and topic labels, hand-off markers between paragraphs, findings panel, manuscript summary and aim threads, popovers. |
| `src/keys.ts` | PBKDF2 (600,000 iterations, SHA-256) → AES-GCM. Only ciphertext goes into IndexedDB. Export/import as an encrypted `pardalote-keys.json`. "This session only" keys are never stored. |
| `src/docx.ts` | `.docx` import via mammoth (loaded only when needed). Keeps headings, paragraphs and list items; drops tables, comments and footnotes. |
| `src/export.ts` | Self-contained HTML (no scripts) with numbered notes, and a Markdown findings list. |

All model text reaches the page as text nodes; nothing is inserted as HTML.

## Tested (November 2026)

- All three providers accept browser (CORS) requests, OpenAI included, so no proxy is needed.
- Claude Sonnet 5.5 on the 534-word sample in `public/sample.md`: 14–20 findings per mode, every quote anchored, about $0.06–0.09 per run, 16–40 seconds.
- Headless Chrome: key vault create/unlock/wrong passphrase, all three modes, popovers, aim threads, exports, `.docx` import, reload; no CSP violations.
- OpenAI and OpenRouter calls are implemented but were not run live (no keys for them were available).

## License

MIT. See [LICENSE](LICENSE).
