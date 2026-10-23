const state = {
  records: [],
  expansions: [],
  loading: false,
  requestId: 0,
  readOnly: false,
};

const elements = {
  grid: document.querySelector('#records-grid'),
  empty: document.querySelector('#empty-state'),
  statRecords: document.querySelector('#stat-records'),
  statModels: document.querySelector('#stat-models'),
  statSkins: document.querySelector('#stat-skins'),
  statTextures: document.querySelector('#stat-textures'),
  statBytes: document.querySelector('#stat-bytes'),
  search: document.querySelector('#search-input'),
  filterExpansion: document.querySelector('#filter-expansion'),
  filterKind: document.querySelector('#filter-kind'),
  scrapeForm: document.querySelector('#scrape-form'),
  scrapeExpansion: document.querySelector('#scrape-expansion'),
  scrapeKind: document.querySelector('#scrape-kind'),
  scrapeId: document.querySelector('#scrape-id'),
  scrapeButton: document.querySelector('#scrape-button'),
  scrapeHint: document.querySelector('#scrape-hint'),
  dialog: document.querySelector('#detail-dialog'),
  detail: document.querySelector('#detail-content'),
  dialogClose: document.querySelector('#dialog-close'),
  refresh: document.querySelector('#refresh-button'),
  serverStatus: document.querySelector('#server-status'),
  toastStack: document.querySelector('#toast-stack'),
};

const FALLBACK_EXPANSIONS = [
  ['classic', 'Classic'],
  ['tbc', 'The Burning Crusade'],
  ['wotlk', 'Wrath of the Lich King'],
  ['cata', 'Cataclysm'],
  ['mists', 'Mists of Pandaria'],
  ['wod', 'Warlords of Draenor'],
  ['legion', 'Legion'],
  ['bfa', 'Battle for Azeroth'],
  ['shadowlands', 'Shadowlands'],
  ['dragonflight', 'Dragonflight'],
  ['tww', 'The War Within'],
  ['midnight', 'Midnight'],
];

const KIND_LABELS = {
  npc: 'NPC',
  object: 'Objeto',
  item: 'Item',
};

const STATUS_LABELS = {
  complete: 'completo',
  partial: 'parcial',
  failed: 'falha',
};

const icons = {
  model: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.8 20 7v10l-8 4.2L4 17V7l8-4.2Z" stroke="currentColor" stroke-width="1.4"/><path d="m4 7 8 4.2L20 7M12 11.2v10" stroke="currentColor" stroke-width="1.4"/></svg>',
  texture: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="1.4"/><circle cx="8.5" cy="9.5" r="1.5" stroke="currentColor" stroke-width="1.4"/><path d="m4 17 5-4.5 3.2 2.7 3-2.4 4.8 4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13m0 0-4-4m4 4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z" stroke="currentColor" stroke-width="1.3"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function assetUrl(path) {
  const value = String(path ?? '');
  if (/^https?:\/\//i.test(value)) return value;
  return `/data/${value.split('/').map(encodeURIComponent).join('/')}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function expansionLabel(id) {
  const found = state.expansions.find((entry) => entry.id === id);
  return found?.label ?? id;
}

function setServerStatus(online) {
  elements.serverStatus.classList.toggle('is-online', online);
  elements.serverStatus.innerHTML = `<i></i> ${online ? 'servidor ativo' : 'servidor offline'}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function showToast(message, type = 'info', timeout = 4200) {
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'info' ? '' : type}`.trim();
  toast.textContent = message;
  elements.toastStack.append(toast);
  setTimeout(() => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 250);
  }, timeout);
}

function populateExpansions() {
  const options = state.expansions
    .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
    .join('');

  elements.scrapeExpansion.innerHTML = options;
  elements.filterExpansion.innerHTML = `<option value="">Todas as expansões</option>${options}`;

  const preferred = state.expansions.some((entry) => entry.id === 'mists') ? 'mists' : state.expansions[0]?.id;
  if (preferred) elements.scrapeExpansion.value = preferred;
}

async function loadExpansions() {
  try {
    const payload = await fetchJson('/api/expansions');
    state.expansions = payload.expansions?.length
      ? payload.expansions
      : FALLBACK_EXPANSIONS.map(([id, label]) => ({ id, label }));
  } catch {
    state.expansions = FALLBACK_EXPANSIONS.map(([id, label]) => ({ id, label }));
  }
  populateExpansions();
}

function textureThumbnail(record) {
  const textures = record.assets?.textures ?? [];
  return textures.find((entry) => entry.status !== 'failed') ?? null;
}

function recordQuery() {
  const params = new URLSearchParams();
  params.set('limit', '1000');
  if (elements.filterExpansion.value) params.set('expansion', elements.filterExpansion.value);
  if (elements.filterKind.value) params.set('kind', elements.filterKind.value);
  const query = elements.search.value.trim();
  if (query) params.set('q', query);
  return params.toString();
}

async function loadHealth() {
  try {
    const payload = await fetchJson('/api/health');
    state.readOnly = Boolean(payload.readOnly);
    if (state.readOnly) applyReadOnly();
  } catch {
    state.readOnly = false;
  }
}

function applyReadOnly() {
  elements.scrapeButton.querySelector('span').textContent = 'Prévia';
  if (elements.scrapeHint) {
    elements.scrapeHint.innerHTML =
      'Neste deploy a coleta é uma prévia remota, sem gravar arquivos. Para baixar tudo, rode a CLI localmente: <code>npm run scrape -- npc 137698</code>';
  }
}

async function loadRecords({ showSkeleton = true } = {}) {
  const requestId = ++state.requestId;
  state.loading = true;
  elements.refresh.classList.add('is-spinning');

  if (showSkeleton && state.records.length === 0) {
    elements.grid.innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
    elements.empty.hidden = true;
  }

  try {
    const payload = await fetchJson(`/api/records?${recordQuery()}`);
    if (requestId !== state.requestId) return;
    state.records = payload.records ?? [];
    renderRecords();
    setServerStatus(true);
  } catch (error) {
    if (requestId !== state.requestId) return;
    setServerStatus(false);
    showToast(`Não foi possível carregar os registros: ${error.message}`, 'error');
    if (state.records.length === 0) {
      elements.grid.innerHTML = '';
      elements.empty.hidden = false;
    }
  } finally {
    if (requestId === state.requestId) {
      state.loading = false;
      elements.refresh.classList.remove('is-spinning');
    }
  }
}

function renderRecords() {
  const records = state.records;
  elements.grid.innerHTML = records.map((record, index) => renderCard(record, index)).join('');
  elements.empty.hidden = records.length > 0;

  for (const image of elements.grid.querySelectorAll('img[data-thumb]')) {
    image.addEventListener(
      'error',
      () => {
        const parent = image.closest('.record-thumb');
        image.remove();
        if (parent && !parent.querySelector('.thumb-placeholder')) {
          parent.insertAdjacentHTML(
            'afterbegin',
            `<div class="thumb-placeholder">${icons.layers}<span>${escapeHtml(image.dataset.fallback ?? 'M2')}</span></div>`,
          );
        }
      },
      { once: true },
    );
  }

  for (const card of elements.grid.querySelectorAll('.record-card')) {
    const record = records.find(
      (entry) =>
        entry.expansion === card.dataset.expansion &&
        entry.kind === card.dataset.kind &&
        String(entry.id) === card.dataset.id,
    );
    if (!record) continue;

    const open = () => openRecord(record);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }

  updateStats();
}

function renderCard(record, index) {
  const thumb = textureThumbnail(record);
  const modelId = record.meta?.modelIds?.[0] ?? record.meta?.modelId;
  const status = record.status ?? 'failed';
  const delay = Math.min(index * 32, 240);
  const title = record.kind === 'npc' ? 'NPC' : KIND_LABELS[record.kind] ?? record.kind;
  const models = record.stats?.models ?? 0;
  const skins = record.stats?.skins ?? 0;
  const textures = record.stats?.textures ?? 0;
  const metaText = record.meta?.hasCharacter ? 'personagem' : modelId ? `model ${modelId}` : 'sem M2';

  const thumbMarkup = thumb
    ? `<img data-thumb src="${assetUrl(thumb.path)}" alt="" loading="lazy" data-fallback="${escapeHtml(modelId ?? 'M2')}" />`
    : `<div class="thumb-placeholder">${icons.layers}<span>${escapeHtml(modelId ?? 'sem modelo')}</span></div>`;

  return `
    <article
      class="record-card"
      tabindex="0"
      role="button"
      aria-label="${escapeHtml(`${title} ${record.id}`)}"
      data-expansion="${escapeHtml(record.expansion)}"
      data-kind="${escapeHtml(record.kind)}"
      data-id="${escapeHtml(record.id)}"
      style="animation-delay:${delay}ms"
    >
      <div class="record-thumb">
        ${thumbMarkup}
        <span class="record-expansion">${escapeHtml(record.expansion)}</span>
        <span class="record-status ${escapeHtml(status)}" title="${escapeHtml(STATUS_LABELS[status] ?? status)}"></span>
      </div>
      <div class="record-body">
        <div class="record-heading">
          <h3>${escapeHtml(title)} <span>#${escapeHtml(record.id)}</span></h3>
          <span class="record-id">${escapeHtml(expansionLabel(record.expansion))}</span>
        </div>
        <div class="record-meta">
          <span>${icons.model} ${models} modelo${models === 1 ? '' : 's'} · ${skins} skin${skins === 1 ? '' : 's'}</span>
          <span>${icons.texture} ${textures} textura${textures === 1 ? '' : 's'}</span>
          <span>${escapeHtml(formatBytes(record.stats?.bytes))}</span>
        </div>
        <div class="record-footer">
          <span class="model-chip">${escapeHtml(metaText)}</span>
          <span class="record-open">Abrir ${icons.arrow}</span>
        </div>
      </div>
    </article>
  `;
}

function updateStats() {
  const records = state.records;
  const models = records.reduce((total, record) => total + (record.stats?.models ?? 0), 0);
  const skins = records.reduce((total, record) => total + (record.stats?.skins ?? 0), 0);
  const textures = records.reduce((total, record) => total + (record.stats?.textures ?? 0), 0);
  const bytes = records.reduce((total, record) => total + (record.stats?.bytes ?? 0), 0);
  elements.statRecords.textContent = String(records.length);
  elements.statModels.textContent = String(models);
  elements.statSkins.textContent = String(skins);
  elements.statTextures.textContent = String(textures);
  elements.statBytes.textContent = formatBytes(bytes);
}

function assetRow(asset, type) {
  const isTexture = type === 'texture';
  const extension = { model: '.m2', skin: '.skin', phys: '.phys', texture: '.webp' }[type] ?? `.${type}`;
  const status = asset.status === 'failed' ? 'falhou' : asset.status === 'cached' ? 'cache' : asset.status;
  const size = asset.bytes ? formatBytes(asset.bytes) : '—';
  return `
    <div class="asset-row">
      <span class="asset-icon ${isTexture ? 'texture' : ''}">${isTexture ? icons.texture : icons.model}</span>
      <span class="asset-info">
        <strong>${escapeHtml(asset.id)}${asset.slot ? ` · slot ${escapeHtml(asset.slot)}` : ''}</strong>
        <small>${escapeHtml(extension)} · ${escapeHtml(size)} · ${escapeHtml(status)}</small>
      </span>
      <span class="asset-actions">
        ${asset.status !== 'failed' && asset.path
          ? `<a class="asset-link" href="${assetUrl(asset.path)}" download title="Baixar">${icons.download}</a>`
          : ''}
        <a class="asset-link" href="${escapeHtml(asset.url)}" target="_blank" rel="noreferrer" title="Abrir origem">${icons.external}</a>
      </span>
    </div>
  `;
}

function openRecord(record) {
  const thumb = textureThumbnail(record);
  const models = record.assets?.models ?? [];
  const skins = record.assets?.skins ?? [];
  const phys = record.assets?.phys ?? [];
  const textures = record.assets?.textures ?? [];
  const status = record.status ?? 'failed';
  const label = KIND_LABELS[record.kind] ?? record.kind;
  const errors = record.errors ?? [];
  const pageUrl = record.source?.pageUrl;
  const metaUrl = record.source?.metaUrl;

  const errorsMarkup = errors.length
    ? `<div class="warning-box ${status === 'failed' ? 'error' : ''}">
        <strong>${errors.length} observação${errors.length === 1 ? '' : 'ões'}</strong>
        <ul>${errors.slice(0, 8).map((error) => `<li>${escapeHtml(error.message ?? error)}</li>`).join('')}</ul>
      </div>`
    : '';

  const textureTiles = textures.length
    ? textures
        .filter((asset) => asset.status !== 'failed' && asset.path)
        .map(
          (asset) => `
            <a class="texture-tile" href="${assetUrl(asset.path)}" target="_blank" rel="noreferrer" title="Textura ${escapeHtml(asset.id)}">
              <img src="${assetUrl(asset.path)}" alt="Textura ${escapeHtml(asset.id)}" loading="lazy" />
              <span>${escapeHtml(asset.slot ? `slot ${asset.slot}` : asset.id)}</span>
            </a>
          `,
        )
        .join('')
    : '<p class="form-hint">Nenhuma textura disponível.</p>';

  const modelRows = models.length
    ? models.map((asset) => assetRow(asset, 'model')).join('')
    : '<p class="form-hint">Nenhum arquivo M2 neste registro.</p>';

  const textureRows = textures.length
    ? textures.map((asset) => assetRow(asset, 'texture')).join('')
    : '<p class="form-hint">Nenhuma textura referenciada.</p>';

  const companionRows = [
    ...skins.map((asset) => assetRow(asset, 'skin')),
    ...phys.map((asset) => assetRow(asset, 'phys')),
  ].join('');
  const companionMarkup = companionRows || '<p class="form-hint">Nenhuma skin ou física referenciada pelo M2.</p>';

  elements.detail.innerHTML = `
    <header class="detail-hero">
      ${thumb ? `<img src="${assetUrl(thumb.path)}" alt="" />` : ''}
      <div class="detail-hero-content">
        <div class="detail-title-row">
          <h2>${escapeHtml(label)} #${escapeHtml(record.id)}</h2>
          <span class="status-pill ${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] ?? status)}</span>
        </div>
        <div class="record-meta">
          <span>${escapeHtml(expansionLabel(record.expansion))}</span>
          <span>${icons.model} ${record.stats?.models ?? 0} modelo(s) · ${record.stats?.skins ?? 0} skin(s)</span>
          <span>${icons.texture} ${record.stats?.textures ?? 0} textura(s)</span>
          <span>${escapeHtml(formatBytes(record.stats?.bytes))}</span>
          <span>${escapeHtml(formatDate(record.scrapedAt))}</span>
        </div>
      </div>
    </header>

    <div class="detail-body">
      <div>
        <section class="detail-section">
          <h3>Arquivos M2</h3>
          <div class="asset-list">${modelRows}</div>
        </section>
        <section class="detail-section">
          <h3>Skins e física</h3>
          <div class="asset-list">${companionMarkup}</div>
        </section>
        <section class="detail-section">
          <h3>Texturas</h3>
          <div class="texture-grid">${textureTiles}</div>
          <div class="asset-list" style="margin-top: .7rem">${textureRows}</div>
        </section>
        ${errorsMarkup}
      </div>

      <aside class="detail-side">
        <section class="detail-section">
          <h3>Manifesto</h3>
          <dl class="meta-table">
            <div><dt>Expansão</dt><dd>${escapeHtml(record.expansion)}</dd></div>
            <div><dt>Tipo</dt><dd>${escapeHtml(record.kind)}</dd></div>
            <div><dt>ID</dt><dd>${escapeHtml(record.id)}</dd></div>
            <div><dt>Modelo</dt><dd>${escapeHtml(record.meta?.modelIds?.join(', ') || '—')}</dd></div>
            <div><dt>Escala</dt><dd>${escapeHtml(record.meta?.scale ?? '—')}</dd></div>
            <div><dt>Coletado em</dt><dd>${escapeHtml(formatDate(record.scrapedAt))}</dd></div>
            <div><dt>Duração</dt><dd>${escapeHtml(Math.round((record.durationMs ?? 0) / 100) / 10)}s</dd></div>
          </dl>
          <div class="detail-actions">
            ${metaUrl ? `<a href="${escapeHtml(metaUrl)}" target="_blank" rel="noreferrer">${icons.external} meta.json</a>` : ''}
            ${pageUrl ? `<a href="${escapeHtml(pageUrl)}" target="_blank" rel="noreferrer">${icons.external} Wowhead</a>` : ''}
          </div>
        </section>
        <section class="detail-section">
          <h3>${record.preview ? 'Prévia remota' : 'Cache local'}</h3>
          <p class="form-hint" style="margin: 0">
            ${record.preview
              ? 'Este registro foi consultado ao vivo e não foi gravado. Use a CLI local para salvar M2, skin, física e texturas.'
              : `Os assets ficam em <code>data/${escapeHtml(record.expansion)}/</code>. O manifesto completo está em <code>catalog/${escapeHtml(record.kind)}/${escapeHtml(record.id)}.json</code>.`}
          </p>
        </section>
      </aside>
    </div>
  `;

  const shell = elements.dialog.querySelector('.detail-shell');
  if (shell) shell.scrollTop = 0;
  if (!elements.dialog.open) elements.dialog.showModal();
}

async function handleScrape(event) {
  event.preventDefault();
  const id = elements.scrapeId.value.trim();
  if (!/^\d+$/.test(id)) {
    showToast('Informe um ID numérico válido.', 'warn');
    elements.scrapeId.focus();
    return;
  }

  const expansion = elements.scrapeExpansion.value;
  const kind = elements.scrapeKind.value;
  elements.scrapeButton.disabled = true;
  elements.scrapeButton.querySelector('span').textContent = state.readOnly ? 'Buscando' : 'Coletando';

  try {
    const payload = await fetchJson('/api/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expansion, kind, id }),
    });
    const record = payload.record;
    const status = record?.status ?? 'failed';
    const counts = `${record.stats.models} modelo(s), ${record.stats.skins ?? 0} skin(s), ${record.stats.textures} textura(s).`;
    showToast(
      status === 'complete'
        ? `${payload.preview ? 'Prévia de ' : ''}${kind.toUpperCase()} ${id}: ${counts}`
        : `${kind.toUpperCase()} ${id} terminou como ${STATUS_LABELS[status] ?? status}. Confira os detalhes.`,
      status === 'complete' ? 'info' : 'warn',
    );

    elements.filterExpansion.value = expansion;
    elements.filterKind.value = kind;
    elements.search.value = '';

    if (payload.preview && record) {
      state.records = [
        record,
        ...state.records.filter(
          (entry) =>
            !(entry.expansion === record.expansion && entry.kind === record.kind && String(entry.id) === String(record.id)),
        ),
      ];
      renderRecords();
      openRecord(record);
    } else {
      await loadRecords({ showSkeleton: false });
      if (record) openRecord(record);
    }
    setServerStatus(true);
  } catch (error) {
    showToast(`Coleta falhou: ${error.message}`, 'error', 6000);
  } finally {
    elements.scrapeButton.disabled = false;
    elements.scrapeButton.querySelector('span').textContent = state.readOnly ? 'Prévia' : 'Coletar';
  }
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function bindEvents() {
  elements.scrapeForm.addEventListener('submit', handleScrape);
  elements.refresh.addEventListener('click', () => loadRecords());
  elements.filterExpansion.addEventListener('change', () => loadRecords());
  elements.filterKind.addEventListener('change', () => loadRecords());
  elements.search.addEventListener('input', debounce(() => loadRecords({ showSkeleton: false }), 280));

  elements.dialogClose.addEventListener('click', () => elements.dialog.close());
  elements.dialog.addEventListener('click', (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });

  for (const trigger of document.querySelectorAll('[data-fill-id]')) {
    trigger.addEventListener('click', () => {
      elements.scrapeId.value = trigger.dataset.fillId;
      elements.scrapeId.focus();
    });
  }

  for (const trigger of document.querySelectorAll('[data-focus-id]')) {
    trigger.addEventListener('click', () => {
      elements.scrapeId.focus();
      elements.scrapeExpansion.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
}

async function init() {
  bindEvents();
  await loadHealth();
  await loadExpansions();
  await loadRecords();
  elements.scrapeId.focus({ preventScroll: true });
}

init();
