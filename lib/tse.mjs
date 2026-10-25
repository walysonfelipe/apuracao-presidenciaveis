// Official TSE presidential adapters (config, EA20 results). No results or candidates are invented.
import { ElectionParties } from './party-colors.mjs';

export const BASE = 'https://resultados.tse.jus.br';
export const CONFIG_URL = `${BASE}/oficial/comum/config/ele-c.json`;
export const CYCLE = 'ele2026';
export const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split(' ');
export const EMPTY_FILL = '#34465b';

const normalize = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const number = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const partyColor = (party) => ElectionParties.colors[normalize(party).replace(/[^a-z]/g, '').toUpperCase()]?.color || ElectionParties.unknown.color;

// Rounds of the presidential election declared for the whole country.
export function presidentialElection(config, round) {
  if (config.f && config.f !== 'o') throw new Error('Configuração fora do ambiente oficial.');
  for (const cycle of config.pl || []) {
    if (cycle.c !== CYCLE) continue;
    for (const election of cycle.e || []) {
      if (String(election.t) !== round || !/^\d+$/.test(String(election.cd))) continue;
      if ((election.abr || []).some((scope) => scope.cd === 'br' && (scope.cp || []).some((office) => Number(office.cd) === 1))) {
        return { code: String(election.cd), round, date: cycle.dt || null };
      }
    }
  }
  return null;
}

export function municipalitiesUrl(election) {
  return `${BASE}/oficial/${CYCLE}/${election.code}/config/mun-e${election.code.padStart(6, '0')}-cm.json`;
}

// IBGE (7 digits, used by the map) -> TSE (5 digits, zero padded) per UF.
export function municipalityCodes(config) {
  if (config.f && config.f !== 'o') throw new Error('Configuração municipal fora do ambiente oficial.');
  if (!Array.isArray(config.abr)) throw new Error('Configuração municipal inválida.');
  const codes = {};
  for (const scope of config.abr) {
    const uf = String(scope.cd).toLowerCase();
    if (!UFS.includes(uf)) continue;
    for (const item of scope.mu || []) {
      const ibge = String(item.cdi || '');
      const tse = String(item.cd || '').padStart(5, '0');
      if (/^\d{7}$/.test(ibge) && /^\d{5}$/.test(tse)) (codes[uf] ||= {})[ibge] = tse;
    }
  }
  if (!Object.keys(codes).length) throw new Error('Configuração sem códigos municipais.');
  return codes;
}

export function resultUrl(election, uf, municipality) {
  if (!/^\d+$/.test(election.code) || !(uf === 'br' || UFS.includes(uf)) || (municipality && !/^\d{5}$/.test(municipality))) throw new Error('Abrangência eleitoral inválida.');
  return `${BASE}/oficial/${CYCLE}/${election.code}/dados/${uf}/${uf}${municipality || ''}-c0001-e${election.code.padStart(6, '0')}-u.json`;
}

export function photoUrl(election, id) {
  if (!/^\d+$/.test(election.code) || !/^\d{1,15}$/.test(id)) throw new Error('Candidatura inválida.');
  return `${BASE}/oficial/${CYCLE}/${election.code}/fotos/br/${id}.jpeg`;
}

export function summarize(data, election, uf, municipality) {
  if (String(data.ele) !== election.code || String(data.t) !== election.round || data.f !== 'o' || String(data.cdabr).toLowerCase() !== (municipality || uf) || !(municipality ? ['mu', 'mun'].includes(data.tpabr) : data.tpabr === (uf === 'br' ? 'br' : 'uf'))) {
    throw new Error('Resultado de outro turno, ambiente ou território.');
  }
  const office = data.carg?.find((item) => Number(item.cd) === 1);
  if (!office || !Array.isArray(office.agr)) throw new Error('Arquivo sem o cargo de Presidente.');
  const candidates = [];
  for (const group of office.agr) {
    for (const party of group.par || []) {
      for (const item of party.cand || []) {
        const votes = number(item.vap);
        if (votes === null || !Number.isSafeInteger(votes)) throw new Error('Votação inválida.');
        if (item.dvt && !normalize(item.dvt).startsWith('valido')) continue;
        candidates.push({ id: String(item.sqcand || item.n), number: String(item.n), name: String(item.nmu || item.nm || 'Candidatura'),
          party: String(party.sg || ''), votes, color: partyColor(party.sg) });
      }
    }
  }
  if (!candidates.length) throw new Error('Arquivo sem candidatos válidos.');
  candidates.sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));
  const total = candidates.reduce((sum, item) => sum + item.votes, 0);
  candidates.forEach((item) => { item.pct = total ? item.votes / total * 100 : 0; });
  const tied = total > 0 && candidates.length > 1 && candidates[0].votes === candidates[1].votes;
  const counted = number(data.s?.pst);
  if (counted !== null && counted > 100) throw new Error('Percentual de seções inválido.');
  const result = {
    candidates, total, tied,
    leader: total && !tied ? candidates[0].id : null,
    margin: total && !tied ? candidates[0].pct - (candidates[1]?.pct || 0) : 0,
    counted,
    // EA20 provides dg/hg without an explicit time zone. Preserve text rather than invent an offset.
    generation: `${data.dg || ''} ${data.hg || ''}`.trim(),
    complete: data.and === 'f' || data.tf === 's',
    // Percentages come from the TSE: blank/null over turnout, turnout/abstention over the electorate.
    votes: { valid: number(data.v?.vv), blank: number(data.v?.vb), blankPct: number(data.v?.pvb),
      null: number(data.v?.tvn ?? data.v?.vn), nullPct: number(data.v?.ptvn ?? data.v?.pvn) },
    electorate: number(data.e?.te),
    turnout: { count: number(data.e?.c), pct: number(data.e?.pc) },
    abstention: { count: number(data.e?.a), pct: number(data.e?.pa) },
  };
  return { ...result, fill: color(result) };
}

function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, l > .5 ? d / (2 - max - min) : d / (max + min), l];
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return `#${[0, 8, 4].map((n) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

// Leader's party hue, always saturated; lighter for close races, deeper as the margin grows.
export function color(result) {
  if (!result?.total) return EMPTY_FILL;
  if (result.tied) return '#a3adbd';
  const [hue, saturation] = hexToHsl(result.candidates[0].color);
  const strength = Math.sqrt(Math.min(50, Math.max(0, result.margin)) / 50);
  return hslToHex(hue, saturation < .15 ? saturation : Math.max(.78, saturation), .68 - .24 * strength);
}
