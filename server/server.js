#!/usr/bin/env node
// LifeSpeak backend — zero-dependency Node runtime that replaces the
// static-only nginx image. Serves the game (statics) plus the /api/* backend
// that owns all secrets (IMAGE_TEXT_*, GOOGLE_MAPS_*) and the user event log.
//
// Declarative end state (docs/architecture.md "Backend boundary"):
//   Browser ──same-origin /api/*──► this server ──► OpenAI-compatible API
//                                                   Google Maps key bootstrap
//                                                   DATA_DIR JSONL event log
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from './config.js';
import { handleApi } from './api.js';
import { createEventStore } from './eventStore.js';
import { logRequest, logResponse } from './httpLog.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
};

const STATIC_HEADERS = { 'cache-control': 'no-cache' };
const ASSET_HEADERS = { 'cache-control': 'public, max-age=604800, immutable' }; // 7d

export function createServer({ config = serverConfig(), root = config.root, events = null } = {}) {
  const eventStore = events || createEventStore({ dataDir: config.dataDir });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi({ req, res, url, config, events: eventStore });
        return;
      }
      serveStatic({ req, res, url, root });
    } catch (e) {
      const status = e?.statusCode || 500;
      logResponse({ action: 'error', status, body: { error: String(e?.message || e) } });
      if (!res.headersSent) {
        const text = JSON.stringify({ error: String(e?.message || e) });
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(text);
      } else {
        res.destroy();
      }
    }
  });
}

function serveStatic({ req, res, url, root }) {
  const started = Date.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Containment: normalize and require the resolved path to stay under root.
  const filePath = path.normalize(path.join(root, pathname));
  if (!(filePath === root || filePath.startsWith(root + path.sep))) {
    res.writeHead(403).end();
    return;
  }

  let stat = fs.statSync(filePath, { throwIfNoEntry: false });
  let finalPath = filePath;
  if (!stat?.isFile()) {
    // SPA fallback: unknown client-side routes serve index.html (same as the
    // old nginx try_files), but real file extensions 404.
    if (path.extname(pathname)) {
      res.writeHead(404).end();
      return;
    }
    finalPath = path.join(root, 'index.html');
    stat = fs.statSync(finalPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      res.writeHead(404).end();
      return;
    }
  }

  const ext = path.extname(finalPath).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    ...(ext === '.html' || pathname.endsWith('manifest.json') ? STATIC_HEADERS
      : /\.(js|css|png|jpe?g|gif|svg|woff2?|mp3|wav)$/.test(ext) ? ASSET_HEADERS : {}),
  };
  const status = 200;
  logRequest({ action: 'static', url: pathname, method: req.method, headers: req.headers });
  logResponse({ action: 'static', status, body: `<${stat.size} bytes ${ext || 'file'}>`, ms: Date.now() - started });
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(finalPath).pipe(res);
}

// Direct execution (node server/server.js): boot and listen. Under tests we
// import createServer() instead and never reach this branch.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = serverConfig();
  const server = createServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(
      `[server] LifeSpeak listening on http://${config.host}:${config.port} ` +
      `(ai=${config.ai.configured ? 'configured' : 'UNCONFIGURED→mock'}, ` +
      `maps=${config.maps.apiKey ? 'configured' : 'UNCONFIGURED→mock'}, ` +
      `data=${config.dataDir})`,
    );
  });
}
