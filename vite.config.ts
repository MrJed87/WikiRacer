import { defineConfig, type Plugin } from 'vitest/config';

// connect-src is limited to OpenRouter and Wikipedia, the only hosts the app talks to.
// Injected at build time only: the dev server needs a websocket for HMR, which this CSP would block.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // Article thumbnails on graph nodes come from Wikimedia's image hosts (WIKI.imageHosts).
  "img-src 'self' data: https://upload.wikimedia.org https://thumb.wikimedia.org",
  "connect-src 'self' https://openrouter.ai https://*.wikipedia.org",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  // Relative base so the static build works from any path (e.g. GitHub Pages).
  base: './',
  plugins: [cspPlugin()],
  build: { target: 'es2022' },
  // Vite blocks unknown host names (DNS-rebinding protection). Allow Tailscale MagicDNS names
  // (*.ts.net) so `tailscale serve` can share the app on your tailnet over HTTPS.
  server: { allowedHosts: ['.ts.net'] },
  preview: { allowedHosts: ['.ts.net'] },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
