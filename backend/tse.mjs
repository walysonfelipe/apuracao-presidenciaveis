// Official TSE EA11, EA12 and EA20 adapters. No results or candidates are invented.
import { ElectionParties } from './party-colors.mjs';
const BASE = 'https://resultados.tse.jus.br';
const CONFIG_URL = `${BASE}/oficial/comum/config/ele-c.json`;
const CYCLE = 'ele2026';
const normalize = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const number = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const partyColor = (party) => ElectionParties.colors[normalize(party).replace(/[^a-z]/g, '').toUpperCase()]?.color || ElectionParties.unknown.color;

function presidentialElections(config) {
  const elections = new Map();
  for (const cycle of config.pl || []) {
    if (cycle.c !== CYCLE) continue;
    for (const election of cycle.e || []) {
      if (!/^[12]$/.test(String(election.t)) || !/^\d+$/.test(String(election.cd))) continue;
      if (!(election.abr || []).some((scope) => scope.cd === 'br' && (scope.cp || []).some((office) => Number(office.cd) === 1))) continue;
      elections.set(String(election.t), { code: String(election.cd), round: String(election.t), date: cycle.dt });
    }
  }
  return elections;
}

function municipalityCodes(config) {
  if (!Array.isArray(config.abr)) throw new Error('Configuração municipal inválida.');
  const codes = new Map();
  for (const scope of config.abr) {
    const uf = String(scope.cd).toLowerCase();
    if (!/^[a-z]{2}$/.test(uf)) continue;
    for (const item of scope.mu || []) {
      const ibge = String(item.cdi || '');
      const tse = String(item.cd || '').padStart(5, '0');
      if (/^\d{7}$/.test(ibge) && /^\d{5}$/.test(tse)) codes.set(`${uf}:${ibge}`, tse);
    }
  }
  if (!codes.size) throw new Error('Configuração sem códigos municipais.');
  return codes;
}

function resultUrl(election, uf, municipality) {
  if (!/^\d+$/.test(election.code) || !/^[a-z]{2}$/.test(uf) || (municipality && !/^\d{5}$/.test(municipality))) throw new Error('Abrangência eleitoral inválida.');
  const office = election.office || '1';
  if (!/^\d{1,4}$/.test(office)) throw new Error('Cargo inválido.');
  return `${BASE}/oficial/${CYCLE}/${election.code}/dados/${uf}/${uf}${municipality || ''}-c${office.padStart(4, '0')}-e${election.code.padStart(6, '0')}-u.json`;
}

function summarize(data, election, uf, municipality) {
  if (String(data.ele) !== election.code || String(data.t) !== election.round || data.f !== 'o' || String(data.cdabr).toLowerCase() !== (municipality || uf) || !(municipality ? ['mu', 'mun'].includes(data.tpabr) : data.tpabr === (uf === 'br' ? 'br' : 'uf'))) {
    throw new Error('Resultado de outro turno, ambiente ou território.');
  }
  const officeCode = election.office || '1';
  const office = data.carg?.find((item) => String(Number(item.cd)) === officeCode);
  if (!office || !Array.isArray(office.agr)) throw new Error('Arquivo sem o cargo solicitado.');
  const mayDeclare = data.esae !== 's' && (officeCode === '1' ? uf === 'br' : election.level === 'municipality' ? Boolean(municipality) : !municipality && uf !== 'br');
  const candidates = [];
  for (const group of office.agr) {
    for (const party of group.par || []) {
      for (const item of party.cand || []) {
        const votes = number(item.vap);
        if (votes === null) throw new Error('Votação inválida.');
        const valid = !item.dvt || normalize(item.dvt).startsWith('valido');
        const status = String(item.st || '');
        const outcome = !valid || !mayDeclare ? '' : /2[ºo°]?\s*turno|segundo turno/.test(normalize(status)) ? 'runoff'
          : item.e === 's' || (normalize(status).includes('eleito') && !normalize(status).includes('nao')) ? 'elected' : '';
        candidates.push({ id: String(item.sqcand || item.n), number: String(item.n), name: String(item.nmu || item.nm || 'Candidatura'),
          fullName: String(item.nm || ''), party: String(party.sg || ''), votes, pct: number(item.pvap), valid, validity: String(item.dvt || ''), color: partyColor(party.sg), photo: null, status, outcome,
          running: (item.vs || []).map((mate) => ({ type: String(mate.tp || ''), name: String(mate.nmu || mate.nm || ''), party: String(mate.sgp || '') })) });
      }
    }
  }
  if (!candidates.length) throw new Error('Arquivo sem candidatos válidos.');
  candidates.sort((a, b) => Number(b.valid) - Number(a.valid) || b.votes - a.votes || a.id.localeCompare(b.id));
  const validCandidates = candidates.filter((item) => item.valid);
  const total = validCandidates.reduce((sum, item) => sum + item.votes, 0);
  candidates.forEach((item) => { item.pct = item.valid && total ? officeCode !== '1' && item.pct !== null ? item.pct : item.votes / total * 100 : 0; });
  const tied = total > 0 && validCandidates.length > 1 && validCandidates[0].votes === validCandidates[1].votes;
  const complete = data.and === 'f' || data.tf === 's';
  const defined = data.md === 'e' || data.md === 's';
  if (officeCode === '1' && uf === 'br' && data.esae !== 's' && (complete || defined) && total > 0 && !tied && !candidates.some((item) => item.outcome)) {
    if (election.round === '1' && (data.md === 's' || (data.md !== 'e' && candidates[0].pct <= 50))) {
      candidates.slice(0, 2).forEach((item) => { item.outcome = 'runoff'; });
    } else candidates[0].outcome = 'elected';
  }
  return {
    candidates, total, tied, leader: total && !tied ? validCandidates[0] : null,
    margin: total && !tied ? validCandidates[0].pct - (validCandidates[1]?.pct || 0) : 0,
    counted: number(data.s?.pst), generation: `${data.dg || ''} ${data.hg || ''}`.trim(),
    idg: String(data.idg || ''), complete, defined, round: election.round, election: election.code,
    // EA20 provides dg/hg without an explicit time zone. Preserve text rather than invent an offset.
    sourceGeneratedAt: null, office: officeCode, officeLabel: election.label || '',
    seats: number(office.nv), electoralQuotient: number(office.qe),
    partySeats: Object.values(candidates.filter((candidate) => candidate.outcome === 'elected').reduce((parties, candidate) => {
      parties[candidate.party] ||= { party: candidate.party, color: candidate.color, seats: 0 };
      parties[candidate.party].seats++;
      return parties;
    }, {})),
    sections: { counted: number(data.s?.st), total: number(data.s?.ts) },
    votes: { valid: number(data.v?.vv), blank: number(data.v?.vb), null: number(data.v?.tvn ?? data.v?.vn), total: number(data.v?.tv) },
    abstention: { count: number(data.e?.a), pct: number(data.e?.pa) },
  };
}

function color(result) {
  if (!result?.total) return '#34465b';
  if (result.tied) return '#7c899b';
  const base = '#aab8c8';
  const weight = .2 + .8 * Math.sqrt(Math.min(100, result.margin) / 100);
  const channels = [1, 3, 5].map((offset) => Math.round(parseInt(base.slice(offset, offset + 2), 16) * (1 - weight) + parseInt(result.leader.color.slice(offset, offset + 2), 16) * weight));
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export const TseData = Object.freeze({ BASE, CONFIG_URL, CYCLE, presidentialElections, municipalityCodes, resultUrl, summarize, color });
