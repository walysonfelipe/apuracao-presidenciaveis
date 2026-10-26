'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const EMPTY_FILL = '#34465b';
const WAIT_COLORS = ['#e5484d', '#4a5ee8'];
const SKELETON_ROWS = [{ id: 'a', color: WAIT_COLORS[0] }, { id: 'b', color: WAIT_COLORS[1] }];
const STALE_MS = 240000;
const geometry = new Map();
const normalize = (value) => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pct = (value) => `${value.toFixed(2).replace('.', ',')}%`;
const count = (value) => value.toLocaleString('pt-BR');
const share = (value, percent) => (value == null ? '—' : `${count(value)}${percent == null ? '' : ` · ${pct(percent)}`}`);

function validate(data) {
  if (!Array.isArray(data) || !data.length || !data.every((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string' && /^M[\d.,LZM\-]+$/.test(item.path) && Array.isArray(item.center) && item.center.length === 2 && item.center.every(Number.isFinite) && Array.isArray(item.bounds) && item.bounds.length === 4 && item.bounds.every(Number.isFinite))) {
    throw new Error('Arquivo geográfico inválido.');
  }
  return data;
}

async function fetchMap(filename) {
  const signal = AbortSignal.timeout(15000);
  const url = `/data/mapa/${filename}.json`;
  if ('DecompressionStream' in window) {
    try {
      const response = await fetch(`${url}.gz`, { signal });
      if (!response.ok) throw new Error('Malha compactada indisponível.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Some hosts decompress .gz responses automatically via Content-Encoding.
      const data = bytes[0] === 0x1f && bytes[1] === 0x8b
        ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json()
        : JSON.parse(new TextDecoder().decode(bytes));
      return validate(data);
    } catch (error) {
      if (signal.aborted) throw error;
      // Keep working on older browsers and hosts without the .gz assets.
    }
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Arquivo geográfico indisponível.');
  return validate(await response.json());
}

// Share both in-flight requests and loaded data with hover prefetches.
function loadMap(filename) {
  if (!geometry.has(filename)) geometry.set(filename, fetchMap(filename).catch((error) => { geometry.delete(filename); throw error; }));
  return geometry.get(filename);
}

const resultCache = new Map();
// Public domain of the R2 bucket (…/presidente/publico); without it the map reads only our API.
const PUBLIC_RESULTS = process.env.NEXT_PUBLIC_RESULTS_URL?.replace(/\/$/, '');

// Rebuild full candidate rows from the shared roster sent once per response.
function hydrate(data) {
  const full = (entry) => (entry?.result ? { ...entry, result: { ...entry.result,
    candidates: entry.result.candidates.map((candidate) => ({ ...data.candidates[candidate.id], ...candidate })) } } : entry);
  return { ...data, summary: full(data.summary), items: Object.fromEntries(Object.entries(data.items).map(([id, entry]) => [id, full(entry)])) };
}

// One request per scope at a time, shared by polling and hover prefetch. Unchanged data comes back as a 304
// from the browser cache (ETag) and is not parsed again.
// The bucket copy is used only while the server keeps publishing it; otherwise null sends us to the API.
const stale = (at) => !(Date.now() - (at || 0) < 180000);

async function fetchResults(url, round, uf, key, cached, published) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const etag = response.headers.get('ETag');
  if (response.ok && etag && etag === cached.etag) return published && stale(cached.publishedAt) ? null : cached.value;
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  if (data.schemaVersion !== 2 || data.round !== round || data.uf !== uf) throw new Error('Resposta incompatível.');
  if (published && stale(data.publishedAt)) return null;
  Object.assign(cached, { etag, publishedAt: data.publishedAt, value: { ...hydrate(data), key } });
  return cached.value;
}

function loadResults(round, uf) {
  const key = `${round}:${uf}`;
  const cached = resultCache.get(key) || {};
  resultCache.set(key, cached);
  cached.pending ||= (async () => {
    try {
      if (PUBLIC_RESULTS) {
        const value = await fetchResults(`${PUBLIC_RESULTS}/${round}/${uf}.json`, round, uf, key, cached, true).catch(() => null);
        if (value) return value;
      }
      return await fetchResults(`/api/resultados/${round}/${uf}`, round, uf, key, cached, false);
    } finally {
      cached.at = Date.now();
      cached.pending = null;
    }
  })();
  return cached.pending;
}

function describe(entry, round) {
  const result = entry?.result;
  if (!result) {
    if (entry?.error === 'missing') return 'Os resultados ainda não foram divulgados.';
    if (entry?.error) return 'Não foi possível carregar os resultados. Vamos tentar novamente.';
    return 'Carregando resultados…';
  }
  if (!result.total) return `Aguardando os primeiros resultados do ${round}º turno.`;
  const stale = entry.error || Date.now() - entry.checkedAt > STALE_MS;
  const leader = result.candidates.find((item) => item.id === result.leader);
  const candidates = result.candidates.slice(0, 2).map((item) => `${item.name} (${item.party}) ${pct(item.pct)}`).join(' · ');
  const counted = result.counted === null ? 'Ainda não sabemos quanto da apuração foi concluído.' : `${pct(result.counted)} das seções de votação apuradas`;
  return `${candidates}\n${result.tied ? 'Empate' : `Na frente: ${leader?.name || result.candidates[0].name}`}\n${counted}\n${stale ? 'Mostrando os últimos resultados disponíveis' : 'Fonte: TSE'}${result.generation ? ` · Atualizado em ${result.generation}` : ''}`;
}

// "05/10/2026 12:52:20" → "05/10 às 12:52"
const shortTime = (value) => value.replace(/^(\d\d\/\d\d)\/\d{4} (\d\d:\d\d):\d\d$/, '$1 às $2');

function TerritoryTip({ name, place, entry, round }) {
  const result = entry?.result;
  const stale = Boolean(result && (entry.error || Date.now() - entry.checkedAt > STALE_MS));
  const footer = result?.total ? [result.tied && 'Empate', stale ? 'Últimos dados disponíveis' : 'Fonte: TSE',
    result.generation && `atualizado ${shortTime(result.generation)}`].filter(Boolean).join(' · ') : '';
  return (
    <>
      <div className="tip-head">
        <div><strong>{name}</strong><small>{place}</small></div>
        {result?.total > 0 && result.counted != null && <span className="tip-counted">{pct(result.counted)} apurado</span>}
      </div>
      {result?.total ? result.candidates.slice(0, 2).map((candidate) => {
        const leads = !result.tied && candidate.id === result.leader;
        return (
          <div key={candidate.id} className={`tip-candidate${leads ? ' is-leader' : ''}`} style={{ '--candidate-color': candidate.color }}>
            <span className="candidate-portrait">
              {candidate.name.trim().charAt(0)}
              <img src={`/api/fotos/${round}/${candidate.id}`} alt="" width={36} height={36} decoding="async"
                onError={(event) => { event.currentTarget.hidden = true; }} />
            </span>
            <span className="tip-name">
              <strong>{candidate.name}{leads && <em className="tip-badge">Lidera</em>}</strong>
              <small>{candidate.number ? `${candidate.party} · ${candidate.number}` : candidate.party}</small>
            </span>
            <span className="tip-score"><strong>{pct(candidate.pct)}</strong><small>{count(candidate.votes)} votos</small></span>
            <span className="tip-bar"><i style={{ width: `${candidate.pct}%` }} /></span>
          </div>
        );
      }) : <p className="tip-note">{describe(entry, round)}</p>}
      {footer && <div className={`tip-foot${stale ? ' is-stale' : ''}`}>{footer}</div>}
    </>
  );
}

// Remembers per browser which declared winner was already shown, so reloads do not reopen the modal.
const SEEN_KEY = 'eleito-visto';
const seenWinner = () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } };
const markWinner = (id) => { try { localStorage.setItem(SEEN_KEY, id); } catch {} };

function WinnerModal({ dialogRef, candidate, round, onClose }) {
  const close = () => dialogRef.current?.close();
  return (
    <dialog ref={dialogRef} className="winner-modal" aria-labelledby="winner-name" style={{ '--candidate-color': candidate?.color }}
      onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      {candidate && <div className="winner-card">
        <button type="button" className="winner-close" aria-label="Fechar" onClick={close}>×</button>
        <span className="winner-photo">
          <span className="candidate-portrait winner-portrait">
            {candidate.name.trim().charAt(0)}
            <img src={`/api/fotos/${round}/${candidate.id}`} alt={`Foto de ${candidate.name}`} width={128} height={128} decoding="async"
              onError={(event) => { event.currentTarget.hidden = true; }} />
          </span>
          <span className="winner-check" aria-hidden="true">✓</span>
        </span>
        <span className="winner-kicker">Presidente eleito</span>
        <h2 id="winner-name">{candidate.name}</h2>
        <span className="winner-party"><i />{candidate.number ? `${candidate.party} · ${candidate.number}` : candidate.party}</span>
        {candidate.pct != null && <dl className="winner-stats">
          <div><dt>Votos válidos</dt><dd>{pct(candidate.pct)}</dd></div>
          <div><dt>Votos</dt><dd>{count(candidate.votes)}</dd></div>
        </dl>}
        {candidate.official ? <div className="winner-status">
          <span className="winner-chip is-official">Declarado pelo TSE</span>
          <p>Resultado oficial do {round}º turno.</p>
        </div> : <div className="winner-status">
          <span className="winner-chip">Definido matematicamente</span>
          <p>A vantagem já supera todos os votos que faltam apurar.</p>
          <p className="winner-pending"><i aria-hidden="true" />Aguardando a declaração oficial do TSE</p>
        </div>}
        <button type="button" className="winner-ok" onClick={close} autoFocus>Ver o mapa</button>
      </div>}
    </dialog>
  );
}

function readHash() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return { uf: params.get('uf'), municipality: params.get('municipio'), round: params.get('turno') === '1' ? '1' : '2' };
}

export default function ElectionMap() {
  const svgRef = useRef(null);
  const stageRef = useRef(null);
  const tooltipRef = useRef(null);
  const pickerRef = useRef(null);
  const searchRef = useRef(null);
  const winnerRef = useRef(null);
  const view = useRef({ current: null, fitted: null, drag: null, suppressClick: false, pointers: new Map(), request: 0, prefetch: null });
  const scopes = useRef(new Map());
  const [states, setStates] = useState([]);
  const [uf, setUf] = useState(null);
  const [municipalities, setMunicipalities] = useState([]);
  const [selected, setSelected] = useState(null);
  const [round, setRound] = useState('2');
  const [message, setMessage] = useState({ text: 'Carregando o Brasil…', error: false, retry: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [notice, setNotice] = useState('');
  const [hidden, setHidden] = useState(false);
  const [hovered, setHovered] = useState(null);
  // National winner per round, kept from the last Brasil payload so state views can show it too.
  const [national, setNational] = useState({});
  const pointer = useRef(null);

  const items = uf ? municipalities : states;
  const scopeKey = `${round}:${uf?.abbr.toLowerCase() || 'br'}`;
  const record = useCallback((item) => (results?.key === scopeKey ? results.items[uf ? item.id : item.abbr.toLowerCase()] : null), [results, scopeKey, uf]);
  const fillOf = (item) => record(item)?.result?.fill || EMPTY_FILL;

  const setViewBox = useCallback((bounds) => {
    view.current.current = [...bounds];
    svgRef.current?.setAttribute('viewBox', bounds.join(' '));
  }, []);

  const zoom = useCallback((factor, anchor) => {
    const { current, fitted } = view.current;
    if (!current || !fitted) return;
    const [x, y, width, height] = current;
    const ratio = Math.max(.0025, Math.min(1.8, width * factor / fitted[2]));
    const newWidth = fitted[2] * ratio;
    const newHeight = fitted[3] * ratio;
    const center = anchor || { x: x + width / 2, y: y + height / 2 };
    setViewBox([center.x - (center.x - x) * newWidth / width, center.y - (center.y - y) * newHeight / height, newWidth, newHeight]);
  }, [setViewBox]);

  const focusMunicipality = useCallback((item) => {
    const { fitted } = view.current;
    if (!item || !fitted) return;
    const [x, y, width, height] = item.bounds;
    const aspect = fitted[2] / fitted[3];
    const newWidth = Math.max(width, height * aspect, fitted[2] * .0025) * 2.2;
    const newHeight = newWidth / aspect;
    setViewBox([x + width / 2 - newWidth / 2, y + height / 2 - newHeight / 2, newWidth, newHeight]);
  }, [setViewBox]);

  // Fit the drawn territories before paint so the map never flashes at the wrong zoom.
  useLayoutEffect(() => {
    if (!items.length) return;
    const left = Math.min(...items.map((item) => item.bounds[0]));
    const top = Math.min(...items.map((item) => item.bounds[1]));
    const right = Math.max(...items.map((item) => item.bounds[0] + item.bounds[2]));
    const bottom = Math.max(...items.map((item) => item.bounds[1] + item.bounds[3]));
    const padding = Math.max(right - left, bottom - top) * .035;
    view.current.fitted = [left - padding, top - padding, right - left + padding * 2, bottom - top + padding * 2];
    setViewBox(view.current.fitted);
  }, [items, setViewBox]);

  const openState = useCallback(async (item, municipalityId) => {
    const request = ++view.current.request;
    const retry = () => openState(item, municipalityId);
    setMessage({ text: `Carregando ${item.name}…`, error: false, retry });
    try {
      const list = await loadMap(item.id);
      if (request !== view.current.request) return;
      setPickerOpen(false);
      setQuery('');
      setMunicipalities(list);
      setUf(item);
      setSelected(list.find((town) => town.id === municipalityId) || null);
      setMessage({ text: '', error: false, retry: null });
    } catch {
      if (request !== view.current.request) return;
      setMessage({ text: 'Não foi possível carregar o mapa deste estado. Tente novamente ou volte ao Brasil.', error: true, retry });
    }
  }, []);

  const init = useCallback(async () => {
    const request = ++view.current.request;
    setMessage({ text: 'Carregando o Brasil…', error: false, retry: null });
    try {
      const list = [...await loadMap('brasil')].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      if (request !== view.current.request) return;
      setStates(list);
      setMessage({ text: '', error: false, retry: null });
      const hash = readHash();
      const initial = list.find((item) => item.abbr.toLowerCase() === (hash.uf || '').toLowerCase());
      if (initial) await openState(initial, hash.municipality);
    } catch {
      if (request !== view.current.request) return;
      setMessage({ text: 'Não foi possível carregar o mapa. Verifique a conexão e tente novamente.', error: true, retry: () => init() });
    }
  }, [openState]);

  const home = useCallback(() => {
    ++view.current.request;
    setPickerOpen(false);
    setQuery('');
    if (!states.length) { init(); return; }
    setUf(null);
    setMunicipalities([]);
    setSelected(null);
    setMessage({ text: '', error: false, retry: null });
  }, [init, states.length]);

  const select = useCallback((item) => {
    if (uf) { setSelected(item); setPickerOpen(false); } else openState(item);
  }, [openState, uf]);

  const prefetch = useCallback((item) => {
    clearTimeout(view.current.prefetch);
    const connection = navigator.connection;
    if (uf || !item || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '')) return;
    view.current.prefetch = setTimeout(() => {
      loadMap(item.id).catch(() => {});
      // Warm the state's results too, unless they are already fresh in memory.
      const cached = resultCache.get(`${round}:${item.abbr.toLowerCase()}`);
      if (!cached?.pending && Date.now() - (cached?.at || 0) > 10000) loadResults(round, item.abbr.toLowerCase()).catch(() => {});
    }, 120);
  }, [round, uf]);

  useEffect(() => {
    setRound(readHash().round);
    init();
  }, [init]);

  useEffect(() => {
    if (!states.length) return;
    const params = new URLSearchParams();
    if (uf) params.set('uf', uf.abbr);
    if (selected) params.set('municipio', selected.id);
    if (round !== '2') params.set('turno', round);
    history.replaceState(null, '', `${location.pathname}${location.search}${params.size ? `#${params}` : ''}`);
  }, [round, selected, states.length, uf]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Poll the shared server cache for the open scope only; faster while the server is still filling it.
  // Starts with the geometry, not after it, so colors and numbers arrive together with the map.
  useEffect(() => {
    const key = scopeKey;
    const [scopeRound, scopeUf] = key.split(':');
    setResults(resultCache.get(key)?.value || null);
    setNotice('');
    if (hidden) return;
    let active = true;
    let timer;
    const tick = async () => {
      let delay = 10000;
      try {
        const value = await loadResults(scopeRound, scopeUf);
        if (!active) return;
        setResults(value);
        setNotice('');
        if (value.filling) delay = 3000;
      } catch (error) {
        if (!active) return;
        setNotice(error.status === 404 ? 'Este turno ainda não está disponível.' : 'Não foi possível atualizar. Mostrando os últimos dados disponíveis.');
        delay = 30000;
      }
      timer = setTimeout(tick, delay + Math.random() * 1000);
    };
    tick();
    return () => { active = false; clearTimeout(timer); };
  }, [hidden, scopeKey]);

  useEffect(() => {
    const onPointerDown = (event) => { if (!pickerRef.current?.contains(event.target)) setPickerOpen(false); };
    const onKeyDown = (event) => {
      if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        event.preventDefault();
        setPickerOpen(true);
      }
      // The open modal handles Escape itself.
      if (event.key === 'Escape' && !winnerRef.current?.open) {
        if (pickerRef.current?.open) setPickerOpen(false);
        else if (selected) setSelected(null);
        else if (uf) home();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [home, selected, uf]);

  // Mouse wheel and trackpad pinch (wheel + ctrlKey) zoom around the cursor.
  // Registered natively because React's wheel listener is passive and cannot stop page scroll/zoom.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      const factor = Math.exp(Math.max(-100, Math.min(100, delta)) * (event.ctrlKey ? .01 : .002));
      zoom(factor, new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse()));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoom]);

  useEffect(() => { if (pickerOpen) searchRef.current?.focus(); }, [pickerOpen]);

  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const eventItem = (event) => itemsById.get(event.target.closest?.('.territory')?.dataset.id);

  // The card content renders only when the hovered territory changes; moving inside it just repositions.
  const placeTooltip = useCallback(() => {
    const tooltip = tooltipRef.current;
    const at = pointer.current;
    if (!tooltip || !at) return;
    const rect = stageRef.current.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(at.x - rect.left + 16, rect.width - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(at.y - rect.top - tooltip.offsetHeight - 12, rect.height - tooltip.offsetHeight - 8))}px`;
  }, []);
  function showTooltip(event, item) {
    if (view.current.drag?.moved) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    setHovered(item);
    placeTooltip();
  }
  const hideTooltip = () => setHovered(null);
  useLayoutEffect(placeTooltip, [hovered, results, placeTooltip]);

  // Use SVG coordinates so dragging and two-finger zoom work at every size.
  const svgPoint = (x, y) => new DOMPoint(x, y).matrixTransform(svgRef.current.getScreenCTM().inverse());
  function startGesture() {
    const state = view.current;
    const points = [...state.pointers.values()];
    if (!points.length) { state.drag = null; return; }
    if (points.length > 1) {
      const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      state.drag = { pinch: true, distance: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)), anchor: svgPoint(center.x, center.y), view: [...state.current], moved: true };
      state.suppressClick = true;
    } else {
      state.drag = { x: points[0].x, y: points[0].y, view: [...state.current], moved: false, matrix: svgRef.current.getScreenCTM().inverse() };
    }
  }
  function onPointerDown(event) {
    const state = view.current;
    if (!state.current || event.button !== 0) return;
    if (!state.pointers.size) state.suppressClick = false;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    startGesture();
  }
  function onPointerMove(event) {
    const state = view.current;
    const item = eventItem(event);
    if (item) showTooltip(event, item); else hideTooltip();
    const drag = state.drag;
    if (!drag || !state.pointers.has(event.pointerId)) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const svg = svgRef.current;
    if (drag.pinch && state.pointers.size > 1) {
      const points = [...state.pointers.values()];
      const distance = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
      setViewBox(drag.view);
      zoom(drag.distance / distance, drag.anchor);
      hideTooltip();
      svg.setPointerCapture(event.pointerId);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    state.suppressClick = true;
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('dragging');
    hideTooltip();
    const [x, y, width, height] = drag.view;
    setViewBox([x - dx * drag.matrix.a - dy * drag.matrix.c, y - dx * drag.matrix.b - dy * drag.matrix.d, width, height]);
  }
  function stopDrag(event) {
    const state = view.current;
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.delete(event.pointerId);
    const svg = svgRef.current;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    svg.classList.remove('dragging');
    startGesture();
    // Keep the synthetic click after a drag or pinch from choosing a city.
    if (!state.pointers.size) setTimeout(() => { state.suppressClick = false; }, 0);
  }

  // While no votes exist, territories pulse in candidate colors as a wave from west to east.
  const westEast = useMemo(() => {
    const xs = items.map((item) => item.center[0]);
    return [Math.min(...xs), Math.max(...xs) - Math.min(...xs) || 1];
  }, [items]);

  const paths = useMemo(() => items.map((item) => {
    const entry = record(item);
    const wave = -2.4 * (item.center[0] - westEast[0]) / westEast[1];
    const stale = Boolean(entry?.result && (entry.error || Date.now() - entry.checkedAt > STALE_MS));
    const text = describe(entry, round);
    return (
      <path key={item.id} d={item.path} fillRule="evenodd" data-id={item.id} tabIndex={0} role="button"
        className={`territory${uf ? ' municipality' : ''}${stale ? ' is-stale' : ''}${selected?.id === item.id ? ' is-selected' : ''}${Number(item.id) % 2 ? ' wait-alt' : ''}`}
        style={{ '--territory-fill': entry?.result?.fill || EMPTY_FILL, '--wait-delay': `${wave.toFixed(2)}s` }}
        aria-pressed={selected?.id === item.id}
        aria-label={`${uf ? 'Selecionar' : 'Explorar'} ${item.name}. ${text.replaceAll('\n', '. ')}`} />

    );
  }), [items, record, round, selected, uf, westEast]);

  const filtered = pickerOpen ? items.filter((item) => normalize(`${item.name} ${item.abbr || ''} ${item.id}`).includes(normalize(query.trim()))) : [];
  const entries = items.map(record);
  const checked = entries.filter(Boolean).length;
  const withVotes = entries.filter((entry) => entry?.result?.total > 0).length;
  const progress = `${checked}/${items.length} ${uf ? 'cidades' : 'estados'}`;
  // The panel follows what is open: Brasil, the state, or the selected city.
  const panelEntry = selected ? record(selected) : results?.key === scopeKey ? results.summary : null;
  const panel = panelEntry?.result;
  const legend = panel?.candidates || entries.find((entry) => entry?.result)?.result.candidates || [];
  const learnNational = useCallback((value) => {
    const [valueRound, valueUf] = value?.key?.split(':') || [];
    if (valueUf !== 'br') return;
    const { elected: official, decided } = value.summary?.result || {};
    const id = official || decided;
    const row = value.summary.result.candidates.find((candidate) => candidate.id === id);
    if (id && value.candidates?.[id]) setNational((known) => ({ ...known,
      [valueRound]: { id, official: Boolean(official), ...value.candidates[id], votes: row?.votes, pct: row?.pct } }));
  }, []);
  useEffect(() => { learnNational(results); }, [results, learnNational]);
  // Opened straight into a state: read Brasil once (shared cache) to learn whether the runoff is decided.
  const knowsNational = Boolean(national[round]);
  useEffect(() => {
    if (round === '2' && !knowsNational && scopeKey !== '2:br') loadResults('2', 'br').then(learnNational).catch(() => {});
  }, [round, knowsNational, scopeKey, learnNational]);
  // The TSE declaration (repeated in every file of the round) wins; otherwise the national mathematical decision.
  const officialId = results?.key === scopeKey ? panel?.elected || results.summary?.result?.elected : null;
  // Vote numbers only come from the national summary, never from the open state or city.
  const nationalStats = national[round]?.id === officialId ? national[round] : {};
  const elected = officialId && results.candidates?.[officialId]
    ? { ...nationalStats, id: officialId, official: true, ...results.candidates[officialId] } : national[round] || null;
  const electedId = elected?.id || null;
  const openWinner = useCallback(() => { if (!winnerRef.current?.open) winnerRef.current?.showModal(); }, []);
  useEffect(() => {
    if (electedId && elected && seenWinner() !== `${round}:${electedId}`) openWinner();
  }, [electedId, Boolean(elected), round, openWinner]);
  // Until any territory has votes, map and panel show an animated skeleton instead of zeros.
  const waiting = !withVotes;
  const [waitColor, waitAlt] = legend.length > 1 ? legend.map((candidate) => candidate.color) : WAIT_COLORS;
  const place = selected ? `${selected.name} · ${uf.abbr}` : uf ? uf.name : 'Brasil';
  const status = hidden ? 'As atualizações voltam quando você retornar.' : notice
    || (results?.pausedUntil ? 'O TSE pediu uma pausa nas consultas. Mostrando os últimos dados disponíveis.' : '')
    || `${withVotes ? 'Resultados' : 'Aguardando os primeiros resultados'} · ${progress}${results?.filling ? ' · carregando' : ''}`;
  const district = uf?.abbr === 'DF';
  const hint = selected ? '' : uf ? (district ? 'Explore o território do Distrito Federal' : 'Clique em um município para selecionar') : 'Clique em um estado para explorar';

  return (
    <section ref={stageRef} className={`map-stage${uf ? ' is-state-view' : ''}${selected ? ' has-selection' : ''}${waiting ? ' is-waiting' : ''}`}
      style={{ '--wait-1': waitColor, '--wait-2': waitAlt }} aria-label="Explorador geográfico do Brasil">
      <svg ref={svgRef} id="brazil-map" aria-busy={Boolean(message.text && !message.error)}
        aria-label={uf ? `Mapa de ${uf.name}, com territórios clicáveis` : 'Mapa interativo dos 26 estados e do Distrito Federal'}
        onClick={(event) => { const item = eventItem(event); if (item && !view.current.suppressClick) select(item); }}
        onKeyDown={(event) => { const item = eventItem(event); if (item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item); } }}
        onPointerOver={(event) => { if (event.pointerType === 'mouse') prefetch(eventItem(event)); }}
        onFocus={(event) => prefetch(eventItem(event))}
        onPointerOut={() => { clearTimeout(view.current.prefetch); hideTooltip(); }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopDrag} onPointerCancel={stopDrag}
        onPointerLeave={(event) => { if (!view.current.drag?.moved) stopDrag(event); }}
        // Touch pointers start implicitly captured by the touched path; that capture moving to the svg is not a lift.
        onLostPointerCapture={(event) => { if (event.target === svgRef.current && view.current.pointers.has(event.pointerId)) stopDrag(event); }}
        onDoubleClick={(event) => { event.preventDefault(); zoom(.5, svgPoint(event.clientX, event.clientY)); }}>
        <g>{paths}</g>
        <g aria-hidden="true">
          {!uf && states.map((item) => <text key={item.id} x={item.center[0]} y={item.center[1]} className="state-label">{item.abbr}</text>)}
        </g>
      </svg>

      <nav className="breadcrumbs" aria-label="Localização no mapa">
        <button type="button" className={uf ? 'is-back' : undefined} title="Voltar ao mapa do Brasil" onClick={home}>{uf ? '← Brasil' : 'Brasil'}</button>
        {uf && <span>{uf.name}</span>}
      </nav>

      <aside className="election-legend" aria-label="Legenda dos resultados eleitorais">
        <div className="election-heading">
          <strong>Presidente</strong>
          <select aria-label="Turno da eleição" value={round} onChange={(event) => setRound(event.target.value)}>
            <option value="2">2º turno</option>
            <option value="1">1º turno</option>
          </select>
        </div>
        <div className="election-place">{place}</div>
        {elected && !legend.some((candidate) => candidate.id === electedId) && <button type="button" className="election-winner" style={{ '--candidate-color': elected.color }} onClick={openWinner}
          aria-label={`${elected.name} eleito, ${elected.official ? 'declarado pelo TSE' : 'definido matematicamente'}. Ver detalhes`}>
          <span className="winner-photo is-small" aria-hidden="true">
            <span className="candidate-portrait">
              {elected.name.trim().charAt(0)}
              <img src={`/api/fotos/${round}/${elected.id}`} alt="" width={36} height={36} decoding="async"
                onError={(event) => { event.currentTarget.hidden = true; }} />
            </span>
            <span className="winner-check">✓</span>
          </span>
          <span className="election-winner-text">
            <small><b>Eleito</b>{elected.official ? 'Declarado pelo TSE' : 'Definido matematicamente'}</small>
            <strong>{elected.name} <em>{elected.party}</em></strong>
          </span>
          <span className="election-winner-arrow" aria-hidden="true">›</span>
        </button>}
        <div className="election-candidates">
          {(legend.length || !waiting ? legend : SKELETON_ROWS).map((candidate) => (
            <div className={`candidate-row${candidate.id === electedId ? ' is-elected' : ''}`} key={candidate.id} style={{ '--candidate-color': candidate.color }}>
              <span className="winner-photo is-small" aria-hidden="true">
                <span className={`candidate-portrait${candidate.name ? '' : ' skeleton'}`}>
                  {candidate.name?.trim().charAt(0)}
                  {candidate.name && <img src={`/api/fotos/${round}/${candidate.id}`} alt="" width={40} height={40} loading="lazy" decoding="async"
                    onError={(event) => event.currentTarget.remove()} />}
                </span>
                {candidate.id === electedId && <span className="winner-check">✓</span>}
              </span>
              <span className="candidate-name">
                {candidate.name ? <>
                  <strong>{candidate.name}{candidate.id === electedId && <button type="button" className="elected-badge" onClick={openWinner}
                    aria-label={`${candidate.name} eleito, ${elected.official ? 'declarado pelo TSE' : 'definido matematicamente'}. Ver detalhes`}>Eleito <span aria-hidden="true">›</span></button>}</strong>
                  <small>{candidate.party}</small>
                </> : <><i className="skeleton" /><i className="skeleton is-short" /></>}
              </span>
              <span className="candidate-score">
                {waiting ? <><i className="skeleton" /><i className="skeleton is-short" /></> : <>
                  <strong style={{ color: candidate.color }}>{panel ? pct(candidate.pct) : '—'}</strong>
                  <small>{panel ? `${count(candidate.votes)} votos` : ''}</small>
                </>}
              </span>
              <span className="candidate-bar" aria-hidden="true">
                <i className={waiting ? 'is-waiting' : undefined} style={waiting ? undefined : { width: `${panel ? candidate.pct : 0}%`, background: candidate.color }} />
              </span>
              {candidate.id === electedId && <span className="elected-status">{elected.official ? 'Declarado pelo TSE' : 'Definido matematicamente · aguardando o TSE'}</span>}
            </div>
          ))}
        </div>
        <dl className="election-totals">
          <div><dt>Seções apuradas</dt><dd>{waiting ? <i className="skeleton" /> : panel?.counted != null ? pct(panel.counted) : '—'}</dd></div>
          <div><dt>Brancos</dt><dd>{waiting ? <i className="skeleton" /> : share(panel?.votes?.blank, panel?.votes?.blankPct)}</dd></div>
          <div><dt>Nulos</dt><dd>{waiting ? <i className="skeleton" /> : share(panel?.votes?.null, panel?.votes?.nullPct)}</dd></div>
          <div><dt>Abstenção</dt><dd>{waiting ? <i className="skeleton" /> : share(panel?.abstention?.count, panel?.abstention?.pct)}</dd></div>
        </dl>
        {panel?.generation && <small className="election-updated">TSE · atualizado em {panel.generation}</small>}
        <p role="status" title={`${progress}. O mapa é atualizado automaticamente.`}>{status}</p>
        <small>Cor mais forte indica maior vantagem na votação.</small>
      </aside>

      <details ref={pickerRef} className="place-picker" open={pickerOpen} onToggle={(event) => setPickerOpen(event.currentTarget.open)}>
        <summary onClick={(event) => { event.preventDefault(); setPickerOpen(!pickerOpen); }}>
          <span aria-hidden="true">⌕</span><span>{uf ? 'Buscar município' : 'Buscar estado'}</span><span className="picker-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="picker-content">
          <label className="search-box">
            <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off"
              placeholder={uf ? 'Buscar cidade' : 'Buscar estado ou sigla'} aria-label={uf ? 'Buscar cidade' : 'Buscar estado ou sigla'} />
          </label>
          <div className="territory-list" aria-label={uf ? `Territórios de ${uf.name}` : 'Estados do Brasil'}>
            {filtered.map((item) => (
              <button key={item.id} type="button" className="territory-row" aria-pressed={selected?.id === item.id}
                onClick={() => { select(item); if (uf) focusMunicipality(item); }}
                onPointerEnter={() => { svgRef.current.querySelector(`[data-id="${item.id}"]`)?.classList.add('is-highlighted'); prefetch(item); }}
                onPointerLeave={() => { clearTimeout(view.current.prefetch); svgRef.current.querySelector(`[data-id="${item.id}"]`)?.classList.remove('is-highlighted'); }}>
                <span className="region-dot" style={{ '--dot-color': fillOf(item) }} />
                <span className="row-name">{item.name}</span>
                <small>{item.abbr || item.id}</small>
                <span className="row-arrow">↗</span>
              </button>
            ))}
          </div>
          {pickerOpen && !filtered.length && <p className="empty-search">Nenhum lugar encontrado.</p>}
        </div>
      </details>

      {message.text && (
        <div className="map-message" role="status">
          <span>{message.text}</span>
          {message.error && <button type="button" onClick={() => message.retry?.()}>Tentar novamente</button>}
        </div>
      )}
      {hovered && (
        <div ref={tooltipRef} className="map-tooltip" aria-hidden="true">
          <TerritoryTip name={hovered.name} place={uf ? uf.name : `Estado · ${hovered.abbr}`} entry={record(hovered)} round={round} />
        </div>
      )}
      <div className="zoom-controls" aria-label="Controles do mapa">
        <button type="button" aria-label="Aproximar mapa" title="Aproximar" onClick={() => zoom(.75)}>+</button>
        <button type="button" aria-label="Afastar mapa" title="Afastar" onClick={() => zoom(1.33)}>−</button>
        <button type="button" aria-label="Ajustar mapa à tela" title="Ajustar à tela" onClick={() => { if (view.current.fitted) setViewBox(view.current.fitted); }}>⛶</button>
      </div>
      {hint && <div className="map-hint">{hint}</div>}
      {selected && uf && (
        <div className="map-selection" role="status" aria-live="polite">
          <div><span>{uf.name}</span><strong>{selected.name}</strong></div>
          <button type="button" aria-label="Aproximar município selecionado" title="Aproximar município" onClick={() => focusMunicipality(selected)}>⛶</button>
          <button type="button" aria-label="Limpar município selecionado" onClick={() => setSelected(null)}>×</button>
        </div>
      )}
      <WinnerModal dialogRef={winnerRef} candidate={elected} round={round} onClose={() => { if (electedId) markWinner(`${round}:${electedId}`); }} />
      <a className="map-credit" href="https://servicodados.ibge.gov.br/api/docs/malhas?versao=3" target="_blank" rel="noopener" title="Mapa: IBGE. Resultados: TSE. A cor mostra quem está na frente na votação.">Mapa: IBGE · Resultados: TSE</a>
    </section>
  );
}
