import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    // Inline every asset: the deliverable is one self-contained index.html.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    // Nothing is preloaded in a single-file bundle, and the polyfill's fetch()
    // has no business running from a file:// origin.
    modulePreload: false,
  },
});
