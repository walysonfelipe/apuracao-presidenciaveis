import { CONFIG_URL, UFS, presidentialElection, municipalitiesUrl, municipalityCodes, resultUrl, photoUrl, summarize, color } from './tse.mjs';
import { gzipSync } from 'node:zlib';
import { createStorage } from './storage.mjs';

export class SourceError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} deve ser inteiro entre ${min} e ${max}.`);
  return value;
}

export function loadOptions(env = process.env) {
  return {
    // The TSE allows 100 requests/s per IP and may block for ten minutes; stay well below it.
    rps: integer(env, 'TSE_RPS', 40, 1, 50),
    concurrency: integer(env, 'TSE_CONCURRENCY', 8, 1, 16),
    timeoutMs: integer(env, 'TSE_TIMEOUT_MS', 8000, 100, 60000),
    regionalIntervalMs: integer(env, 'REGIONAL_INTERVAL_MS', 30000, 1000, 86400000),
    municipalIntervalMs: integer(env, 'MUNICIPAL_INTERVAL_MS', 180000, 1000, 86400000),
    completeIntervalMs: integer(env, 'COMPLETE_INTERVAL_MS', 600000, 1000, 86400000),
    persistIntervalMs: integer(env, 'R2_PERSIST_INTERVAL_MS', 10000, 1000, 600000),
  };
}

const round2 = (value) => (value === null || value === undefined ? value : Math.round(value * 100) / 100);
const boot = Math.random().toString(36).slice(2, 8);

// Lean public shape: candidate names, parties and colors go once in `candidates`; each place keeps only ids and numbers.
function compact(entry, limit, roster) {
  if (!entry) return null;
  const result = entry.result;
  if (result) for (const candidate of result.candidates.slice(0, limit)) roster[candidate.id] ||= { name: candidate.name, party: candidate.party, number: candidate.number, color: candidate.color };
  return { checkedAt: entry.checkedAt || 0, error: entry.error || null, result: result && {
    fill: color(result), total: result.total, counted: result.counted, tied: result.tied, leader: result.leader, elected: result.elected || null, decided: result.decided || null,
    complete: result.complete, generation: result.generation,
    candidates: result.candidates.slice(0, limit).map((candidate) => ({ id: candidate.id, votes: candidate.votes, pct: round2(candidate.pct) })),
    votes: result.votes && { blank: result.votes.blank, blankPct: result.votes.blankPct, null: result.votes.null, nullPct: result.votes.nullPct },
    abstention: result.abstention,
  } };
}

// Results are split in chunks: one per round for Brasil + 27 UFs, and one per round/UF with its municipalities.
// Each request answers immediately from memory or R2 and, when items are due, starts one shared refresh.
export function createResults({ fetchImpl = fetch, storage = createStorage(), now = Date.now, wait = sleep, options = loadOptions() } = {}) {
  const chunks = new Map();
  const memo = new Map();
  let gate = Promise.resolve();
  let lastStartAt = 0;
  let pausedUntil = 0;

  async function request(url, { binary = false } = {}) {
    const turn = gate.then(async () => {
      if (pausedUntil > now()) throw new SourceError('Consultas ao TSE em espera.', 429);
      const delay = lastStartAt + Math.ceil(1000 / options.rps) - now();
      if (delay > 0) await wait(delay);
      lastStartAt = now();
    });
    gate = turn.catch(() => {});
    await turn;
    const response = await fetchImpl(url, { redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('Retry-After');
      const retryAfterMs = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : 0;
      if (response.status === 403 || response.status === 429) pausedUntil = Math.max(pausedUntil, now() + Math.max(600000, retryAfterMs));
      throw new SourceError(`TSE: HTTP ${response.status}`, response.status, retryAfterMs);
    }
    if (!binary) return response.json();
    const type = response.headers.get('Content-Type') || '';
    if (!/^image\/(jpeg|png|webp)$/.test(type.split(';')[0])) throw new SourceError('Foto em formato inesperado.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 512000) throw new SourceError('Foto maior que o limite.');
    return { bytes, type: type.split(';')[0] };
  }

  // Small shared values (election config, municipal codes). Keeps the last value when the TSE fails.
  function remember(key, ttlMs, loader) {
    const entry = memo.get(key) || {};
    memo.set(key, entry);
    if (entry.value !== undefined && entry.expiresAt > now()) return entry.value;
    entry.pending ||= loader().then((value) => {
      Object.assign(entry, { value, expiresAt: now() + ttlMs });
      return value;
    }, (error) => {
      if (entry.value === undefined) throw error;
      entry.expiresAt = now() + 30000;
      return entry.value;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }

  async function election(round) {
    // Both rounds come from the same TSE config file: fetch it once and pick the round from it.
    const found = await remember(`election:${round}`, 300000, async () => presidentialElection(await remember('config', 300000, () => request(CONFIG_URL)), round));
    if (!found) throw new SourceError('Este turno ainda não foi configurado pelo TSE.', 404);
    return found;
  }

  function codes(found) {
    return remember(`codes:${found.code}`, 21600000, async () => {
      const key = `config/municipios-${found.code}.json`;
      const saved = await storage?.get(key).catch(() => null);
      if (saved) return saved;
      const value = municipalityCodes(await request(municipalitiesUrl(found)));
      await storage?.put(key, value).catch(() => {});
      return value;
    });
  }

  async function targets(found, uf) {
    if (uf === 'br') return [{ id: 'br', uf: 'br', kind: 'country' }, ...UFS.map((code) => ({ id: code, uf: code, kind: 'state' }))];
    const municipal = Object.entries((await codes(found))[uf] || {}).map(([ibge, tse]) => ({ id: ibge, uf, tse, kind: 'municipality' }));
    return [{ id: uf, uf, kind: 'state' }, ...municipal];
  }

  function dueAt(entry, target) {
    if (!entry) return 0;
    if (entry.error) return (entry.attemptedAt || 0) + Math.min(600000, 60000 * 2 ** Math.min(entry.failures || 0, 4));
    const interval = target.kind === 'municipality' ? options.municipalIntervalMs : options.regionalIntervalMs;
    return entry.checkedAt + (entry.result?.complete ? Math.max(interval, options.completeIntervalMs) : interval);
  }

  // Keep the newest reading of each item when several server instances share the same R2 chunk.
  function merge(chunk, remote) {
    if (!remote || remote.election !== chunk.data.election) return;
    for (const [id, entry] of Object.entries(remote.items || {})) {
      const local = chunk.data.items[id];
      if (!local || Math.max(entry.checkedAt || 0, entry.attemptedAt || 0) > Math.max(local.checkedAt || 0, local.attemptedAt || 0)) chunk.data.items[id] = entry;
    }
    chunk.data.updatedAt = Math.max(chunk.data.updatedAt || 0, remote.updatedAt || 0);
    chunk.version++;
  }

  function persist(chunk) {
    if (!storage || !chunk.dirty) return chunk.saving || Promise.resolve();
    chunk.dirty = false;
    chunk.persistedAt = now();
    const snapshot = JSON.parse(JSON.stringify(chunk.data));
    // Same body as the API, served to browsers by the bucket's public domain; publishedAt lets them spot a stale copy.
    const published = JSON.stringify({ ...view(chunk, chunk.found).payload, publishedAt: now() });
    chunk.saving = (chunk.saving || Promise.resolve()).then(() => Promise.all([
      storage.put(`${chunk.data.election}/${chunk.round}/${chunk.uf}.json`, snapshot),
      storage.putBytes(`publico/${chunk.round}/${chunk.uf}.json`, published, 'application/json; charset=utf-8', 'public, max-age=5'),
    ])).catch(() => { chunk.dirty = true; });
    return chunk.saving;
  }

  // Refresh the most overdue items of a chunk. Without a limit it sweeps everything due (visitor request);
  // background workers pass small limits so every state keeps moving.
  async function refresh(chunk, found, { limit = Infinity, concurrency = options.concurrency } = {}) {
    if (storage && now() - (chunk.mergedAt || 0) >= 30000) {
      merge(chunk, await storage.get(`${found.code}/${chunk.round}/${chunk.uf}.json`).catch(() => null));
      chunk.mergedAt = now();
    }
    const all = await targets(found, chunk.uf);
    chunk.size = all.length;
    const list = all.map((target) => ({ target, at: dueAt(chunk.data.items[target.id], target) }))
      .filter((item) => item.at <= now())
      .sort((a, b) => Number(a.target.kind === 'municipality') - Number(b.target.kind === 'municipality') || a.at - b.at)
      .slice(0, limit).map((item) => item.target);
    let failures = 0;
    let stop = false;
    const worker = async () => {
      while (!stop && list.length) {
        const target = list.shift();
        const previous = chunk.data.items[target.id];
        try {
          const result = summarize(await request(resultUrl(found, target.uf, target.tse)), found, target.uf, target.tse);
          chunk.data.items[target.id] = { checkedAt: now(), attemptedAt: now(), result };
          chunk.data.updatedAt = now();
          failures = 0;
        } catch (error) {
          // Keep the last good result; a failure never turns into zero votes.
          chunk.data.items[target.id] = { ...previous, attemptedAt: now(), failures: (previous?.failures || 0) + 1,
            error: error.status === 404 ? 'missing' : 'unavailable' };
          // Many 404s or errors in a row can get the IP blocked: stop this sweep and back off.
          if ([403, 429].includes(error.status) || ++failures >= 3) {
            stop = true;
            chunk.retryAt = now() + 60000;
          }
        }
        chunk.dirty = true;
        chunk.version++;
        if (now() - (chunk.persistedAt || 0) >= options.persistIntervalMs) persist(chunk);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    if (limit === Infinity) await persist(chunk);
  }

  async function load(chunk, found) {
    const saved = await storage?.get(`${found.code}/${chunk.round}/${chunk.uf}.json`).catch(() => null);
    chunk.data = saved?.election === found.code ? saved : { schemaVersion: 1, election: found.code, round: chunk.round, uf: chunk.uf, updatedAt: 0, items: {} };
    chunk.mergedAt = now();
    chunk.version++;
  }

  async function ensure(round, uf) {
    if (!['1', '2'].includes(round) || !(uf === 'br' || UFS.includes(uf))) throw new SourceError('Seleção inválida.', 400);
    const found = await election(round);
    const key = `${round}:${uf}`;
    if (!chunks.has(key)) chunks.set(key, { round, uf, data: null, loading: null, refreshing: null, checkAt: 0, retryAt: 0, viewedAt: 0, version: 0, size: 0, cached: null });
    const chunk = chunks.get(key);
    chunk.found = found;
    if (chunk.data?.election !== found.code) {
      chunk.loading ||= load(chunk, found).finally(() => { chunk.loading = null; });
      await chunk.loading;
    }
    return { chunk, found };
  }

  // One refresh per chunk at a time, whether started by a visitor or a background worker.
  function start(chunk, found, slice) {
    if (chunk.refreshing || chunk.retryAt > now() || pausedUntil > now()) return null;
    chunk.refreshing = refresh(chunk, found, slice).catch(() => { chunk.retryAt = now() + 60000; })
      .finally(() => { chunk.refreshing = null; chunk.checkAt = now() + 5000; });
    return chunk.refreshing;
  }

  // The public body is built once per chunk version and shared by every visitor until something changes.
  function view(chunk, found) {
    const paused = pausedUntil > now();
    const count = Object.keys(chunk.data.items).length;
    const filling = Boolean(chunk.refreshing) && (!chunk.size || count < chunk.size);
    const key = `${chunk.version}:${filling}:${paused}`;
    // While a chunk fills, its version changes on every item: rebuild at most once per second.
    if (chunk.cached && (chunk.cached.key === key || (chunk.cached.flags === `${filling}:${paused}` && now() - chunk.cached.at < 1000))) return chunk.cached;
    const roster = {};
    const items = {};
    for (const [id, entry] of Object.entries(chunk.data.items)) if (id !== chunk.uf) items[id] = compact(entry, 2, roster);
    const payload = { schemaVersion: 2, election: found.code, date: found.date, round: chunk.round, uf: chunk.uf,
      updatedAt: chunk.data.updatedAt || null, filling, pausedUntil: paused ? pausedUntil : null,
      summary: compact(chunk.data.items[chunk.uf], 12, roster), candidates: roster, items };
    const body = JSON.stringify(payload);
    // Compressed once per version and served as is to everyone who accepts gzip.
    chunk.cached = { key, flags: `${filling}:${paused}`, at: now(), payload, body, gzip: gzipSync(body),
      etag: `W/"${boot}-${found.code}-${chunk.round}-${chunk.uf}-${key.replaceAll(':', '-')}"` };
    return chunk.cached;
  }


  return {
    // Candidate photos: only ids already seen in a loaded summary, so visitors cannot make us probe the TSE.
    async photo(round, id) {
      if (!['1', '2'].includes(round) || !/^\d{1,15}$/.test(id)) throw new SourceError('Seleção inválida.', 400);
      const found = await election(round);
      const known = [...chunks.values()].some((chunk) => chunk.round === round && chunk.data?.election === found.code
        && chunk.data.items[chunk.uf]?.result?.candidates.some((candidate) => candidate.id === id));
      const key = `fotos/${found.code}/${id}.jpeg`;
      return remember(`photo:${key}`, 86400000, async () => {
        const saved = await storage?.getBytes(key).catch(() => null);
        if (saved) return { bytes: saved, type: 'image/jpeg' };
        if (!known) throw new SourceError('Candidatura desconhecida.', 404);
        const value = await request(photoUrl(found, id), { binary: true });
        await storage?.putBytes(key, value.bytes, value.type).catch(() => {});
        return value;
      });
    },

    async scope(round, uf) {
      const { chunk, found } = await ensure(round, uf);
      chunk.viewedAt = now();
      const pending = chunk.checkAt <= now() ? start(chunk, found) : null;
      return { ...view(chunk, found), pending };
    },

    // Load Brasil and every state of each configured round from R2 into memory, without querying results.
    // Workers only refresh the latest round, so this spares the first visitor of an older round the R2 wait.
    async preload(rounds = ['1', '2']) {
      for (const round of rounds) {
        try { await election(round); } catch { continue; }
        await Promise.all(['br', ...UFS].map((uf) => ensure(round, uf).catch(() => {})));
      }
    },

    // Rounds kept warm in the background: 'latest' is the most recent round configured by the TSE.
    async activeRounds(mode = 'latest') {
      if (mode !== 'latest') return mode.split(',').filter((round) => ['1', '2'].includes(round));
      for (const round of ['2', '1']) {
        try { await election(round); return [round]; } catch (error) { if (error.status !== 404) return []; }
      }
      return [];
    },

    // Background step: refresh a small slice of one chunk with items due. Brasil comes first, then chunks
    // someone viewed in the last minutes, then round robin: the chunk served longest ago goes next,
    // so every state advances a slice at a time instead of one big state blocking the others.
    async work({ rounds, slice = 40, concurrency = 2 }) {
      const at = now();
      if (pausedUntil > at) return false;
      let best = null;
      for (const round of rounds) {
        for (const uf of ['br', ...UFS]) {
          let chunk;
          let found;
          try { ({ chunk, found } = await ensure(round, uf)); } catch { continue; }
          if (chunk.refreshing || chunk.retryAt > at) continue;
          const list = await targets(found, uf).catch(() => []);
          if (!list.some((target) => dueAt(chunk.data.items[target.id], target) <= at)) continue;
          const tier = uf === 'br' ? 0 : at - chunk.viewedAt < 300000 ? 1 : 2;
          const servedAt = chunk.servedAt || 0;
          if (!best || tier < best.tier || (tier === best.tier && servedAt < best.servedAt)) best = { chunk, found, tier, servedAt };
        }
      }
      if (!best) return false;
      const pending = start(best.chunk, best.found, { limit: slice, concurrency });
      if (pending) best.chunk.servedAt = now();
      await (pending || Promise.resolve());
      return true;
    },

    // Save chunks changed by background slices, at most once per interval each.
    async flush(force = false) {
      await Promise.all([...chunks.values()].filter((chunk) => chunk.dirty && (force || now() - (chunk.persistedAt || 0) >= options.persistIntervalMs)).map(persist));
    },
  };
}
