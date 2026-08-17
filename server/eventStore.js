// Server-side event log: the user-data half of the backend boundary.
// Events arrive from the browser (POST /api/events), are appended to per-day
// JSONL files under DATA_DIR, and are deduped by event `id` so client retries
// never produce duplicate rows.

import fs from 'node:fs';
import path from 'node:path';

function dayStamp(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function createEventStore({ dataDir, fsImpl = fs } = {}) {
  const f = fsImpl;
  const seen = new Set(); // best-effort in-memory dedup cache for this process

  function fileFor(ts) {
    return path.join(dataDir, `events-${dayStamp(ts)}.jsonl`);
  }

  return {
    // Append a batch of events. Returns { stored, deduped } counts.
    append(events) {
      let stored = 0;
      let deduped = 0;
      f.mkdirSync(dataDir, { recursive: true });
      for (const ev of events) {
        if (!ev || typeof ev.id !== 'string' || typeof ev.ts !== 'number') {
          continue; // malformed envelope — counted as deduped/skipped
        }
        if (seen.has(ev.id)) {
          deduped += 1;
          continue;
        }
        seen.add(ev.id);
        f.appendFileSync(fileFor(ev.ts), `${JSON.stringify(ev)}\n`);
        stored += 1;
      }
      return { stored, deduped };
    },

    // Read events back, optionally filtered to one session. Dedupes by id at
    // read time too (an event may span a day boundary restart).
    list({ session = null } = {}) {
      let names = [];
      try {
        names = f.readdirSync(dataDir).filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
      } catch {
        return [];
      }
      const byId = new Map();
      for (const name of names) {
        const text = f.readFileSync(path.join(dataDir, name), 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (!byId.has(ev.id)) byId.set(ev.id, ev);
          } catch {
            // skip corrupt line rather than failing the whole read
          }
        }
      }
      const all = [...byId.values()].sort((a, b) => a.ts - b.ts);
      return session ? all.filter((e) => e.sessionId === session) : all;
    },
  };
}
