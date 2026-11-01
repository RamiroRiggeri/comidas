// App de comidas — interfaz.
// Por ahora: clave de la casa, lista del súper compartida y estructura de pestañas.

const KEY_STORAGE = 'comidas.clave';
const POLL_MS = 10_000;

const state = {
  key: null,
  tab: 'lista',
  items: [],
  lastSync: 0,
  syncFailed: false,
  mutSeq: 0,      // sube con cada cambio local; descarta refrescos que arrancaron antes
  pending: 0,     // cambios en vuelo
  editingId: null,
  installPrompt: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Servidor ----------
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: { 'x-clave': state.key || '', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Sin conexión. Revisá los datos o el wifi.', 0);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new ApiError(data.error || 'El servidor no respondió bien. Probá de nuevo.', res.status);
  return data;
}

function handleError(err) {
  if (err.status === 401) return lock('La clave cambió. Escribila de nuevo.');
  toast(err.message);
}

// ---------- Clave de la casa ----------
function lock(message = '') {
  try { localStorage.removeItem(KEY_STORAGE); } catch {}
  state.key = null;
  $('app').hidden = true;
  $('lock').hidden = false;
  $('lock-error').textContent = message;
  $('lock-input').value = '';
}

async function unlock(key) {
  state.key = key;
  try {
    await api('GET', '/api/ping');
  } catch (err) {
    state.key = null;
    $('lock-error').textContent =
      err.status === 401 ? 'Esa clave no coincide. Revisá mayúsculas y espacios.' : err.message;
    return;
  }
  try { localStorage.setItem(KEY_STORAGE, key); } catch {}
  $('lock').hidden = true;
  $('app').hidden = false;
  refresh();
}

$('lock-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('lock-input').value.trim();
  if (key) unlock(key);
});

// ---------- Interpretar "2 kg tomate" ----------
const UNITS =
  'kg|kilos?|g|gr|grs|gramos?|l|lt|lts|litros?|ml|cc|u|un|unid|unidades?|paq|paquetes?|latas?|botellas?|bot|docenas?|maples?|frascos?|cajas?|bolsas?|sobres?|potes?|atados?|planchas?|packs?|bandejas?';
const NUM = '\\d+(?:[.,]\\d+)?(?:\\/\\d+)?|½|¼';
const LEADING = new RegExp(`^(${NUM})\\s*(?:(${UNITS})\\.?\\s+)?(?:de\\s+)?(.+)$`, 'i');
const TRAILING = new RegExp(`^(.+?)\\s+(?:x\\s*)?(${NUM})\\s*(${UNITS})?\\.?$`, 'i');

function parseEntry(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  let name = t;
  let qty = '';
  let m = t.match(LEADING);
  if (m) {
    qty = [m[1], m[2]].filter(Boolean).join(' ');
    name = m[3];
  } else if ((m = t.match(TRAILING))) {
    name = m[1];
    qty = [m[2], m[3]].filter(Boolean).join(' ');
  }
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return { name, qty };
}

// ---------- Lista ----------
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

function rowHtml(item) {
  const cls = ['item', item.checked ? 'is-done' : '', item._pending ? 'is-pending' : ''].join(' ');
  return `<li class="${cls}" data-id="${esc(item.id)}">
    <button class="item-main" type="button" data-action="toggle" aria-pressed="${item.checked}">
      <span class="check">${CHECK_SVG}</span>
      <span class="item-text">
        <span class="item-name">${esc(item.name)}</span>
        ${item.qty ? `<span class="item-qty">${esc(item.qty)}</span>` : ''}
      </span>
    </button>
    <button class="edit-btn" type="button" data-action="edit" aria-label="Editar ${esc(item.name)}">${PENCIL_SVG}</button>
  </li>`;
}

function render() {
  const todo = state.items.filter((i) => !i.checked);
  const done = state.items.filter((i) => i.checked);
  $('todo').innerHTML = todo.map(rowHtml).join('');
  $('done').innerHTML = done.map(rowHtml).join('');
  $('empty').hidden = state.items.length > 0;
  $('done-block').hidden = done.length === 0;
  $('count').textContent = todo.length ? `${todo.length} por comprar` : 'Nada por comprar';
  renderSynced();
}

function renderSynced() {
  const el = $('synced');
  el.classList.toggle('stale', state.syncFailed);
  if (state.syncFailed) return (el.textContent = 'Sin conexión');
  if (!state.lastSync) return (el.textContent = '');
  const s = Math.round((Date.now() - state.lastSync) / 1000);
  el.textContent =
    s < 5 ? 'Actualizada recién' : s < 60 ? `Actualizada hace ${s} s` : `Actualizada hace ${Math.round(s / 60)} min`;
}

async function refresh({ manual = false } = {}) {
  if (!state.key) return;
  const seq = state.mutSeq;
  const btn = $('refresh-btn');
  if (manual) btn.classList.add('spinning');
  const started = Date.now();
  try {
    const data = await api('GET', '/api/items');
    // si hubo un cambio local mientras tanto, este resultado ya está viejo
    if (seq === state.mutSeq && state.pending === 0) {
      state.items = data.items;
      state.lastSync = Date.now();
      state.syncFailed = false;
      render();
    }
  } catch (err) {
    if (err.status === 401) return handleError(err);
    state.syncFailed = true;
    renderSynced();
    if (manual) toast(err.message);
  } finally {
    if (manual) setTimeout(() => btn.classList.remove('spinning'), Math.max(0, 400 - (Date.now() - started)));
  }
}

// Ejecuta un cambio con actualización optimista y vuelve atrás si falla.
async function mutate(apply, request, rollback) {
  state.mutSeq++;
  state.pending++;
  apply();
  render();
  try {
    await request();
  } catch (err) {
    rollback();
    handleError(err);
  } finally {
    state.pending--;
    render();
  }
}

function findItem(id) {
  return state.items.find((i) => i.id === id);
}

function toggleItem(id) {
  const item = findItem(id);
  if (!item || item._pending) return;
  const next = !item.checked;
  mutate(
    () => { item.checked = next; item._pending = true; },
    async () => {
      const { item: saved } = await api('PATCH', `/api/items/${id}`, { checked: next });
      Object.assign(item, saved);
      delete item._pending;
    },
    () => { item.checked = !next; delete item._pending; }
  );
}

const normalize = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function addItem(text) {
  const { name, qty } = parseEntry(text);
  if (!name) return;
  // Si ya está pendiente en la lista, no se duplica (a lo sumo se actualiza la cantidad).
  const existing = state.items.find((i) => !i.checked && normalize(i.name) === normalize(name));
  if (existing) {
    if (qty && qty !== existing.qty && !existing._pending) {
      saveItem(existing.id, existing.name, qty);
      toast(`${existing.name} ya estaba: cantidad actualizada a ${qty}`);
    } else {
      toast(`${existing.name} ya está en la lista`);
    }
    return;
  }
  const temp = { id: `tmp-${Date.now()}`, name, qty, checked: false, _pending: true };
  mutate(
    () => state.items.push(temp),
    async () => {
      const { item } = await api('POST', '/api/items', { name, qty });
      Object.assign(temp, item);
      delete temp._pending;
    },
    () => (state.items = state.items.filter((i) => i !== temp))
  );
}

function saveItem(id, name, qty) {
  const item = findItem(id);
  if (!item) return;
  const before = { name: item.name, qty: item.qty };
  mutate(
    () => Object.assign(item, { name, qty, _pending: true }),
    async () => {
      const { item: saved } = await api('PATCH', `/api/items/${id}`, { name, qty });
      Object.assign(item, saved);
      delete item._pending;
    },
    () => { Object.assign(item, before); delete item._pending; }
  );
}

function deleteItem(id) {
  const item = findItem(id);
  if (!item) return;
  const index = state.items.indexOf(item);
  mutate(
    () => state.items.splice(index, 1),
    async () => {
      await api('DELETE', `/api/items/${id}`);
      toast(`${item.name}: borrado`);
    },
    () => state.items.splice(index, 0, item)
  );
}

function clearChecked() {
  const done = state.items.filter((i) => i.checked);
  if (!done.length) return;
  const label = done.length === 1 ? 'el tildado' : `los ${done.length} tildados`;
  if (!confirm(`¿Borrar ${label} de la lista?`)) return;
  const before = state.items.slice();
  mutate(
    () => (state.items = state.items.filter((i) => !i.checked)),
    async () => {
      const { deleted } = await api('POST', '/api/items/clear-checked');
      toast(deleted === 1 ? '1 tildado borrado' : `${deleted} tildados borrados`);
    },
    () => (state.items = before)
  );
}

// Toques sobre la lista (un solo listener para todas las filas)
for (const listId of ['todo', 'done']) {
  $(listId).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.closest('.item').dataset.id;
    if (btn.dataset.action === 'toggle') toggleItem(id);
    if (btn.dataset.action === 'edit') openEditor(id);
  });
}

$('clear-btn').addEventListener('click', clearChecked);

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text) return;
  addItem(text);
  input.value = '';
  input.focus(); // para cargar varios seguidos
});

// ---------- Editar ----------
function openEditor(id) {
  const item = findItem(id);
  if (!item || item._pending) return;
  state.editingId = id;
  $('edit-name').value = item.name;
  $('edit-qty').value = item.qty || '';
  $('edit').showModal();
}

$('edit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('edit-name').value.trim();
  if (!name) return;
  saveItem(state.editingId, name, $('edit-qty').value.trim());
  $('edit').close();
});
$('edit-cancel').addEventListener('click', () => $('edit').close());
$('edit-delete').addEventListener('click', () => {
  deleteItem(state.editingId);
  $('edit').close();
});
// tocar fuera de la hoja la cierra
$('edit').addEventListener('click', (e) => {
  if (e.target === $('edit')) $('edit').close();
});

// ---------- Pestañas ----------
const TITLES = { semana: 'Semana', lista: 'Lista del súper', recetas: 'Recetas' };

function showTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll('.tab')) {
    if (btn.dataset.tab === tab) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const name of Object.keys(TITLES)) $(`view-${name}`).hidden = name !== tab;
  $('screen-title').textContent = TITLES[tab];
  const isList = tab === 'lista';
  $('composer').hidden = !isList;
  document.querySelector('.status-row').hidden = !isList;
  if (isList) refresh();
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}

// ---------- Refresco ----------
$('refresh-btn').addEventListener('click', () => refresh({ manual: true }));

setInterval(() => {
  if (state.key && state.tab === 'lista' && document.visibilityState === 'visible') refresh();
}, POLL_MS);

setInterval(renderSynced, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

// ---------- Aviso ----------
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Instalar ----------
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  $('install-btn').hidden = false;
});
$('install-btn').addEventListener('click', async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  $('install-btn').hidden = true;
});
window.addEventListener('appinstalled', () => ($('install-btn').hidden = true));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------- Inicio ----------
(function start() {
  let saved = null;
  try { saved = localStorage.getItem(KEY_STORAGE); } catch {}
  if (saved) {
    state.key = saved;
    $('app').hidden = false;
    showTab('lista');
  } else {
    lock();
  }
})();
