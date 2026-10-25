(() => {
  'use strict';

  class ResultsMapLoader {
    constructor({ source = window.ResultsApi, now = () => Date.now(), setTimer = (fn, ms) => window.setTimeout(fn, ms), clearTimer = (timer) => window.clearTimeout(timer), onChange = () => {} } = {}) {
      Object.assign(this, { source, now, setTimer, clearTimer, onChange });
      this.records = new Map();
      this.candidates = new Map();
      this.context = { uf: null, items: [], selectedId: null, round: '2' };
      this.epoch = 0;
      this.loading = false;
      this.paused = false;
      this.notice = '';
      this.nextAt = 0;
      this.interval = 10000;
    }

    key(id) { return `${this.context.round}:${this.context.uf || 'br'}:${id}`; }
    record(id) { return this.records.get(this.key(id)); }
    notify() { this.onChange(this.snapshot()); }
    snapshot() {
      const entries = this.context.items.map((item) => this.record(item.id));
      return { round: this.context.round, total: entries.length, municipal: Boolean(this.context.uf),
        checked: entries.filter(Boolean).length, withVotes: entries.filter((entry) => entry?.result?.total > 0).length,
        failed: entries.filter((entry) => entry?.error).length,
        stale: entries.some((entry) => entry?.result && (this.notice || entry.error || this.now() - entry.checkedAt > (entry.staleAfterMs || 240000))),
        candidates: this.candidates.get(this.context.round) || [], loading: this.loading, paused: this.paused, notice: this.notice };
    }

    cancel() { this.epoch++; this.clearTimer(this.timer); this.controller?.abort(); this.loading = false; }
    setScope({ uf = null, items, selectedId = null, round = this.context.round }) {
      this.cancel();
      this.context = { uf: uf?.toLowerCase() || null, items, selectedId, round };
      this.notice = '';
      this.nextAt = 0;
      this.notify(); this.arm();
    }
    select(id) { this.context.selectedId = id; this.notify(); }
    setPaused(paused) {
      if (paused === this.paused) return;
      this.paused = paused;
      if (paused) this.cancel(); else this.arm();
      this.notify();
    }
    arm() {
      this.clearTimer(this.timer);
      if (!this.paused && !this.loading && this.context.items.length) this.timer = this.setTimer(() => this.tick(), Math.max(0, this.nextAt - this.now()));
    }

    async tick() {
      if (this.loading || this.paused) return;
      const epoch = this.epoch;
      const context = this.context;
      this.controller = new AbortController();
      this.loading = true;
      this.notify();
      try {
        const payload = await this.source.scope(context.round, context.uf || 'br', this.controller.signal);
        if (epoch !== this.epoch) return;
        if (payload.result?.result) this.candidates.set(context.round, payload.result.result.candidates);
        const entries = new Map(payload.entries.map((entry) => [context.uf ? entry.scope.ibge : entry.scope.uf, entry]));
        for (const item of context.items) {
          const entry = entries.get(context.uf ? item.id : item.abbr.toLowerCase());
          const old = this.record(item.id);
          if (entry?.result) {
            this.records.set(this.key(item.id), { ...entry, error: payload.stale ? 'unavailable' : entry.error });
            if (context.uf || !payload.result?.result) this.candidates.set(context.round, entry.result.candidates);
          } else this.records.set(this.key(item.id), { ...old, error: 'missing' });
        }
        this.notice = payload.stale ? 'Mostrando os últimos resultados disponíveis.' : '';
        this.nextAt = this.now() + this.interval;
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.notice = error.status === 404 ? 'Esta seleção ainda não está disponível.' : 'Não foi possível atualizar. Mostrando os últimos dados disponíveis.';
        this.nextAt = this.now() + 30000;
      } finally {
        if (epoch === this.epoch) { this.loading = false; this.notify(); this.arm(); }
      }
    }
  }
  window.ResultsMapLoader = ResultsMapLoader;
})();
