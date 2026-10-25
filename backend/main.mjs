import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Collector, sleep } from './collector.mjs';
import { R2Storage } from './r2.mjs';
import { Publisher } from './publisher.mjs';
import { ResultsApi } from './api.mjs';
import { preparedContexts } from './public-data.mjs';

const config = loadConfig();
const store = new Store(config.dbPath);
const collector = new Collector({ config, store });
const storage = config.r2 ? new R2Storage(config.r2) : null;
const publisher = storage ? new Publisher({ config: config.r2, store, storage }) : null;
const api = new ResultsApi({ config, store });
const once = process.argv.includes('--once');
let server;
let stopping = false;
let fatalError = null;

function stop() {
  stopping = true;
  collector.stop();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  // Fail before opening the health port if another process owns this volume.
  store.claim();
  if (!once) {
    server = Bun.serve({
      port: config.port,
      fetch(request) {
        if (new URL(request.url).pathname !== '/healthz') return api.respond(request);
        return Response.json({ process: stopping ? 'stopping' : 'up', ...collector.status(), publication: publisher?.status() || { enabled: false } }, {
          status: stopping ? 503 : 200, headers: { 'Cache-Control': 'no-store' },
        });
      },
    });
    console.log(JSON.stringify({ event: 'collector-started', uf: config.uf, round: config.round, port: server.port }));
  }
  if (once) {
    const status = await collector.runOnce();
    let publication;
    let publicationFailed = false;
    if (publisher) for (const entry of preparedContexts(store, config)) {
      publication = await publisher.tick(entry.context, collector.status(), collector.controller.signal);
      publicationFailed ||= Boolean(publication.lastError);
    }
    console.log(JSON.stringify({ event: 'collector-cycle', ...status, running: false, publication: publication || { enabled: false } }));
    if (status.lastError || status.preparationErrors.length || status.blockedUntil > Date.now() || publicationFailed) process.exitCode = 1;
  } else {
    const collect = async () => {
      while (!stopping) {
        const status = await collector.runOnce();
        console.log(JSON.stringify({ event: 'collector-cycle', ...status, running: false }));
        await sleep(1000, collector.controller.signal);
      }
    };
    const publish = async () => {
      let cursor = 0;
      let cadence = 0;
      let nationalCursor = 0;
      while (!stopping) {
        const entries = preparedContexts(store, config);
        const nationals = entries.filter((entry) => entry.context.endsWith(':1:br'));
        const entry = cadence++ % 8 === 0 && nationals.length ? nationals[nationalCursor++ % nationals.length] : entries[cursor++ % Math.max(1, entries.length)];
        const before = publisher.status();
        const after = await publisher.tick(entry?.context, collector.status(), collector.controller.signal);
        if (before.lastPublishedAt !== after.lastPublishedAt || before.lastError !== after.lastError) {
          console.log(JSON.stringify({ event: 'publication', ...after }));
        }
        await sleep(250, collector.controller.signal);
      }
    };
    const guard = async (task) => {
      try { await task(); } catch (error) {
        if (!stopping) fatalError = error;
        stop();
      }
    };
    await Promise.all([guard(collect), ...(publisher ? [guard(publish)] : [])]);
    if (fatalError) throw fatalError;
  }
} catch (error) {
  if (!stopping || fatalError) {
    console.error(JSON.stringify({ event: 'collector-fatal', message: error.message }));
    process.exitCode = 1;
  }
} finally {
  collector.stop();
  storage?.close();
  server?.stop(true);
  store.close();
}
