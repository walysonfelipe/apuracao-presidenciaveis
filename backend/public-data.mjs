import { TseData } from './tse.mjs';
import { UFS } from './config.mjs';

export function publicResult(result) {
  if (!result) return null;
  // Photos are initials until a server-side asset cache is available. Never send TSE image URLs to clients.
  const candidates = (result.candidates || []).map((candidate) => ({ ...candidate, photo: null }));
  const leader = result.leader ? { ...result.leader, photo: null } : null;
  const canColor = Boolean(result.leader?.color || result.tied || !result.total);
  return { ...result, candidates, leader, fill: canColor ? TseData.color(result) : '#34465b' };
}

export function apiCatalog(prefix, entries) {
  const rounds = {};
  const offices = new Set();
  for (const { context, date, label, level, municipalities } of entries) {
    const [environment, cycle, election, round, office, uf] = context.split(':');
    offices.add(office);
    rounds[round] ||= { offices: {} };
    const cargo = rounds[round].offices[office] ||= { label: label || `Cargo ${office}`, scopes: {} };
    if (['5', '6', '7', '8'].includes(office)) cargo.overviewKey = `${prefix}/api/v1/nacional/${round}/${office}.json`;
    const selection = { election, date: date || null, uf, office, level: level || (office === '1' ? 'country' : 'state'), municipalities,
      manifestKey: `${prefix}/${environment}/${cycle}/${election}/${round}/${office}/manifestos/${uf}.json` };
    if (!cargo.scopes[uf]) cargo.scopes[uf] = selection;
    else cargo.scopes[uf] = [...(Array.isArray(cargo.scopes[uf]) ? cargo.scopes[uf] : [cargo.scopes[uf]]), selection];
  }
  return { schemaVersion: 1, environment: 'oficial', cycle: 'ele2026', offices: [...offices].sort((a, b) => Number(a) - Number(b)), rounds };
}

export function preparedContexts(store, config) {
  const index = store.getMeta('prepared-contexts');
  if (index) return index;
  return ['1', '2'].flatMap((round) => [...(config.uf && config.uf !== 'all' ? [config.uf] : UFS)].flatMap((uf) => {
    const prepared = store.getMeta(`configuration:${round}:${uf}`);
    if (!prepared) return [];
    return [{ context: `oficial:ele2026:${prepared.election.code}:${round}:1:${uf}`, date: prepared.election.date }];
  }));
}

export function publicationSource(store, context) {
  const selection = preparedContexts(store, {}).find((entry) => entry.context === context);
  const records = store.exportRecords(context, selection?.level !== 'municipality');
  const parts = context.split(':');
  const states = parts[5] === 'br' ? preparedContexts(store, {}).filter((entry) => {
    const candidate = entry.context.split(':');
    return candidate.slice(0, 5).join(':') === parts.slice(0, 5).join(':') && candidate[5] !== 'br';
  }).map((entry) => store.stateRecord(entry.context)).filter(Boolean) : [];
  return { records, states };
}

export function nationalAggregate(store, round, office) {
  const entries = preparedContexts(store, {}).filter((entry) => {
    const parts = entry.context.split(':');
    return parts[3] === round && (parts[4] === office || (office === '7' && parts[4] === '8')) && parts[5] !== 'br' && entry.level !== 'municipality';
  });
  if (!entries.length) return null;
  const rows = entries.map((entry) => store.stateRecord(entry.context)).filter(Boolean);
  const available = rows.filter((row) => row.result);
  const candidates = available.flatMap((row) => (row.result.candidates || []).map((candidate) => ({ ...candidate, uf: row.scope.uf, id: `${row.scope.uf}:${candidate.id}`, photo: null })));
  candidates.sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));
  const sum = (read) => available.reduce((total, row) => total + (read(row.result) || 0), 0);
  const sections = { counted: sum((result) => result.sections?.counted), total: sum((result) => result.sections?.total) };
  const parties = {};
  for (const row of available) for (const party of row.result.partySeats || []) {
    parties[party.party] ||= { ...party, seats: 0 };
    parties[party.party].seats += party.seats;
  }
  return { schemaVersion: 1, context: { environment: 'oficial', cycle: 'ele2026', election: 'aggregate', round, office }, scope: { kind: 'country', uf: 'br' },
    coverage: { configured: entries.length, available: available.length }, checkedAt: available.length ? Math.min(...available.map((row) => row.checkedAt || 0)) : 0,
    result: available.length ? { aggregate: true, candidates, total: sum((result) => result.total), leader: null, tied: false, margin: 0, fill: '#34465b',
      counted: sections.total ? sections.counted / sections.total * 100 : null, sections, votes: { valid: sum((result) => result.votes?.valid ?? result.total), total: available.every((row) => Number.isFinite(row.result.votes?.total)) ? sum((result) => result.votes?.total) : null },
      complete: available.length === entries.length && available.every((row) => row.result.complete), round, office, election: 'aggregate',
      seats: sum((result) => result.seats), partySeats: Object.values(parties), generation: 'Painel agregado por UF · consultas em momentos diferentes' } : null,
    states: rows.map((row) => ({ scope: row.scope, seats: row.result?.seats ?? null, partySeats: row.result?.partySeats || [], checkedAt: row.checkedAt, error: row.error })) };
}
