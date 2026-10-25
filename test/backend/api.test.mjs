import { test, expect } from 'bun:test';
import { Store } from '../../backend/store.mjs';
import { ResultsApi } from '../../backend/api.mjs';
import { loadConfig } from '../../backend/config.mjs';
import { publicResult } from '../../backend/public-data.mjs';
import { TseData } from '../../backend/tse.mjs';
import { result } from '../fixtures/results-api.mjs';

function harness() {
  let time = 1000000;
  const now = () => time;
  const config = loadConfig({});
  const store = new Store(':memory:', { now });
  const context = 'oficial:ele2026:6258:2:1:sp';
  store.setMeta('configuration:2:sp', { election: { code: '6258', round: '2', date: '25/10/2026' } });
  store.seed(context, [{ kind: 'country', uf: 'br' }, { kind: 'state', uf: 'sp' }, { kind: 'municipality', uf: 'sp', ibge: '3550308', tse: '71072' }]);
  for (const item of store.due(context)) store.success(item.key, result(), time + 10000);
  const api = new ResultsApi({ config, store, now });
  return { store, api, now, context, advance: (ms) => { time += ms; }, get: (key, init) => api.respond(new Request(`https://api.example.test/${key}`, init)) };
}

test('API oferece apenas dados persistidos, catálogo e versões compatíveis com R2', async () => {
  const h = harness();
  try {
    const catalog = await h.get('resultados/api/v1/config.json').json();
    expect(catalog.offices).toEqual(['1']);
    expect(Object.keys(catalog.rounds)).toEqual(['2']);
    const manifest = await h.get(catalog.rounds['2'].offices['1'].scopes.sp.manifestKey).json();
    const state = await h.get(manifest.datasets.estado.key).json();
    expect(state.result.total).toBe(100);
    expect(state.municipalities[0].scope.ibge).toBe('3550308');
    expect(state.result.fill).toMatch(/^#[a-f0-9]{6}$/);
    expect(h.get(manifest.datasets.estado.key).headers.get('Cache-Control')).toContain('immutable');
    expect(h.get('backend/.env').status).toBe(404);
    expect(h.get(catalog.rounds['2'].offices['1'].scopes.sp.manifestKey, { method: 'POST' }).status).toBe(405);
  } finally { h.store.close(); }
});

test('API tem CORS explícito e preserva hashes recentes durante atualização', async () => {
  const h = harness();
  try {
    const catalog = await h.get('resultados/api/v1/config.json', { headers: { Origin: 'http://localhost:8000' } }).json();
    expect(h.get('resultados/api/v1/config.json', { headers: { Origin: 'http://localhost:8000' } }).headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8000');
    expect(h.get('resultados/api/v1/config.json', { headers: { Origin: 'https://unknown.example.test' } }).headers.get('Access-Control-Allow-Origin')).toBeNull();
    const old = await h.get(catalog.rounds['2'].offices['1'].scopes.sp.manifestKey).json();
    h.store.success(`${h.context}:sp:71072`, { ...result(), total: 101 }, 2000000);
    h.advance(6000);
    const current = await h.get(catalog.rounds['2'].offices['1'].scopes.sp.manifestKey).json();
    expect(current.datasets.estado.key).not.toBe(old.datasets.estado.key);
    expect(h.get(old.datasets.estado.key).status).toBe(200);
  } finally { h.store.close(); }
});

test('respostas públicas não enviam fotos do TSE e regras eleitorais ficam no backend', () => {
  const fixture = result();
  fixture.candidates[0].photo = 'https://resultados.tse.jus.br/foto.jpeg';
  expect(JSON.stringify(publicResult(fixture))).not.toContain('resultados.tse.jus.br');
  expect(TseData.color({ total: 0 })).toBe('#34465b');
  expect(TseData.color({ total: 100, tied: true })).toBe('#7c899b');
});

test('backend interpreta definição de eleito/segundo turno e respeita ausência de atribuição', () => {
  const raw = { ele: '6258', t: '2', f: 'o', tpabr: 'br', cdabr: 'br', md: 'e',
    dg: '25/10/2026', hg: '18:00:00', carg: [{ cd: '1', agr: [{ par: [{ sg: 'PT', cand: [{ n: '13', nmu: 'A', vap: '60' }, { n: '22', nmu: 'B', vap: '40' }] }] }] }] };
  let parsed = TseData.summarize(raw, { code: '6258', round: '2' }, 'br');
  expect(parsed.defined).toBe(true);
  expect(parsed.candidates[0].outcome).toBe('elected');
  expect(parsed.sourceGeneratedAt).toBeNull();
  parsed = TseData.summarize({ ...raw, ele: '6257', t: '1', md: 's' }, { code: '6257', round: '1' }, 'br');
  expect(parsed.candidates.map((item) => item.outcome)).toEqual(['runoff', 'runoff']);
  parsed = TseData.summarize({ ...raw, esae: 's' }, { code: '6258', round: '2' }, 'br');
  expect(parsed.candidates.every((item) => !item.outcome)).toBe(true);
  raw.carg[0].agr[0].par[0].cand[0].e = 's';
  parsed = TseData.summarize({ ...raw, esae: 's' }, { code: '6258', round: '2' }, 'br');
  expect(parsed.candidates.every((item) => !item.outcome)).toBe(true);
});
