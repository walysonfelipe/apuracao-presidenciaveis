(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const pct = (value) => `${value.toFixed(2).replace('.', ',')}%`;
  let frame;
  let currentItems = [];
  let selectedId = null;
  let uf = null;
  const loader = new ResultsMapLoader({ onChange: () => {
    if (!frame) frame = requestAnimationFrame(render);
  } });

  function description(id) {
    const entry = loader.record(id);
    const result = entry?.result;
    if (!result) {
      if (entry?.error === 'unmapped') return 'Ainda não temos resultados para esta cidade.';
      if (entry?.error === 'missing') return 'Os resultados ainda não foram divulgados.';
      if (entry?.error) return 'Não foi possível carregar os resultados. Vamos tentar novamente.';
      return 'Carregando resultados…';
    }
    const stale = loader.notice || entry.error || Date.now() - entry.checkedAt > (entry.staleAfterMs || 240000);
    const source = stale ? 'Mostrando os últimos resultados disponíveis' : 'Fonte: TSE';
    if (!result.total) return `Aguardando os primeiros resultados do ${loader.context.round}º turno.`;
    const candidates = result.candidates.slice(0, 2).map((item) => `${item.name} (${item.party}) ${pct(item.pct)}`).join(' · ');
    const counted = result.counted === null ? 'Ainda não sabemos quanto da apuração foi concluído.' : `${pct(result.counted)} das seções de votação apuradas`;
    return `${candidates}\n${result.tied ? 'Empate' : `Na frente: ${result.leader.name}`}\n${counted}\n${source}${result.generation ? ` · Atualizado em ${result.generation}` : ''}`;
  }

  function render() {
    frame = null;
    const snapshot = loader.snapshot();
    const paths = new Map([...$('territories').children].map((path) => [path.dataset.id, path]));
    const rows = new Map([...$('territory-list').children].map((row) => [row.dataset.id, row]));
    for (const item of currentItems) {
      const entry = loader.record(item.id);
      const fill = entry?.result?.fill || '#34465b';
      const path = paths.get(item.id);
      if (!path) continue;
      if (path.style.getPropertyValue('--territory-fill') !== fill) path.style.setProperty('--territory-fill', fill);
      path.classList.toggle('is-stale', Boolean(entry?.result && (loader.notice || entry.error || Date.now() - entry.checkedAt > (entry.staleAfterMs || 240000))));
      path.querySelector('title').textContent = `${item.name}\n${description(item.id)}`;
      path.setAttribute('aria-label', `${uf ? 'Selecionar' : 'Explorar'} ${item.name}. ${description(item.id).replaceAll('\n', '. ')}`);
      const dot = rows.get(item.id)?.querySelector('.region-dot');
      if (dot) dot.style.setProperty('--dot-color', fill);
    }
    const legend = $('election-candidates');
    const signature = JSON.stringify(snapshot.candidates);
    if (legend.dataset.signature !== signature) {
      legend.dataset.signature = signature;
      legend.replaceChildren(...snapshot.candidates.map((candidate) => {
        const label = document.createElement('span');
        const portrait = document.createElement('span');
        portrait.className = 'candidate-portrait';
        portrait.setAttribute('aria-hidden', 'true');
        portrait.style.setProperty('--candidate-color', candidate.color);
        portrait.textContent = candidate.name.trim().charAt(0);
        if (candidate.photo) {
          const image = document.createElement('img');
          image.alt = '';
          image.width = 32;
          image.height = 32;
          image.loading = 'lazy';
          image.decoding = 'async';
          image.addEventListener('error', () => image.remove(), { once: true });
          image.src = candidate.photo;
          portrait.append(image);
        }
        const dot = document.createElement('i');
        dot.style.background = candidate.color;
        dot.setAttribute('aria-hidden', 'true');
        label.append(portrait, dot, document.createTextNode(`${candidate.name} · ${candidate.party}`));
        return label;
      }));
    }
    const progress = `${snapshot.checked}/${snapshot.total} ${snapshot.municipal ? 'cidades' : 'estados'}`;
    $('election-status').textContent = snapshot.paused ? 'As atualizações voltam quando você retornar.' : snapshot.notice || `${snapshot.stale ? 'Aguardando novos resultados' : snapshot.withVotes ? 'Resultados' : 'Aguardando os primeiros resultados'} · ${progress}`;
    $('election-status').title = `${progress}.${snapshot.failed ? ' Alguns resultados ainda não estão disponíveis.' : ''}${snapshot.stale ? ' Mostrando os últimos resultados disponíveis.' : ''} O mapa é atualizado automaticamente.`;
    if (selectedId) $('map-selection-result').textContent = description(selectedId);
    document.dispatchEvent(new CustomEvent('map-results-change'));
  }

  function setScope(stateUf, items, id = null) {
    uf = stateUf;
    currentItems = items;
    selectedId = id;
    loader.setScope({ uf: uf?.abbr || null, items, selectedId, round: $('election-round').value });
    updateResultsLink();
  }

  function select(id) {
    selectedId = id;
    loader.select(id);
    if (id) $('map-selection-result').textContent = description(id);
    updateResultsLink();
  }

  function updateResultsLink() {
    const params = new URLSearchParams({ uf: uf?.abbr.toLowerCase() || 'br', cargo: '1', turno: $('election-round').value });
    $('map-results-link').href = `estados.html?${params}`;
  }

  $('election-round').addEventListener('change', () => {
    setScope(uf, currentItems, selectedId);
    updateResultsLink();
    document.dispatchEvent(new CustomEvent('map-round-change'));
  });
  document.addEventListener('visibilitychange', () => loader.setPaused(document.hidden));
  loader.setPaused(document.hidden);
  window.MapResults = Object.freeze({ setScope, select, description, color: (id) => loader.record(id)?.result?.fill || '#34465b', round: () => $('election-round').value });
})();
