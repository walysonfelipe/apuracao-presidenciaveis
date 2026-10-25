(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const svg = $('brazil-map');
  const stage = $('map-stage');
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const cache = new Map();
  const pointers = new Map();
  const state = { states: [], uf: null, municipalities: [], municipality: null, request: 0, view: null, fitted: null, drag: null, suppressClick: false };
  let retry = init;
  let itemsById = new Map();
  let prefetchTimer;
  const initialRound = new URLSearchParams(location.hash.slice(1)).get('turno');
  if (initialRound === '1' || initialRound === '2') $('election-round').value = initialRound;

  const normalize = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const make = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };

  function validate(data) {
    if (!Array.isArray(data) || !data.length || !data.every((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string' && /^M[\d.,LZM\-]+$/.test(item.path) && Array.isArray(item.center) && item.center.length === 2 && item.center.every(Number.isFinite) && Array.isArray(item.bounds) && item.bounds.length === 4 && item.bounds.every(Number.isFinite))) {
      throw new Error('Arquivo geográfico inválido.');
    }
    return data;
  }

  async function fetchMap(filename) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const url = `data/mapa/${filename}.json`;
    try {
      if ('DecompressionStream' in window) {
        try {
          const response = await fetch(`${url}.gz`, { signal: controller.signal });
          if (!response.ok) throw new Error('Malha compactada indisponível.');
          const bytes = new Uint8Array(await response.arrayBuffer());
          // Some hosts decompress .gz responses automatically via Content-Encoding.
          const data = bytes[0] === 0x1f && bytes[1] === 0x8b
            ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json()
            : JSON.parse(new TextDecoder().decode(bytes));
          return validate(data);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // Keep working on older browsers and hosts without the .gz assets.
        }
      }
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('Arquivo geográfico indisponível.');
      return validate(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  function load(filename) {
    if (!cache.has(filename)) {
      const pending = fetchMap(filename).catch((error) => {
        cache.delete(filename);
        throw error;
      });
      // Share both in-flight requests and loaded data with hover prefetches.
      cache.set(filename, pending);
    }
    return cache.get(filename);
  }

  function prefetchState(item) {
    clearTimeout(prefetchTimer);
    const connection = navigator.connection;
    if (state.uf || !item || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '')) return;
    prefetchTimer = setTimeout(() => { load(item.id).catch(() => {}); }, 120);
  }

  function message(text, isError = false) {
    $('map-message').hidden = !text;
    $('map-message').querySelector('span').textContent = text;
    $('retry-button').hidden = !isError;
    svg.setAttribute('aria-busy', text && !isError ? 'true' : 'false');
    $('map-tooltip').hidden = true;
  }

  function setView(bounds) {
    state.view = [...bounds];
    svg.setAttribute('viewBox', bounds.join(' '));
  }

  function fit(items) {
    const left = Math.min(...items.map((item) => item.bounds[0]));
    const top = Math.min(...items.map((item) => item.bounds[1]));
    const right = Math.max(...items.map((item) => item.bounds[0] + item.bounds[2]));
    const bottom = Math.max(...items.map((item) => item.bounds[1] + item.bounds[3]));
    const padding = Math.max(right - left, bottom - top) * .035;
    state.fitted = [left - padding, top - padding, right - left + padding * 2, bottom - top + padding * 2];
    setView(state.fitted);
  }

  function zoom(factor, anchor) {
    if (!state.view || !state.fitted) return;
    const [x, y, width, height] = state.view;
    const ratio = Math.max(.0025, Math.min(1.8, width * factor / state.fitted[2]));
    const newWidth = state.fitted[2] * ratio;
    const newHeight = state.fitted[3] * ratio;
    const center = anchor || { x: x + width / 2, y: y + height / 2 };
    setView([center.x - (center.x - x) * newWidth / width, center.y - (center.y - y) * newHeight / height, newWidth, newHeight]);
  }

  function focusMunicipality() {
    const item = state.municipality;
    if (!item || !state.fitted) return;
    const [x, y, width, height] = item.bounds;
    const aspect = state.fitted[2] / state.fitted[3];
    const newWidth = Math.max(width, height * aspect, state.fitted[2] * .0025) * 2.2;
    const newHeight = newWidth / aspect;
    setView([x + width / 2 - newWidth / 2, y + height / 2 - newHeight / 2, newWidth, newHeight]);
  }

  function showTooltip(event, item) {
    if (state.drag?.moved) return;
    const tooltip = $('map-tooltip');
    const rect = stage.getBoundingClientRect();
    tooltip.textContent = `${state.uf ? item.name : `${item.name} · ${item.abbr}`}\n${MapResults.description(item.id)}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(event.clientX - rect.left + 16, rect.width - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(event.clientY - rect.top - tooltip.offsetHeight - 12, rect.height - tooltip.offsetHeight - 8))}px`;
  }

  function draw() {
    const items = state.uf ? state.municipalities : state.states;
    itemsById = new Map(items.map((item) => [item.id, item]));
    const territories = document.createDocumentFragment();
    const labels = document.createDocumentFragment();
    for (const item of items) {
      const path = document.createElementNS(svgNamespace, 'path');
      path.setAttribute('d', item.path);
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('class', state.uf ? 'territory municipality' : 'territory');
      path.style.setProperty('--territory-fill', '#34465b');
      path.dataset.id = item.id;
      path.setAttribute('tabindex', '0');
      path.setAttribute('role', 'button');
      path.setAttribute('aria-label', state.uf ? `Selecionar ${item.name}` : `Explorar ${item.name}, ${item.abbr}`);
      path.setAttribute('aria-pressed', 'false');
      const title = document.createElementNS(svgNamespace, 'title');
      title.textContent = item.name;
      path.append(title);
      territories.append(path);
      if (!state.uf) {
        const label = document.createElementNS(svgNamespace, 'text');
        label.setAttribute('x', item.center[0]);
        label.setAttribute('y', item.center[1]);
        label.setAttribute('class', 'state-label');
        label.textContent = item.abbr;
        labels.append(label);
      }
    }
    $('territories').replaceChildren(territories);
    $('map-labels').replaceChildren(labels);
    svg.setAttribute('aria-label', state.uf ? `Mapa de ${state.uf.name}, com territórios clicáveis` : 'Mapa interativo dos 26 estados e do Distrito Federal');
    fit(items);
    MapResults.setScope(state.uf, items);
  }

  function select(item) {
    if (state.uf) selectMunicipality(item);
    else openState(item);
  }

  function selectMunicipality(item) {
    state.municipality = item;
    closePicker();
    for (const path of $('territories').children) {
      const selected = path.dataset.id === item.id;
      path.classList.toggle('is-selected', selected);
      path.setAttribute('aria-pressed', String(selected));
    }
    for (const row of $('territory-list').children) row.setAttribute('aria-pressed', String(row.dataset.id === item.id));
    $('map-hint').textContent = `${item.name} · ${state.uf.abbr}`;
    $('map-selection').hidden = false;
    $('map-selection-name').textContent = item.name;
    $('map-selection-state').textContent = state.uf.name;
    stage.classList.add('has-selection');
    MapResults.select(item.id);
    saveLocation();
  }

  function clearMunicipality() {
    state.municipality = null;
    $('map-selection').hidden = true;
    stage.classList.remove('has-selection');
    $('map-hint').textContent = state.uf?.abbr === 'DF' ? 'Explore o território do Distrito Federal' : 'Clique em um município para selecionar';
    for (const path of $('territories').children) {
      path.classList.remove('is-selected');
      path.setAttribute('aria-pressed', 'false');
    }
    for (const row of $('territory-list').children) row.setAttribute('aria-pressed', 'false');
    MapResults.select(null);
    saveLocation();
  }

  function renderList() {
    const query = normalize($('territory-search').value.trim());
    const items = state.uf ? state.municipalities : state.states;
    const filtered = items.filter((item) => normalize(`${item.name} ${item.abbr || ''} ${item.id}`).includes(query));
    const fragment = document.createDocumentFragment();
    for (const item of filtered) {
      const row = make('button', 'territory-row');
      row.type = 'button';
      row.dataset.id = item.id;
      row.setAttribute('aria-pressed', String(state.municipality?.id === item.id));
      const dot = make('span', 'region-dot');
      dot.style.setProperty('--dot-color', MapResults.color(item.id));
      const name = make('span', 'row-name', item.name);
      row.append(dot, name, make('small', '', item.abbr || item.id), make('span', 'row-arrow', '↗'));
      row.addEventListener('click', () => {
        select(item);
        if (state.uf) focusMunicipality();
      });
      row.addEventListener('pointerenter', () => {
        $('territories').querySelector(`[data-id="${item.id}"]`)?.classList.add('is-highlighted');
        prefetchState(item);
      });
      row.addEventListener('pointerleave', () => {
        clearTimeout(prefetchTimer);
        $('territories').querySelector(`[data-id="${item.id}"]`)?.classList.remove('is-highlighted');
      });
      fragment.append(row);
    }
    $('territory-list').replaceChildren(fragment);
    $('territory-list').scrollTop = 0;
    $('empty-search').hidden = filtered.length > 0;
  }

  function updatePanel() {
    const uf = state.uf;
    const district = uf?.abbr === 'DF';
    $('state-crumb').hidden = !uf;
    $('state-crumb').textContent = uf?.name || '';
    $('search-label').textContent = uf ? 'Buscar município' : 'Buscar estado';
    const placeholder = uf ? 'Buscar cidade' : 'Buscar estado ou sigla';
    $('territory-search').placeholder = placeholder;
    $('territory-search').setAttribute('aria-label', placeholder);
    $('territory-search').value = '';
    $('territory-list').setAttribute('aria-label', uf ? `Territórios de ${uf.name}` : 'Estados do Brasil');
    $('map-hint').textContent = uf ? (district ? 'Explore o território do Distrito Federal' : 'Clique em um município para selecionar') : 'Clique em um estado para explorar';
    $('map-selection').hidden = true;
    stage.classList.remove('has-selection');
    stage.classList.toggle('is-state-view', Boolean(uf));
    // The closed search must not delay the first paint with hundreds of rows.
    $('territory-list').replaceChildren();
    if ($('place-picker').open) renderList();
  }

  async function openState(uf, municipalityId) {
    const request = ++state.request;
    retry = () => openState(uf, municipalityId);
    message(`Carregando ${uf.name}…`);
    try {
      const municipalities = await load(uf.id);
      if (request !== state.request) return;
      closePicker();
      state.uf = uf;
      state.municipalities = municipalities;
      state.municipality = null;
      draw();
      updatePanel();
      saveLocation();
      if (municipalityId) {
        const municipality = municipalities.find((item) => item.id === municipalityId);
        if (municipality) selectMunicipality(municipality);
      }
      message('');
    } catch (error) {
      if (request !== state.request) return;
      message('Não foi possível carregar o mapa deste estado. Tente novamente ou volte ao Brasil.', true);
    }
  }

  function home() {
    ++state.request;
    closePicker();
    if (!state.states.length) { init(); return; }
    state.uf = null;
    state.municipalities = [];
    state.municipality = null;
    draw();
    updatePanel();
    message('');
    saveLocation();
  }

  async function init() {
    const request = ++state.request;
    retry = init;
    message('Carregando o Brasil…');
    try {
      const states = await load('brasil');
      if (request !== state.request) return;
      state.states = [...states].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      state.uf = null;
      draw();
      updatePanel();
      message('');
      const params = new URLSearchParams(location.hash.slice(1));
      const uf = state.states.find((item) => item.abbr.toLowerCase() === (params.get('uf') || '').toLowerCase());
      if (uf) await openState(uf, params.get('municipio'));
    } catch (error) {
      if (request !== state.request) return;
      message('Não foi possível carregar o mapa. Abra o projeto por um servidor local e tente novamente.', true);
    }
  }

  function saveLocation() {
    const params = new URLSearchParams();
    if (state.uf) params.set('uf', state.uf.abbr);
    if (state.municipality) params.set('municipio', state.municipality.id);
    if (MapResults.round() !== '2') params.set('turno', MapResults.round());
    history.replaceState(null, '', `${location.pathname}${location.search}${params.size ? `#${params}` : ''}`);
  }

  document.addEventListener('map-round-change', saveLocation);

  function closePicker() {
    const picker = $('place-picker');
    if (picker.contains(document.activeElement)) picker.querySelector('summary').focus();
    picker.open = false;
  }

  $('place-picker').addEventListener('toggle', () => {
    if ($('place-picker').open) {
      renderList();
      $('territory-search').focus();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('place-picker').contains(event.target)) closePicker();
  });

  // One set of handlers serves every path, including states with 800+ cities.
  const eventItem = (event) => itemsById.get(event.target.closest('.territory')?.dataset.id);
  svg.addEventListener('click', (event) => {
    const item = eventItem(event);
    if (item && !state.suppressClick) select(item);
  });
  svg.addEventListener('keydown', (event) => {
    const item = eventItem(event);
    if (item && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      select(item);
    }
  });
  svg.addEventListener('pointermove', (event) => {
    const item = eventItem(event);
    if (item) showTooltip(event, item);
    else $('map-tooltip').hidden = true;
  });
  svg.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'mouse') prefetchState(eventItem(event));
  });
  svg.addEventListener('focusin', (event) => prefetchState(eventItem(event)));
  svg.addEventListener('pointerout', () => {
    clearTimeout(prefetchTimer);
    $('map-tooltip').hidden = true;
  });

  $('territory-search').addEventListener('input', renderList);
  $('home-button').addEventListener('click', home);
  $('retry-button').addEventListener('click', () => retry());
  $('zoom-in').addEventListener('click', () => zoom(.75));
  $('zoom-out').addEventListener('click', () => zoom(1.33));
  $('reset-view').addEventListener('click', () => { if (state.fitted) setView(state.fitted); });
  $('dismiss-selection').addEventListener('click', clearMunicipality);
  $('focus-municipality').addEventListener('click', focusMunicipality);
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      event.preventDefault();
      $('place-picker').open = true;
      $('territory-search').focus();
    }
    if (event.key === 'Escape') {
      if ($('place-picker').open) {
        closePicker();
      } else if (state.municipality) {
        clearMunicipality();
      } else if (state.uf) {
        home();
      }
    }
  });

  // Use SVG coordinates so dragging and two-finger zoom work at every size.
  function svgPoint(x, y) {
    return new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
  }
  function startGesture() {
    const points = [...pointers.values()];
    if (!points.length) { state.drag = null; return; }
    if (points.length > 1) {
      const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      state.drag = { pinch: true, distance: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)), anchor: svgPoint(center.x, center.y), view: [...state.view], matrix: svg.getScreenCTM().inverse(), moved: true };
      state.suppressClick = true;
    } else {
      state.drag = { x: points[0].x, y: points[0].y, view: [...state.view], moved: false, matrix: svg.getScreenCTM().inverse() };
    }
  }
  svg.addEventListener('pointerdown', (event) => {
    if (!state.view || event.button !== 0) return;
    if (!pointers.size) state.suppressClick = false;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    startGesture();
  });
  svg.addEventListener('pointermove', (event) => {
    const drag = state.drag;
    if (!drag || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (drag.pinch && pointers.size > 1) {
      const points = [...pointers.values()];
      const distance = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
      setView(drag.view);
      zoom(drag.distance / distance, drag.anchor);
      $('map-tooltip').hidden = true;
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
    $('map-tooltip').hidden = true;
    const [x, y, width, height] = drag.view;
    setView([x - dx * drag.matrix.a - dy * drag.matrix.c, y - dx * drag.matrix.b - dy * drag.matrix.d, width, height]);
  });
  function stopDrag(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    svg.classList.remove('dragging');
    startGesture();
    // Keep the synthetic click after a drag or pinch from choosing a city.
    if (!pointers.size) setTimeout(() => { state.suppressClick = false; }, 0);
  }
  svg.addEventListener('pointerup', stopDrag);
  svg.addEventListener('pointercancel', stopDrag);
  svg.addEventListener('pointerleave', (event) => { if (!state.drag?.moved) stopDrag(event); });
  svg.addEventListener('lostpointercapture', (event) => { if (pointers.has(event.pointerId)) stopDrag(event); });
  svg.addEventListener('dblclick', (event) => {
    event.preventDefault();
    zoom(.5, svgPoint(event.clientX, event.clientY));
  });

  init();
})();
