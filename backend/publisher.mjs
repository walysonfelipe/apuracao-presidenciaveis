import { createHash } from 'node:crypto';
import { LeaseError } from './store.mjs';
import { publicResult, apiCatalog, preparedContexts, publicationSource, nationalAggregate } from './public-data.mjs';

const hash = (body) => createHash('sha256').update(body).digest('hex');
const dataOf = (row) => ({ scope: row.scope, availability: row.result ? 'available' : 'unavailable', result: publicResult(row.result) });

export function buildPublication(context, records, prefix, { states = [] } = {}) {
  const [environment, cycle, election, round, office, uf] = context.split(':');
  if (environment !== 'oficial' || !/^ele\d{4}$/.test(cycle) || !/^\d+$/.test(election) || !/^[12]$/.test(round) || !/^\d{1,4}$/.test(office) || !/^[a-z]{2}$/.test(uf)) {
    throw new Error('Contexto de publicação inválido.');
  }
  const identity = { environment, cycle, election, round, office };
  const base = `${prefix}/${environment}/${cycle}/${election}/${round}/${office}`;
  const country = records.find((row) => row.scope.kind === 'country');
  const state = records.find((row) => row.scope.kind === 'state' && row.scope.uf === uf);
  if (!records.length || records.some((row) => row.scope.kind !== 'country' && row.scope.uf !== uf)) {
    throw new Error('Abrangências incompatíveis com o contexto.');
  }
  const make = (path, payload) => {
    const body = JSON.stringify({ schemaVersion: 1, context: identity, ...payload });
    const version = hash(body);
    return { key: `${base}/${path}/${version}.json`, hash: version, body };
  };
  const objects = {};
  if (country) objects.brasil = make('brasil', { ...dataOf(country), states: states.map(dataOf) });
  if (uf !== 'br') objects.estado = make(`estados/${uf}`, { ...dataOf(state || { scope: { kind: 'state', uf }, result: null }),
    municipalities: records.filter((row) => row.scope.kind === 'municipality').map(dataOf) });
  const descriptors = Object.fromEntries(Object.entries(objects).map(([name, object]) => [name, { key: object.key, hash: object.hash }]));
  const revision = hash(JSON.stringify(descriptors));
  return { identity, uf, objects, descriptors, revision,
    manifestKey: `${base}/manifestos/${uf}.json`, statusKey: `${base}/status/${uf}.json` };
}

export class Publisher {
  constructor({ config, store, storage, now = Date.now }) {
    Object.assign(this, { config, store, storage, now });
    this.running = false;
    this.overviewChecks = new Map();
    this.currentState = { enabled: true, lastError: null, nextAttemptAt: null, lastPublishedAt: null };
  }

  status() { return { ...this.currentState, running: this.running }; }

  async tick(context, collectionStatus, signal) {
    if (!context || this.running) return this.status();
    this.running = true;
    // Include destination in the journal: changing buckets must upload again.
    const target = `${this.config.accountId}:${this.config.bucket}:${this.config.prefix}:${context}`;
    const metaKey = `publication:${target}`;
    let state = this.store.getMeta(metaKey, { failures: 0 });
    const save = () => this.store.setMeta(metaKey, state);
    try {
      this.store.claim();
      const publicState = () => ({ enabled: true, lastError: state.lastError || null,
        nextAttemptAt: state.nextAttemptAt || null, lastPublishedAt: state.lastPublishedAt || null,
        manifestKey: state.manifestKey || null,
        manifestUrl: this.config.publicBaseUrl && state.manifestKey ? `${this.config.publicBaseUrl}/${state.manifestKey}` : null });
      this.currentState = publicState();
      if ((state.nextAttemptAt || 0) > this.now() || (state.nextCheckAt || 0) > this.now()) return this.status();
      signal?.throwIfAborted();
      const fingerprint = `${this.store.revision(context)}:${context.endsWith(':br') ? preparedContexts(this.store, {}).filter((entry) => entry.context.split(':').slice(0, 5).join(':') === context.split(':').slice(0, 5).join(':')).map((entry) => this.store.revision(entry.context)).join(',') : ''}`;
      if (state.fingerprint === fingerprint && this.now() - (state.lastHeartbeatAt || 0) < this.config.heartbeatMs) {
        state = { ...state, nextCheckAt: this.now() + this.config.intervalMs };
        save(); return this.status();
      }
      const { records, states } = publicationSource(this.store, context);
      if (!records.some((row) => row.result)) return this.status();
      const publication = buildPublication(context, records, this.config.prefix, { states });
      const put = async (key, body, immutable) => {
        signal?.throwIfAborted();
        this.store.claim();
        await this.storage.putJson(key, body, immutable, signal);
        this.store.claim();
      };
      let manifest;
      if (state.revision !== publication.revision) {
        for (const object of Object.values(publication.objects)) {
          if (!this.store.uploaded(target, object.key)) {
            await put(object.key, object.body, true);
            this.store.rememberUpload(target, object.key);
          }
        }
        manifest = { schemaVersion: 1, context: publication.identity,
          coverage: { type: publication.uf === 'br' ? 'national' : 'uf', uf: publication.uf, configured: records.length, available: records.filter((row) => row.result).length },
          revision: publication.revision, publishedAt: this.now(), datasets: publication.descriptors,
          statusKey: publication.statusKey };
      }
      if (!state.lastHeartbeatAt || this.now() - state.lastHeartbeatAt >= this.config.heartbeatMs) {
        const heartbeat = { schemaVersion: 1, context: publication.identity, uf: publication.uf,
          heartbeatAt: this.now(), collection: collectionStatus,
          territories: [...records, ...states].map((row) => ({ scope: row.scope, checkedAt: row.checkedAt, attemptedAt: row.attemptedAt, nextAt: row.nextAt,
            availability: row.result ? row.error ? 'stale' : 'available' : 'unavailable', error: row.error })) };
        await put(publication.statusKey, JSON.stringify(heartbeat), false);
        state = { ...state, lastHeartbeatAt: this.now() };
        save();
      }
      if (manifest) {
        // Commit after both data and status exist. A failed upload leaves the previous manifest intact.
        await put(publication.manifestKey, JSON.stringify(manifest), false);
        state = { ...state, revision: publication.revision, objectKeys: Object.values(publication.objects).map((object) => object.key), lastPublishedAt: manifest.publishedAt, manifestKey: publication.manifestKey };
        save();
      }
      const entries = preparedContexts(this.store, { uf: publication.uf }).filter((entry) => {
        const destination = `${this.config.accountId}:${this.config.bucket}:${this.config.prefix}:${entry.context}`;
        return this.store.getMeta(`publication:${destination}`)?.revision;
      });
      const catalogBody = JSON.stringify(apiCatalog(this.config.prefix, entries));
      for (const office of publication.identity.office === '8' ? ['8', '7'] : [publication.identity.office]) {
        if (!['5', '6', '7', '8'].includes(office)) continue;
        const overviewKey = `${this.config.prefix}/api/v1/nacional/${publication.identity.round}/${office}.json`;
        if ((this.overviewChecks.get(overviewKey) || 0) > this.now()) continue;
        const value = nationalAggregate(this.store, publication.identity.round, office);
        if (value) {
          const body = JSON.stringify(value);
          const key = `overview:${this.config.accountId}:${this.config.bucket}:${overviewKey}`;
          if (this.store.getMeta(key) !== hash(body)) {
            await put(overviewKey, body, false);
            this.store.setMeta(key, hash(body));
          }
        }
        this.overviewChecks.set(overviewKey, this.now() + this.config.intervalMs);
      }
      const catalogMeta = `catalog:${this.config.accountId}:${this.config.bucket}:${this.config.prefix}`;
      if (this.store.getMeta(catalogMeta) !== hash(catalogBody)) {
        await put(`${this.config.prefix}/api/v1/config.json`, catalogBody, false);
        this.store.setMeta(catalogMeta, hash(catalogBody));
      }
      const protectedKeys = this.store.publicationKeys(`publication:${this.config.accountId}:${this.config.bucket}:${this.config.prefix}:`);
      for (const key of this.store.retiredObjects(target, this.now() - this.config.retentionMs, protectedKeys)) {
        signal?.throwIfAborted();
        this.store.claim();
        await this.storage.delete(key, signal);
        this.store.claim();
        this.store.forgetUpload(target, key);
      }
      state = { ...state, fingerprint, failures: 0, lastError: null, nextAttemptAt: null, nextCheckAt: this.now() + this.config.intervalMs };
      save();
      this.currentState = publicState();
    } catch (error) {
      if (signal?.aborted || error instanceof LeaseError) throw error;
      // Keep provider error bodies and SDK details out of logs/public diagnostics.
      const failures = (state.failures || 0) + 1;
      state = { ...state, failures, lastError: 'Não foi possível concluir a publicação no R2.',
        nextCheckAt: 0, nextAttemptAt: this.now() + Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 5)) };
      save();
      this.currentState = { ...this.currentState, lastError: state.lastError, nextAttemptAt: state.nextAttemptAt,
        lastPublishedAt: state.lastPublishedAt || null, manifestKey: state.manifestKey || null };
    } finally {
      this.running = false;
    }
    return this.status();
  }
}
