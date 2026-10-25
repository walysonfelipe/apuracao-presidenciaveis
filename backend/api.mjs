import { buildPublication } from './publisher.mjs';
import { apiCatalog, preparedContexts, publicationSource, publicResult, nationalAggregate } from './public-data.mjs';

// Read-only API: requests never schedule or fetch upstream TSE data.
export class ResultsApi {
  constructor({ config, store, now = Date.now }) {
    Object.assign(this, { config, store, now });
    this.prefix = config.r2?.prefix || 'resultados';
    this.files = new Map();
    this.refreshedAt = null;
  }

  cache(key, data, immutable = false) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    this.files.set(`/${key}`, { body, immutable, at: this.now() });
    let size = [...this.files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.body), 0);
    for (const [path, file] of this.files) {
      if ((file.immutable && this.now() - file.at > 300000) || (size > 64 * 1024 * 1024 && path !== `/${key}`)) {
        this.files.delete(path); size -= Buffer.byteLength(file.body);
      }
    }
  }

  refresh() {
    if (this.refreshedAt !== null && this.now() - this.refreshedAt < 5000) return;
    this.entries = preparedContexts(this.store, this.config);
    this.cache(`${this.prefix}/api/v1/config.json`, apiCatalog(this.prefix, this.entries));
    this.refreshedAt = this.now();
  }

  renderContext(context) {
    const { records, states } = publicationSource(this.store, context);
    if (!records.length) return;
    const publication = buildPublication(context, records, this.prefix, { states });
    for (const object of Object.values(publication.objects)) this.cache(object.key, object.body, true);
    this.cache(publication.manifestKey, { schemaVersion: 1, context: publication.identity,
      coverage: { type: publication.uf === 'br' ? 'national' : 'uf', uf: publication.uf, configured: records.length, available: records.filter((row) => row.result).length },
      revision: publication.revision, datasets: publication.descriptors, statusKey: publication.statusKey });
    this.cache(publication.statusKey, { schemaVersion: 1, context: publication.identity, uf: publication.uf, heartbeatAt: this.now(),
      collection: { coverage: this.store.snapshot(context), blockedUntil: this.store.getMeta('blocked-until') },
      territories: [...records, ...states].map((row) => ({ scope: row.scope, checkedAt: row.checkedAt, attemptedAt: row.attemptedAt, nextAt: row.nextAt,
        availability: row.result ? row.error ? 'stale' : 'available' : 'unavailable', error: row.error })) });
  }

  respond(request) {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' });
    const origin = request.headers.get('Origin');
    const allowed = this.config.apiOrigins || [];
    if (origin && allowed.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    this.refresh();
    const path = new URL(request.url).pathname;
    const overview = path.startsWith(`/${this.prefix}/api/v1/nacional/`) ? path.match(/\/nacional\/([12])\/(5|6|7|8)\.json$/) : null;
    if (overview && (!this.files.has(path) || this.now() - this.files.get(path).at >= 5000)) {
      const value = nationalAggregate(this.store, overview[1], overview[2]);
      if (value) this.cache(path.slice(1), value);
    }
    const entry = this.entries.find((entry) => {
      const [environment, cycle, election, round, office, uf] = entry.context.split(':');
      return path.startsWith(`/${this.prefix}/${environment}/${cycle}/${election}/${round}/${office}/`) &&
        (path.includes(`/manifestos/${uf}.json`) || path.includes(`/status/${uf}.json`) || path.includes(`/estados/${uf}/`) || path.includes(`/municipios/${uf}/`) || (uf === 'br' && path.includes('/brasil/')));
    });
    const detail = path.match(/\/municipios\/([a-z]{2})\/(\d{7})\.json$/);
    if (entry && detail) {
      const row = this.store.municipalityRecord(entry.context, detail[2]);
      if (row) this.cache(path.slice(1), { schemaVersion: 1,
        context: Object.fromEntries(['environment', 'cycle', 'election', 'round', 'office'].map((key, index) => [key, entry.context.split(':')[index]])),
        scope: row.scope, result: publicResult(row.result), checkedAt: row.checked_at, attemptedAt: row.attempted_at, error: row.error });
    } else if (entry && (!this.files.has(path) || (!this.files.get(path).immutable && this.now() - this.files.get(path).at >= 5000))) this.renderContext(entry.context);
    const file = this.files.get(path);
    headers.set('Cache-Control', file?.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, s-maxage=5, must-revalidate');
    if (!file) { headers.set('Cache-Control', 'no-store'); return new Response(JSON.stringify({ error: 'Resultados ainda indisponíveis para esta seleção.' }), { status: 404, headers }); }
    return new Response(request.method === 'HEAD' ? null : file.body, { headers });
  }
}
