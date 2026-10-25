import { TseData } from './tse.mjs';
import { UFS } from './config.mjs';

export class SourceError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export async function fetchJson(url, { signal, timeoutMs, maxBytes, fetchImpl = fetch, now = Date.now }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Tempo de consulta excedido.')), timeoutMs);
  let reader;
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceError(`TSE: HTTP ${response.status}`, response.status, retryAfterMs(response.headers.get('Retry-After'), now()));
    }
    const length = Number(response.headers.get('Content-Length'));
    if (length > maxBytes) {
      await response.body?.cancel();
      throw new SourceError('Resposta maior que o limite configurado.');
    }
    if (!response.body) throw new SourceError('Resposta vazia.');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SourceError('Resposta maior que o limite configurado.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    await reader?.cancel().catch(() => {});
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const source = {
  configUrl: TseData.CONFIG_URL,
  discover(config, round) {
    const election = TseData.presidentialElections(config).get(round);
    if (!election) throw new SourceError('Turno presidencial ainda não configurado.', 404);
    return election;
  },
  discoverAll(config, options) {
    if (config.f && config.f !== 'o') throw new Error('Configuração fora do ambiente oficial.');
    const found = [];
    for (const cycle of config.pl || []) {
      if (cycle.c !== options.cycle) continue;
      for (const item of cycle.e || []) {
        const round = String(item.t);
        if (!/^[12]$/.test(round) || !/^\d+$/.test(String(item.cd)) || (options.round !== 'all' && round !== options.round)) continue;
        const offices = new Map();
        for (const scope of item.abr || []) {
          if (scope.cd !== 'br' && !UFS.has(String(scope.cd).toLowerCase())) continue;
          for (const cargo of scope.cp || []) {
            const office = String(Number(cargo.cd));
            if (!/^[1-9]\d{0,3}$/.test(office) || String(cargo.tp) === '3' || (options.offices && !options.offices.includes('all') && !options.offices.includes(office))) continue;
            if (!offices.has(office)) offices.set(office, { code: String(item.cd), round, office, label: String(cargo.ds || `Cargo ${office}`),
              date: cycle.dt, type: String(item.tp || ''), level: ['3', '4'].includes(String(item.tp)) ? 'municipality' : office === '1' ? 'country' : 'state', declarations: [] });
            offices.get(office).declarations.push({ uf: String(scope.cd).toLowerCase(), municipalities: scope.mu?.map((town) => String(town.cd).padStart(5, '0')) || null });
          }
        }
        found.push(...offices.values());
      }
    }
    if (!found.length) throw new SourceError('Nenhuma eleição configurada para os filtros.', 404);
    return found;
  },
  plan(election, mapping, options) {
    if (mapping.f && mapping.f !== 'o') throw new Error('Configuração municipal fora do ambiente oficial.');
    if (!Array.isArray(mapping.abr)) throw new Error('Configuração municipal inválida.');
    const codes = mapping.abr.some((scope) => scope.mu?.length) ? TseData.municipalityCodes(mapping) : new Map();
    const names = new Map((mapping.abr || []).flatMap((scope) => (scope.mu || []).map((town) => [`${String(scope.cd).toLowerCase()}:${String(town.cd).padStart(5, '0')}`, String(town.nm || town.n || town.cdi || '')])));
    const plans = [];
    if (election.office === '1' && election.declarations.some((scope) => scope.uf === 'br')) plans.push({ election, uf: 'br', scopes: [{ kind: 'country', uf: 'br' }] });
    for (const uf of UFS) {
      if (options.uf !== 'all' && options.uf !== uf) continue;
      if ((election.office === '7' && uf === 'df') || (election.office === '8' && uf !== 'df')) continue;
      const declarations = election.declarations.filter((scope) => scope.uf === 'br' || scope.uf === uf);
      if (!declarations.length) continue;
      const unrestricted = declarations.some((scope) => !scope.municipalities);
      const allowed = new Set(declarations.flatMap((scope) => scope.municipalities || []));
      const municipalities = [...codes].filter(([key, tse]) => key.startsWith(`${uf}:`) && (unrestricted || allowed.has(tse)))
        .map(([key, tse]) => ({ kind: 'municipality', uf, tse, ibge: key.split(':')[1], name: names.get(`${uf}:${tse}`) || key.split(':')[1] }));
      if (!municipalities.length && election.level === 'municipality') continue;
      if (new Set(municipalities.map((scope) => scope.tse)).size !== municipalities.length) throw new Error('Correspondência municipal duplicada.');
      const scopes = election.level === 'municipality' ? municipalities : [{ kind: 'state', uf }, ...municipalities];
      plans.push({ election, uf, scopes });
    }
    return plans;
  },
  municipalitiesUrl(election) {
    if (!/^\d+$/.test(election.code)) throw new Error('Eleição inválida.');
    return `${TseData.BASE}/oficial/${TseData.CYCLE}/${election.code}/config/mun-e${election.code.padStart(6, '0')}-cm.json`;
  },
  municipalities(config, uf) {
    if (config.f && config.f !== 'o') throw new Error('Configuração fora do ambiente oficial.');
    const entries = [...TseData.municipalityCodes(config)]
      .filter(([key]) => key.startsWith(`${uf}:`))
      .map(([key, tse]) => ({ kind: 'municipality', uf, ibge: key.split(':')[1], tse }));
    if (!entries.length) throw new Error('UF sem correspondência municipal; conferir a configuração e a abrangência.');
    if (new Set(entries.map((item) => item.tse)).size !== entries.length) throw new Error('Códigos TSE municipais duplicados na UF.');
    return entries;
  },
  resultUrl(election, scope) {
    return TseData.resultUrl(election, scope.uf, scope.tse);
  },
  summarize(data, election, scope) {
    const result = TseData.summarize(data, election, scope.uf, scope.tse);
    if (result.candidates.some((candidate) => !Number.isSafeInteger(candidate.votes)) || !Number.isSafeInteger(result.total)) {
      throw new Error('Votos devem ser inteiros seguros.');
    }
    if (result.counted !== null && result.counted > 100) throw new Error('Percentual de seções inválido.');
    if (result.candidates.some((candidate) => !Number.isFinite(candidate.pct) || candidate.pct < 0 || candidate.pct > 100)) throw new Error('Percentual de candidatura inválido.');
    return result;
  },
};
