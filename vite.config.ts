import { defineConfig, type Plugin } from 'vite';

/* Strict Content-Security-Policy. connect-src allows only the three provider APIs. */
function csp(): Plugin {
  let dev = false;
  return {
    name: 'pardalote-csp',
    configResolved(c) { dev = c.command === 'serve'; },
    transformIndexHtml(html) {
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        `style-src 'self'${dev ? " 'unsafe-inline'" : ''}`, // dev server injects <style> tags; the build doesn't
        "font-src 'self'",
        "img-src 'self' data:",
        `connect-src 'self' https://api.anthropic.com https://api.openai.com https://openrouter.ai${dev ? ' ws: wss:' : ''}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "worker-src 'self' blob:",
      ].join('; ');
      return html.replace('%CSP%', policy);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [csp()],
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  test: { environment: 'node' },
} as any);
