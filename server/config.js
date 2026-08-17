// Server configuration — the ONLY place secrets are read. All values come
// from process.env; the browser never sees them (see docs/architecture.md
// "Backend boundary").
//
//   PORT                    listen port (default 8080)
//   HOST                    bind host (default 0.0.0.0)
//   DATA_DIR                user event log dir (default <repo>/data)
//   IMAGE_TEXT_API_FORMAT   "openai" (only supported format)
//   IMAGE_TEXT_BASE_URL     OpenAI-compatible endpoint base
//   IMAGE_TEXT_MODEL        model id
//   IMAGE_TEXT_API_KEY      the AI secret (also accepts OPENAI_API_KEY)
//   GOOGLE_MAPS_API_KEY     Maps browser key handed to the page at runtime
//   GOOGLE_MAPS_MAP_ID      optional cloud-styled map id
//   AI_BODY_LIMIT           /api/ai/complete body cap (default 1 MB)
//   EVENTS_BODY_LIMIT       /api/events body cap (default 256 KB)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function serverConfig(env = process.env) {
  const aiFormat = env.IMAGE_TEXT_API_FORMAT || '';
  const aiConfigured =
    aiFormat.toLowerCase() === 'openai' &&
    !!(env.IMAGE_TEXT_API_KEY || env.OPENAI_API_KEY) &&
    !!(env.IMAGE_TEXT_BASE_URL || env.OPENAI_BASE_URL) &&
    !!(env.IMAGE_TEXT_MODEL || env.OPENAI_MODEL);
  return {
    port: Number(env.PORT) || 8080,
    host: env.HOST || '0.0.0.0',
    root: ROOT,
    dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
    aiBodyLimit: Number(env.AI_BODY_LIMIT) || 1_048_576,
    eventsBodyLimit: Number(env.EVENTS_BODY_LIMIT) || 262_144,
    ai: {
      configured: aiConfigured,
      baseURL: (env.IMAGE_TEXT_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/+$/, ''),
      model: env.IMAGE_TEXT_MODEL || env.OPENAI_MODEL || '',
      apiKey: env.IMAGE_TEXT_API_KEY || env.OPENAI_API_KEY || '',
    },
    maps: {
      apiKey: env.GOOGLE_MAPS_API_KEY || env.GOOGLE_MAPS_KEY || '',
      mapId: env.GOOGLE_MAPS_MAP_ID || '',
    },
  };
}
