import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = searchForWorkspaceRoot(configDir);

/** Workspace root plus its real path. A symlinked checkout otherwise blocks hoisted node_modules/vite. */
function devAllowDirs(): string[] {
  const dirs = new Set<string>();
  const add = (dir: string) => {
    dirs.add(dir);
    try { dirs.add(realpathSync(dir)); } catch { /* path is not on disk */ }
  };
  add(workspaceRoot);
  add(searchForWorkspaceRoot(process.cwd()));
  try {
    const req = createRequire(fileURLToPath(new URL('./package.json', import.meta.url)));
    add(dirname(req.resolve('vite/dist/client/env.mjs')));
  } catch { /* the workspace entries above still cover a normal install */ }
  return [...dirs];
}

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

function thicknessDevApi(): Plugin {
  const file = resolve(workspaceRoot, 'data/forecasts/result.csv');
  return {
    name: 'thickness-result-csv',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/api/thickness/result.csv') return next();
        const body = readFileSync(file, 'utf8');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('X-Thickness-Source', 'forecast');
        res.end(body);
      });
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), thicknessDevApi(), ...(mode === 'single' ? [singleFile()] : [])],
  resolve: {
    alias: { '@data': resolve(__dirname, '../../data') }
  },
  server: { port: 5173, fs: { allow: devAllowDirs() } },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000
  },
  worker: { format: 'iife' }
}));
