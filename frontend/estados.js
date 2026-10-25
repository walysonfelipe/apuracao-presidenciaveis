// The page renders normalized API data; election rules and TSE formats live in the backend.
const $ = (selector) => document.querySelector(selector);
const numberFormat = new Intl.NumberFormat('pt-BR');
const PAGE_SIZE = 100;
const PRIORITY_PHOTOS = 10;
const normalize = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const formatPct = (value) => Number.isFinite(value) ? `${value.toFixed(2).replace('.', ',')}%` : '—';
const count = (value) => Number.isFinite(value) ? numberFormat.format(value) : '—';
const state = { uf: 'sp', office: '1', round: '2', query: '', electedOnly: false, limit: PAGE_SIZE, result: null, candidates: [], request: 0, timer: 0, catalog: null, municipality: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function showMessage(text) { $('#message').hidden = !text; $('#message').textContent = text; }
function setStatus(kind, text) { $('#status-tag').dataset.state = kind; $('#status-text').textContent = text; }
const UFS = [
  ['br', 'Brasil (nacional)'], ['ac', 'Acre'], ['al', 'Alagoas'], ['ap', 'Amapá'], ['am', 'Amazonas'],
  ['ba', 'Bahia'], ['ce', 'Ceará'], ['df', 'Distrito Federal'], ['es', 'Espírito Santo'], ['go', 'Goiás'],
  ['ma', 'Maranhão'], ['mt', 'Mato Grosso'], ['ms', 'Mato Grosso do Sul'], ['mg', 'Minas Gerais'],
  ['pa', 'Pará'], ['pb', 'Paraíba'], ['pr', 'Paraná'], ['pe', 'Pernambuco'], ['pi', 'Piauí'],
  ['rj', 'Rio de Janeiro'], ['rn', 'Rio Grande do Norte'], ['rs', 'Rio Grande do Sul'], ['ro', 'Rondônia'],
  ['rr', 'Roraima'], ['sc', 'Santa Catarina'], ['sp', 'São Paulo'], ['se', 'Sergipe'], ['to', 'Tocantins'],
];
const OFFICES = [
  { cd: '1', label: 'Presidente' },
  { cd: '3', label: 'Governador' },
  { cd: '5', label: 'Senador' },
  { cd: '6', label: 'Deputado Federal' },
  { cd: '7', label: 'Deputado Estadual' },
  { cd: '8', label: 'Deputado Distrital' },
];

function summaryCard(label, value, detail, progress) {
  const card = element('div', 'summary-card');
  card.append(element('span', 'field-label', label), element('strong', '', value));
  if (detail) card.append(element('small', '', detail));
  if (progress !== undefined) {
    const bar = element('div', 'summary-progress');
    const fill = element('span');
    fill.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    bar.append(fill);
    card.append(bar);
  }
  return card;
}

function runningMatesText(running) {
  if (!running.length) return '';
  const vice = running.filter((mate) => mate.type === 'v').map((mate) => mate.name);
  const substitutes = running.filter((mate) => mate.type !== 'v').map((mate) => mate.name);
  return [vice.length ? `Vice: ${vice.join(', ')}` : '', substitutes.length ? `Suplentes: ${substitutes.join(', ')}` : '']
    .filter(Boolean).join(' · ');
}

function candidateRow(candidate, topVotes, index) {
  const outcome = candidate.outcome || candidate.projection;
  const row = element('li', `candidate${outcome ? ` is-${outcome}` : ''}${candidate.projection ? ' is-projected' : ''}`);
  row.append(element('span', 'candidate-rank', String(candidate.rank).padStart(2, '0')));

  // Lazy images only load while in the document, so the photo goes in right
  // away over the initial and is dropped when the TSE has no file for it.
  const photo = element('span', 'candidate-photo');
  photo.append(element('span', 'candidate-initial', candidate.name.trim().charAt(0)));
  if (candidate.photo) {
  const image = new Image();
  image.loading = 'lazy';
  image.decoding = 'async';
  image.fetchPriority = index < PRIORITY_PHOTOS ? 'high' : 'low';
  image.width = 52;
  image.height = 52;
  image.alt = '';
  image.addEventListener('load', () => image.classList.add('is-loaded'), { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = candidate.photo;
  photo.append(image);
  }
  row.append(photo);

  const info = element('div', 'candidate-info');
  const name = element('div', 'candidate-name', candidate.name);
  name.append(element('span', 'candidate-number', candidate.number));
  if (candidate.outcome === 'elected') name.append(element('span', 'tag tag-elected', candidate.status.toUpperCase() || 'ELEITO'));
  else if (candidate.outcome === 'runoff') name.append(element('span', 'tag tag-runoff', '2º TURNO'));
  else if (candidate.projection === 'elected') name.append(element('span', 'tag tag-elected tag-projected', 'PROJEÇÃO: ELEITO'));
  else if (candidate.projection === 'runoff') name.append(element('span', 'tag tag-runoff tag-projected', 'PROJEÇÃO: 2º TURNO'));
  else if (candidate.status) name.append(element('span', 'tag', candidate.status.toUpperCase()));
  if (candidate.validity && !normalize(candidate.validity).startsWith('valido')) {
    name.append(element('span', 'tag tag-invalid', candidate.validity.toUpperCase()));
  }
  info.append(name, element('div', 'candidate-detail', [candidate.uf?.toUpperCase(), candidate.party, candidate.group, candidate.fullName].filter(Boolean).join(' · ')));
  const mates = runningMatesText(candidate.running);
  if (mates) info.append(element('div', 'candidate-extra', mates));
  row.append(info);

  const votes = element('div', 'candidate-votes');
  // In the national list the percentage is of the candidate's own state.
  const pct = candidate.uf ? `${formatPct(candidate.pct)} em ${candidate.uf.toUpperCase()}` : formatPct(candidate.pct);
  votes.append(element('strong', '', pct), element('small', '', `${numberFormat.format(candidate.votes)} votos`));
  row.append(votes);

  const bar = element('span', 'candidate-bar');
  const fill = element('span');
  fill.style.width = `${topVotes ? candidate.votes / topVotes * 100 : 0}%`;
  bar.append(fill);
  row.append(bar);
  return row;
}


function renderSummary() {
  const result = state.result;
  if (!result) { $('#summary').replaceChildren(); return; }
  const votes = result.votes || {};
  $('#summary').replaceChildren(
    summaryCard('SEÇÕES TOTALIZADAS', formatPct(result.counted), result.complete ? 'Totalização finalizada' : `${count(result.sections?.counted)} de ${count(result.sections?.total)}`, result.counted ?? 0),
    summaryCard('VOTOS VÁLIDOS', count(votes.valid ?? result.total)),
    summaryCard('BRANCOS', count(votes.blank)),
    summaryCard('NULOS', count(votes.null)),
    summaryCard('ABSTENÇÃO', formatPct(result.abstention?.pct), `${count(result.abstention?.count)} eleitores`),
  );
}
function renderCandidates() {
  const query = normalize(state.query);
  const filtered = state.candidates.filter((candidate) => (!state.electedOnly || candidate.outcome) &&
    (!query || [candidate.name, candidate.fullName, candidate.number, candidate.party].some((value) => normalize(value).includes(query))));
  $('#candidates').replaceChildren(...filtered.slice(0, state.limit).map((candidate, index) => candidateRow(candidate, state.candidates[0]?.votes || 0, index)));
  $('#results-count').textContent = state.result ? `${filtered.length} de ${state.candidates.length} candidatos` : '';
  $('#more-button').hidden = filtered.length <= state.limit;
  $('#more-button').textContent = `Mostrar mais (${Math.max(0, filtered.length - state.limit)} restantes)`;
  $('#projection-note').hidden = true;
  if (state.result) showMessage(filtered.length ? '' : 'Nenhum candidato encontrado com esses filtros.');
}
function renderTitle() {
  $('#results-title').textContent = `${state.catalog?.rounds?.[state.round]?.offices?.[state.office]?.label || OFFICES.find((office) => office.cd === state.office)?.label || 'Cargo'} · ${UFS.find(([uf]) => uf === state.uf)?.[1] || state.uf}`;
  document.title = `${$('#results-title').textContent} — Corrida da Apuração`;
}
function availableOffice(code) {
  const cargo = state.catalog?.rounds?.[state.round]?.offices?.[code];
  return Boolean(cargo?.scopes?.[state.uf] || (state.uf === 'br' && cargo?.overviewKey) || (!state.catalog?.rounds?.[state.round]?.offices && code === '1'));
}
function renderTabs() {
  const offices = new Map(OFFICES.map((office) => [office.cd, office.label]));
  for (const round of Object.values(state.catalog?.rounds || {})) for (const [code, office] of Object.entries(round.offices || {})) offices.set(code, office.label);
  $('#office-tabs').replaceChildren(...[...offices].map(([cd, label]) => {
    const button = element('button', 'office-tab', label);
    button.disabled = !availableOffice(cd);
    button.title = button.disabled ? 'Sem resultados disponíveis para esta seleção.' : '';
    button.setAttribute('aria-pressed', String(cd === state.office));
    button.addEventListener('click', () => { state.office = cd; state.municipality = null; select(); });
    return button;
  }));
}
function renderMunicipalityFilter() {
  let field = $('#municipality-field');
  if (!field) {
    field = element('label', 'field'); field.id = 'municipality-field';
    field.append(element('span', 'field-label', 'MUNICÍPIO'));
    const input = element('select'); input.id = 'municipality-select'; field.append(input);
    $('.filters').append(field);
    input.addEventListener('change', () => { state.municipality = input.value; select(); });
  }
  const configured = state.catalog?.rounds?.[state.round]?.offices?.[state.office]?.scopes?.[state.uf];
  const selections = Array.isArray(configured) ? configured : configured ? [configured] : [];
  const towns = selections.flatMap((entry) => entry.municipalities || []);
  field.hidden = !towns.length;
  if (!towns.length) { state.municipality = null; return; }
  if (!towns.some((town) => town.ibge === state.municipality)) state.municipality = towns[0].ibge;
  $('#municipality-select').replaceChildren(...towns.map((town) => {
    const option = element('option', '', town.name || town.ibge); option.value = town.ibge; option.selected = town.ibge === state.municipality; return option;
  }));
}
function renderParliament() {
  const panel = $('#parliament');
  panel.hidden = !['5', '6', '7', '8', '13'].includes(state.office) || !state.result;
  $('#results-layout').classList.toggle('has-parliament', !panel.hidden && state.uf !== 'br');
  $('#results-layout').classList.toggle('is-national', !panel.hidden && state.uf === 'br');
  if (panel.hidden) return;
  panel.replaceChildren(element('h2', '', 'Vagas em disputa'), element('p', '', `${count(state.result.seats)} vagas · eleitos informados pelo TSE`));
  for (const party of [...(state.result.partySeats || [])].sort((a, b) => b.seats - a.seats)) {
    const row = element('p', '', `${party.party} · ${party.seats}`); row.style.borderLeft = `4px solid ${party.color}`; row.style.paddingLeft = '8px'; panel.append(row);
  }
  if (!state.result.partySeats?.length) panel.append(element('p', '', 'Aguardando a atribuição oficial das vagas.'));
}

function select() {
  state.request++;
  state.result = null;
  state.candidates = [];
  state.limit = PAGE_SIZE;
  window.history.replaceState(null, '', `?${new URLSearchParams({ uf: state.uf, cargo: state.office, turno: state.round, ...(state.municipality ? { municipio: state.municipality } : {}) })}`);
  renderTitle(); renderTabs(); renderSummary(); renderCandidates(); renderParliament(); load();
}
async function load() {
  window.clearTimeout(state.timer);
  if (document.hidden) return;
  const request = ++state.request;
  setStatus('loading', 'ATUALIZANDO RESULTADOS');
  try {
    state.catalog = await ResultsApi.catalog();
    if (request !== state.request) return;
    renderTitle(); renderTabs(); renderMunicipalityFilter();
    const payload = await ResultsApi.scope(state.round, state.uf, undefined, state.office, state.municipality);
    if (request !== state.request) return;
    if (!payload.result.result) throw new Error('Votação ainda indisponível.');
    state.result = payload.result.result;
    state.candidates = state.result.candidates.map((candidate, index) => ({ ...candidate, rank: index + 1,
      running: candidate.running || [], status: candidate.status || '', fullName: candidate.fullName || '' }));
    renderSummary(); renderCandidates(); renderParliament();
    setStatus(payload.stale || payload.result.error ? 'error' : 'official', payload.stale || payload.result.error ? 'MOSTRANDO A ÚLTIMA LEITURA' : `${state.result.aggregate ? 'PAINEL AGREGADO POR UF' : 'DADOS OFICIAIS DO TSE'} · ${state.result.generation || ''}`);
    if (state.result.aggregate && payload.coverage?.available < payload.coverage?.configured) {
      setStatus('loading', `PAINEL PARCIAL · ${payload.coverage.available}/${payload.coverage.configured} UFs`);
      showMessage('O painel reúne os resultados disponíveis de cada UF, consultados em momentos diferentes.');
    }
  } catch (error) {
    if (request !== state.request) return;
    setStatus('error', state.result ? 'MOSTRANDO A ÚLTIMA LEITURA' : 'AGUARDANDO PUBLICAÇÃO');
    showMessage(state.result ? 'A atualização está demorando. Mantendo os últimos dados.' : 'Os resultados desta seleção ainda não estão disponíveis.');
  } finally {
    if (request === state.request) state.timer = window.setTimeout(load, 15000);
  }
}
function start() {
  const params = new URLSearchParams(location.search);
  if (UFS.some(([uf]) => uf === params.get('uf'))) state.uf = params.get('uf');
  if (/^[1-9]\d{0,3}$/.test(params.get('cargo') || '')) state.office = params.get('cargo');
  if (/^\d{7}$/.test(params.get('municipio') || '')) state.municipality = params.get('municipio');
  if (['1', '2'].includes(params.get('turno'))) state.round = params.get('turno');
  $('#uf-select').replaceChildren(...UFS.map(([uf, name]) => { const option = element('option', '', name); option.value = uf; option.selected = uf === state.uf; return option; }));
  $('#round-field').hidden = false;
  $('#round-select').replaceChildren(...['1', '2'].map((round) => { const option = element('option', '', `${round}º turno`); option.value = round; option.selected = round === state.round; return option; }));
  $('#uf-select').addEventListener('change', (event) => { state.uf = event.target.value; select(); });
  $('#round-select').addEventListener('change', (event) => { state.round = event.target.value; select(); });
  $('#search-input').addEventListener('input', (event) => { state.query = event.target.value; renderCandidates(); });
  $('#elected-only').addEventListener('change', (event) => { state.electedOnly = event.target.checked; renderCandidates(); });
  $('#more-button').addEventListener('click', () => { state.limit += PAGE_SIZE; renderCandidates(); });
  $('#refresh-button').addEventListener('click', load);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { window.clearTimeout(state.timer); state.request++; } else load(); });
  select();
}
start();
