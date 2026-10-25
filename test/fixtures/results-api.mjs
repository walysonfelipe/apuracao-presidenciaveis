export function result({ round = '2', mode = 'normal', office = '1' } = {}) {
  const votes = mode === 'zero' ? [0, 0] : mode === 'tie' ? [50, 50] : [75, 25];
  const candidates = votes.map((count, index) => ({ id: String(index + 1), number: index ? '13' : '22', name: index ? 'Candidatura B' : 'Candidatura A',
    party: index ? 'PT' : 'PL', votes: count, pct: count, color: index ? '#e5484d' : '#4a5ee8', photo: null, outcome: '', running: [], status: '' }));
  if (['5', '6', '7', '8'].includes(office)) { candidates[0].outcome = 'elected'; candidates[0].status = 'Eleito'; }
  return { office, seats: 2, partySeats: ['5','6','7','8'].includes(office) ? [{ party: 'PL', color: '#4a5ee8', seats: 1 }] : [], candidates, total: votes[0] + votes[1], leader: mode === 'normal' ? candidates[0] : null, tied: mode === 'tie',
    margin: mode === 'normal' ? 50 : 0, fill: mode === 'zero' ? '#34465b' : mode === 'tie' ? '#7c899b' : '#4a5ee8',
    counted: 42.5, complete: false, defined: false, round, election: code(round, office),
    generation: '25/10/2026 18:00:00', sourceGeneratedAt: Date.parse('2026-10-25T21:00:00Z'),
    sections: { counted: 425, total: 1000 }, votes: { valid: votes[0] + votes[1], blank: 0, null: 0, total: votes[0] + votes[1] }, abstention: { count: 0, pct: 0 } };
}

const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split(' ');
const labels = { '1': 'Presidente', '3': 'Governador', '5': 'Senador', '6': 'Deputado Federal', '7': 'Deputado Estadual', '8': 'Deputado Distrital', '25': 'Conselheiro Distrital' };
const code = (round, office) => office === '1' ? round === '2' ? '6258' : '6257' : office === '25' ? '6261' : round === '2' ? '6260' : '6259';
const base = (round, office) => `resultados/oficial/ele2026/${code(round, office)}/${round}/${office}`;

export function apiFixture(path, { ids = ['3550308'], mode = 'normal', now = Date.now() } = {}) {
  const key = path.replace(/^\//, '');
  if (key === 'resultados/api/v1/config.json') {
    const rounds = {};
    for (const round of ['1', '2']) {
      rounds[round] = { offices: {} };
      for (const office of round === '1' ? ['1','3','5','6','7','8','25'] : ['1','3']) {
        const ufs = office === '1' ? ['br', ...UFS] : office === '8' ? ['df'] : office === '7' ? UFS.filter((uf) => uf !== 'df') : office === '25' ? ['pe'] : round === '2' ? ['sp','ac'] : UFS;
        rounds[round].offices[office] = { label: labels[office], scopes: Object.fromEntries(ufs.map((uf) => [uf, {
          election: code(round, office), uf, office, level: office === '25' ? 'municipality' : office === '1' ? 'country' : 'state',
          municipalities: office === '25' ? [{ ibge: '2605459', name: 'Fernando de Noronha' }] : undefined,
          manifestKey: `${base(round, office)}/manifestos/${uf}.json`,
        }])) };
        if (['5','6','7','8'].includes(office)) rounds[round].offices[office].overviewKey = `resultados/api/v1/nacional/${round}/${office}.json`;
      }
    }
    return { schemaVersion: 1, environment: 'oficial', cycle: 'ele2026', offices: Object.keys(labels), rounds };
  }
  const overview = key.match(/api\/v1\/nacional\/([12])\/(\d+)\.json$/);
  if (overview) {
    const [, round, office] = overview;
    const data = result({ round, office, mode });
    data.aggregate = true;
    data.candidates = UFS.flatMap((uf) => result({ round, office, mode }).candidates.map((candidate) => ({ ...candidate, id: `${uf}:${candidate.id}`, uf })));
    data.total *= UFS.length;
    return { schemaVersion: 1, context: { environment: 'oficial', cycle: 'ele2026', election: 'aggregate', round, office },
      scope: { kind: 'country', uf: 'br' }, coverage: { configured: 27, available: 27 }, checkedAt: now, result: data };
  }
  const match = key.match(/oficial\/ele2026\/(\d+)\/([12])\/(\d+)\/(.*)$/);
  if (!match) return null;
  const [, election, round, office, tail] = match;
  const context = { environment: 'oficial', cycle: 'ele2026', election, round, office };
  const uf = tail.includes('/br.') || tail.startsWith('brasil/') ? 'br' : tail.match(/(?:manifestos|status)\/([a-z]{2})\.json/)?.[1] || tail.match(/estados\/([a-z]{2})\//)?.[1] || 'sp';
  const scope = { kind: uf === 'br' ? 'country' : 'state', uf };
  const municipalities = (office === '25' ? ['2605459'] : uf === 'sp' ? ids : []).map((ibge) => ({ kind: 'municipality', uf, ibge, tse: ibge === '3550308' ? '71072' : '00001' }));
  if (tail.startsWith('manifestos/')) return { schemaVersion: 1, context,
    datasets: uf === 'br' ? { brasil: { key: `${base(round, office)}/brasil/${mode}.json` } } : { estado: { key: `${base(round, office)}/estados/${uf}/${mode}.json` } },
    statusKey: `${base(round, office)}/status/${uf}.json` };
  if (tail.startsWith('status/')) return { schemaVersion: 1, context, heartbeatAt: now,
    territories: [...(uf === 'br' ? [{ kind: 'country', uf: 'br' }, ...UFS.map((uf) => ({ kind: 'state', uf }))] : [scope, ...municipalities])]
      .map((scope) => ({ scope, checkedAt: now, attemptedAt: now, availability: 'available', error: null })) };
  if (tail.startsWith('brasil/')) return { schemaVersion: 1, context, scope: { kind: 'country', uf: 'br' }, result: result({ round, mode, office }),
    states: UFS.map((uf) => ({ scope: { kind: 'state', uf }, result: result({ round, mode, office }) })) };
  if (tail.startsWith('estados/')) return { schemaVersion: 1, context, scope, result: office === '25' ? null : result({ round, mode, office }),
    municipalities: municipalities.map((scope) => ({ scope, result: result({ round, mode, office }) })) };
  return null;
}
