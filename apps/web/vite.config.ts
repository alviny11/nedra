import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 'single' mode: inline the JS bundle and CSS into index.html (workers are already inlined with
 * ?worker&inline), producing one self-contained file for offline demo / artifact publishing.
 */
function singleFile(): Plugin {
  return {
    name: 'pipetwin-single-file',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = Object.values(bundle).find((b) => b.type === 'asset' && b.fileName.endsWith('.html'));
      if (!html || html.type !== 'asset') return;
      let text = String(html.source);
      for (const [name, b] of Object.entries(bundle)) {
        if (b.type === 'chunk' && b.isEntry) {
          const tag = new RegExp(`<script[^>]*src="[^"]*${b.fileName.replace(/[.]/g, '\\.')}"[^>]*></script>`);
          const code = b.code.replace(/<\/script>/g, '<\\/script>');
          text = text.replace(tag, () => `<script type="module">${code}</script>`);
          delete bundle[name];
        } else if (b.type === 'asset' && b.fileName.endsWith('.css')) {
          const tag = new RegExp(`<link[^>]*href="[^"]*${b.fileName.replace(/[.]/g, '\\.')}"[^>]*>`);
          text = text.replace(tag, () => `<style>${String(b.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = text;
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'single' ? [singleFile()] : [])],
  resolve: {
    alias: { '@data': resolve(__dirname, '../../data') }
  },
  server: { port: 5173, fs: { allow: [resolve(__dirname, '../..')] } },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000
  },
  worker: { format: 'iife' }
}));
