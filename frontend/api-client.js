(() => {
  'use strict';

  class ResultsApiClient {
    constructor({ baseUrl = window.AppConfig.apiBaseUrl, prefix = window.AppConfig.dataPrefix, fetchImpl = window.fetch.bind(window), now = Date.now } = {}) {
      this.base = new URL(`${baseUrl.replace(/\/$/, '')}/`);
      this.prefix = prefix;
      this.fetchImpl = fetchImpl;
      this.now = now;
      this.cache = new Map();
    }

    async json(key, signal, immutable = false) {
      const url = new URL(key, this.base);
      if (url.origin !== this.base.origin || !url.pathname.startsWith(`${this.base.pathname}${this.prefix}/`) || url.search || url.hash) {
        throw new Error('Endereço fora da API configurada.');
      }
      const cached = this.cache.get(url.href);
      if (cached && (immutable || this.now() - cached.at < 5000)) return cached.data;
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 20000);
      try {
        const response = await this.fetchImpl(url.href, { signal: controller.signal });
        if (!response.ok) throw Object.assign(new Error('Resultados ainda indisponíveis na API.'), { status: response.status });
        const data = await response.json();
        if (data.schemaVersion !== 1) throw new Error('Versão de dados incompatível.');
        this.cache.set(url.href, { data, at: this.now() });
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
        return data;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }

    catalog(signal) { return this.json(`${this.prefix}/api/v1/config.json`, signal); }

    async scope(round, uf = 'br', signal, office = '1', municipality = null) {
      const catalog = await this.catalog(signal);
      const contest = catalog.rounds?.[round];
      const cargo = contest?.offices?.[office];
      if (uf === 'br' && cargo?.overviewKey) {
        const data = await this.json(cargo.overviewKey, signal);
        if (data.context?.environment !== 'oficial' || data.context.round !== String(round) || data.context.office !== String(office) || data.context.election !== 'aggregate') throw new Error('Painel nacional incompatível.');
        return { context: data.context, result: { scope: data.scope, result: data.result ? this.result(data.result) : null,
          checkedAt: data.checkedAt || 0, error: data.coverage.available < data.coverage.configured ? 'partial' : '' },
          entries: [], catalog, coverage: data.coverage, stale: false };
      }
      const configured = contest?.offices?.[office]?.scopes?.[uf];
      const selections = Array.isArray(configured) ? configured : configured ? [configured] : [];
      const selection = selections.find((entry) => municipality && entry.municipalities?.some((town) => town.ibge === municipality)) || selections[0] || (office === '1' ? contest : null);
      if (!selection || !selection.election || (contest?.offices ? !configured : !['br', selection.uf].includes(uf))) throw Object.assign(new Error('Esta seleção ainda não está disponível na API.'), { status: 404 });
      const manifest = await this.json(selection.manifestKey, signal);
      const identity = manifest.context;
      const validate = (document) => {
        if (document.context?.environment !== 'oficial' || document.context?.round !== String(round) || document.context?.office !== String(office) || document.context?.election !== selection.election) {
          throw new Error('A API respondeu com outra eleição, turno ou cargo.');
        }
        return document;
      };
      validate(manifest);
      const descriptor = manifest.datasets?.[uf === 'br' ? 'brasil' : 'estado'];
      if (!descriptor?.key) throw new Error('Manifesto incompleto.');
      const data = validate(await this.json(descriptor.key, signal, true));
      if (data.scope?.uf !== uf || (uf === 'br' ? data.scope.kind !== 'country' : data.scope.kind !== 'state')) throw new Error('Abrangência incompatível.');
      let status = null;
      try { status = validate(await this.json(manifest.statusKey, signal)); } catch (error) {
        if (signal?.aborted) throw error;
      }
      const territories = new Map((status?.territories || []).map((item) => [`${item.scope.uf}:${item.scope.ibge || '-'}`, item]));
      const entry = (item) => {
        const health = territories.get(`${item.scope.uf}:${item.scope.ibge || '-'}`);
        const result = item.result ? this.result(item.result) : null;
        return { scope: item.scope, result, checkedAt: health?.checkedAt || 0, staleAfterMs: Math.max(240000, (health?.nextAt || 0) - (health?.checkedAt || 0) + 60000),
          error: !status || health?.error || health?.availability === 'stale' || !result ? 'unavailable' : '' };
      };
      const entries = uf === 'br' ? [] : (data.municipalities || []).map(entry);
      if (uf === 'br' && !data.states) {
        // The catalog declares exactly which states the backend currently covers.
        const stateDescriptor = manifest.datasets?.estado;
        if (stateDescriptor) {
          const state = validate(await this.json(stateDescriptor.key, signal, true));
          if (state.scope?.kind !== 'state' || state.scope.uf !== selection.uf) throw new Error('UF incompatível.');
          entries.push(entry(state));
        }
      }
      if (uf === 'br' && data.states) entries.push(...data.states.map(entry));
      const selected = selection.level === 'municipality' ? (data.municipalities || []).find((item) => item.scope.ibge === municipality) || data.municipalities?.[0] : data;
      return { context: identity, result: selected ? entry(selected) : entry(data), entries, catalog, selection, stale: !status || !status.heartbeatAt || this.now() - status.heartbeatAt > 120000 };
    }

    result(result) {
      if (!Array.isArray(result.candidates) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('Resumo inválido da API.');
      if (result.candidates.some((item) => typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.party !== 'string' || !Number.isSafeInteger(item.votes) || item.votes < 0 || !Number.isFinite(item.pct) || item.pct < 0 || item.pct > 100 || !/^#[0-9a-f]{6}$/i.test(item.color))) throw new Error('Candidatura inválida da API.');
      if (!/^#[0-9a-f]{6}$/i.test(result.fill)) throw new Error('Cor inválida da API.');
      return { ...result, candidates: result.candidates.map((item) => ({ ...item, photo: null })) };
    }
  }

  window.ResultsApiClient = ResultsApiClient;
  window.ResultsApi = new ResultsApiClient();
})();
