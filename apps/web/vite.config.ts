import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function catboostDevApi(): Plugin {
  const root = resolve(__dirname, '../..');
  const saved = resolve(root, 'models/cb-history-d6/result.csv');
  let cache: { body: string; source: string } | null = null;
  return {
    name: 'catboost-dev-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/api/thickness/result.csv') return next();
        if (!cache) {
          const run = spawnSync('python3', ['-c', [
            'import os, sys',
            'from pathlib import Path',
            'sys.path.insert(0, os.environ["PIPETWIN_BACKEND"])',
            'from app.services.thickness import result_csv',
            'sys.stdout.write(result_csv(Path(os.environ["PIPETWIN_ROOT"])))'
          ].join('\n')], {
            cwd: root,
            encoding: 'utf-8',
            timeout: 90_000,
            maxBuffer: 2_000_000,
            env: { ...process.env, PIPETWIN_ROOT: root, PIPETWIN_BACKEND: resolve(root, 'backend') }
          });
          cache = run.status === 0 && run.stdout.startsWith('id,segment_id,thickness_pred')
            ? { body: run.stdout, source: 'live' }
            : { body: readFileSync(saved, 'utf8'), source: 'saved-run' };
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('X-Catboost-Source', cache.source);
        res.end(cache.body);
      });
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), catboostDevApi(), ...(mode === 'single' ? [singleFile()] : [])],
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
