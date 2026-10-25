import { source as defaultSource, fetchJson } from './source.mjs';
import { LeaseError } from './store.mjs';

export class PausedError extends Error {}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class Collector {
  constructor({ config, store, source = defaultSource, fetchImpl = fetch, now = Date.now, wait = sleep, random = Math.random }) {
    Object.assign(this, { config, store, source, fetchImpl, now, wait, random });
    this.controller = new AbortController();
    this.gate = Promise.resolve();
    this.prepared = this.store.getMeta(this.configKey);
    this.plans = this.prepared?.plans || [];
    this.contexts = this.plans.map((plan) => plan.context);
    this.context = this.contexts[0] || null;
    this.running = false;
    this.lastError = this.store.getMeta('last-error');
  }

  get configKey() { return `plan:${this.config.cycle}:${this.config.round}:${this.config.uf}:${this.config.offices.join(',')}`; }
  get blockedUntil() { return this.store.getMeta('blocked-until', 0); }

  contextFor(election, uf) {
    return `${this.config.environment}:${this.config.cycle}:${election.code}:${election.round}:${election.office}:${uf}`;
  }

  async request(url) {
    // Serialize starts, not whole responses. Configurations share this same gate.
    const turn = this.gate.then(async () => {
      const signal = this.controller.signal;
      signal.throwIfAborted();
      this.store.claim();
      if (this.blockedUntil > this.now()) throw new PausedError('Coleta em espera.');
      const previous = this.store.getMeta('last-request-at');
      const delay = previous === null ? 0 : Math.max(0, previous + Math.ceil(1000 / this.config.rps) - this.now());
      if (delay) await this.wait(delay, signal);
      signal.throwIfAborted();
      this.store.claim();
      if (this.blockedUntil > this.now()) throw new PausedError('Coleta em espera.');
      this.store.setMeta('last-request-at', this.now());
    });
    this.gate = turn.catch(() => {});
    await turn;
    return fetchJson(url, { signal: this.controller.signal, timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxBytes, fetchImpl: this.fetchImpl, now: this.now });
  }

  pause(error, failures = 0) {
    const status = error.status || 0;
    const retry = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
    let delay;
    if (status === 403 || status === 429) delay = Math.max(600000, retry);
    else if (status === 404) delay = Math.max(60000, retry);
    else delay = Math.max(retry, Math.min(300000, 30000 * 2 ** Math.min(failures, 4)) + Math.floor(this.random() * 5000));
    const until = Math.max(this.blockedUntil, this.now() + delay);
    this.store.setMeta('blocked-until', until);
    if (status === 404) {
      const previous = this.store.getMeta(this.configKey);
      if (previous) this.store.setMeta(this.configKey, { ...previous, expiresAt: 0 });
      this.prepared = null;
    }
    this.lastError = status ? `TSE: HTTP ${status}` : 'Falha ao consultar ou validar a fonte.';
    this.store.setMeta('last-error', this.lastError);
    return until;
  }

  async prepare() {
    const prepared = this.prepared || this.store.getMeta(this.configKey);
    if (prepared && prepared.expiresAt > this.now()) {
      this.prepared = prepared;
      this.plans = prepared.plans;
    } else {
      const elections = this.source.discoverAll(await this.request(this.source.configUrl), this.config);
      const plans = [];
      const byContext = new Map();
      const errors = [];
      const mappings = new Map();
      for (const election of elections) {
        if (!mappings.has(election.code)) {
          const key = `municipal-config:${election.code}`;
          let cached = this.store.getMeta(key);
          if (!cached || cached.nextAt <= this.now()) {
            try {
              const value = await this.request(this.source.municipalitiesUrl(election));
              cached = { value, nextAt: this.now() + this.config.configIntervalMs };
            } catch (error) {
              if (this.controller.signal.aborted || error instanceof LeaseError || error instanceof PausedError || [403, 429].includes(error.status)) throw error;
              errors.push({ election: election.code, status: error.status || 0 });
              cached = { ...cached, nextAt: this.now() + 60000 };
            }
            this.store.setMeta(key, cached);
          }
          mappings.set(election.code, cached.value || null);
        }
        const mapping = mappings.get(election.code);
        if (!mapping) {
          if (!errors.some((error) => error.election === election.code)) errors.push({ election: election.code, status: 0 });
          continue;
        }
        let generated;
        try { generated = this.source.plan(election, mapping, this.config); } catch {
          errors.push({ election: election.code, status: 0 }); continue;
        }
        for (const plan of generated) {
          const context = this.contextFor(election, plan.uf);
          if (byContext.has(context)) {
            const existing = byContext.get(context);
            const known = new Set(existing.scopes.map((scope) => `${scope.uf}:${scope.kind}:${scope.tse || '-'}`));
            existing.scopes.push(...plan.scopes.filter((scope) => !known.has(`${scope.uf}:${scope.kind}:${scope.tse || '-'}`)));
          } else {
            const item = { ...plan, context }; byContext.set(context, item); plans.push(item);
          }
        }
      }
      if (!plans.length) throw Object.assign(new Error('Nenhuma abrangência disponível.'), { status: 404 });
      for (const plan of plans) this.store.seed(plan.context, plan.scopes);
      this.prepared = { plans, errors, expiresAt: this.now() + (errors.length ? 60000 : this.config.configIntervalMs) };
      this.plans = plans;
      this.store.setMeta(this.configKey, this.prepared);
      this.store.setMeta('prepared-contexts', plans.map(({ context, election, scopes }) => ({ context, date: election.date,
        label: election.label, level: election.level, municipalities: election.level === 'municipality' ? scopes.filter((scope) => scope.kind === 'municipality').map(({ ibge, name }) => ({ ibge, name })) : undefined })));
    }
    this.contexts = this.plans.map((plan) => plan.context);
    this.context = this.contexts[0] || null;
    return new Map(this.plans.map((plan) => [plan.context, plan.election]));
  }

  async runOnce() {
    if (this.running) throw new Error('Ciclo de coleta já está em execução.');
    this.running = true;
    try {
      this.controller.signal.throwIfAborted();
      this.store.claim();
      if (this.blockedUntil > this.now()) return this.status();
      let elections;
      try {
        elections = await this.prepare();
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        if (error instanceof LeaseError) throw error;
        if (!(error instanceof PausedError)) {
          const failures = this.store.getMeta('configuration-failures', 0);
          this.pause(error, failures);
          this.store.setMeta('configuration-failures', failures + 1);
        }
        return this.status();
      }
      this.store.setMeta('configuration-failures', 0);
      const queue = this.store.dueContexts(this.contexts, false, this.config.batchSize);
      const pending = new Map(queue.map((task) => [task.key, task]));
      const active = new Set();
      let regionalBurst = 0;
      let regionalQueue = [];
      let refreshRegionalsAt = 0;
      // Refresh Brasil/UF even while a long municipal sweep is in progress.
      const take = () => {
        if (!pending.size) return null;
        if (this.now() >= refreshRegionalsAt) {
          regionalQueue = this.store.dueContexts(this.contexts, true, 32);
          refreshRegionalsAt = this.now() + 1000;
        }
        const regional = regionalQueue.find((task) => !active.has(task.key));
        let municipal;
        for (const task of pending.values()) {
          if (task.scope.kind === 'municipality') { municipal = task; break; }
        }
        const task = regional && (regionalBurst < 2 || !municipal) ? regional : municipal || pending.values().next().value;
        if (active.has(task.key)) return null;
        regionalBurst = task.scope.kind === 'municipality' ? 0 : regionalBurst + 1;
        pending.delete(task.key);
        regionalQueue = regionalQueue.filter((entry) => entry.key !== task.key);
        active.add(task.key);
        return task;
      };
      let stopped = false;
      let hadErrors = false;
      let fatal = null;
      const worker = async () => {
        while (!stopped && !this.controller.signal.aborted) {
          const task = take();
          if (!task) return;
          try {
            const election = elections.get(task.context);
            const data = await this.request(this.source.resultUrl(election, task.scope));
            const result = this.source.summarize(data, election, task.scope);
            const interval = task.scope.kind === 'municipality' ? election.office === '1' ? this.config.municipalIntervalMs : this.config.otherMunicipalIntervalMs : this.config.regionalIntervalMs;
            const nextAt = this.now() + (result.complete ? Math.max(interval, this.config.completeIntervalMs) : interval);
            this.store.success(task.key, result, nextAt);
            this.store.setMeta('consecutive-source-errors', 0);
            this.store.setMeta('outage-failures', 0);
          } catch (error) {
            if (this.controller.signal.aborted) return;
            if (error instanceof LeaseError) {
              stopped = true;
              fatal = error;
              this.stop();
              return;
            }
            if (error instanceof PausedError) { stopped = true; return; }
            hadErrors = true;
            const record = this.store.record(task.key);
            this.lastError = error.status ? `TSE: HTTP ${error.status}` : 'Falha ao consultar ou validar a fonte.';
            this.store.setMeta('last-error', this.lastError);
            let nextAt = Math.max(this.now() + Math.min(300000, 30000 * 2 ** Math.min(record.failures, 4)),
              this.now() + (Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0));
            const failures = this.store.getMeta('consecutive-source-errors', 0) + 1;
            this.store.setMeta('consecutive-source-errors', failures);
            if ([403, 404, 429].includes(error.status) || failures >= 3) {
              stopped = true;
              const outage = this.store.getMeta('outage-failures', 0);
              nextAt = this.pause(error, outage);
              this.store.setMeta('outage-failures', outage + 1);
              if (error.status === 404) nextAt = Math.max(nextAt, this.now() + Math.min(3600000, 60000 * 2 ** Math.min(record.failures, 6)));
            }
            this.store.failure(task.key, this.lastError, nextAt);
          } finally {
            active.delete(task.key);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.config.concurrency, queue.length) }, worker));
      if (fatal) throw fatal;
      if (!hadErrors && !stopped) {
        this.lastError = null;
        this.store.setMeta('last-error', null);
      }
      this.store.setMeta('last-cycle-at', this.now());
      return this.status();
    } finally {
      this.running = false;
    }
  }

  status() {
    return {
      schemaVersion: 1, environment: this.config.environment, cycle: this.config.cycle,
      office: this.config.office, round: this.config.round, uf: this.config.uf,
      context: this.context, contexts: this.contexts.length, preparationErrors: this.prepared?.errors || [], running: this.running,
      blockedUntil: this.blockedUntil || null, lastError: this.lastError,
      lastCycleAt: this.store.getMeta('last-cycle-at'),
      coverage: this.store.snapshotContexts(this.contexts),
    };
  }

  stop() { this.controller.abort(new Error('Coleta encerrada.')); }
}
