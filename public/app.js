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

$('lock-eye').addEventListener('click', () => {
  const input = $('lock-input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('lock-eye').setAttribute('aria-pressed', String(show));
  $('lock-eye').setAttribute('aria-label', show ? 'Ocultar la clave' : 'Mostrar la clave');
  input.focus();
});

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
const DRAG_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></g></svg>';
const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

function rowHtml(item) {
  const cls = ['item', item.checked ? 'is-done' : '', item._pending ? 'is-pending' : ''].join(' ');
  // Solo lo pendiente se puede reordenar; en el carrito queda un espacio para que todo quede alineado.
  const handle = item.checked
    ? '<span class="drag-spacer" aria-hidden="true"></span>'
    : `<span class="drag" data-drag aria-hidden="true">${DRAG_SVG}</span>`;
  return `<li class="${cls}" data-id="${esc(item.id)}">
    ${handle}
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
  $('clear-all-block').hidden = state.items.length === 0;
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
    if (seq === state.mutSeq && state.pending === 0 && !drag.active) {
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
  const maxPos = Math.max(0, ...state.items.map((i) => i.position || 0));
  const temp = { id: `tmp-${Date.now()}`, name, qty, checked: false, position: maxPos + 1000, _pending: true };
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

// ---------- Reordenar arrastrando la manija ----------
const drag = { active: false };

function sortItems() {
  state.items.sort((a, b) => a.checked - b.checked || (a.position ?? 0) - (b.position ?? 0));
}

const pageMid = (el) => el.getBoundingClientRect().top + window.scrollY + el.offsetHeight / 2;

$('todo').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag]');
  if (!handle || drag.active) return;
  const li = handle.closest('.item');
  const item = findItem(li.dataset.id);
  if (!item || item._pending) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  Object.assign(drag, {
    active: true, li, id: item.id, pointerId: e.pointerId,
    startY: e.clientY + window.scrollY, pointerY: e.clientY, startTop: li.offsetTop,
  });
  li.classList.add('is-dragging');
  document.body.classList.add('dragging');
  navigator.vibrate?.(12);
  drag.raf = requestAnimationFrame(dragFrame);
});

$('todo').addEventListener('pointermove', (e) => {
  if (drag.active && e.pointerId === drag.pointerId) drag.pointerY = e.clientY;
});
$('todo').addEventListener('pointerup', (e) => {
  if (drag.active && e.pointerId === drag.pointerId) endDrag();
});
$('todo').addEventListener('pointercancel', (e) => {
  if (drag.active && e.pointerId === drag.pointerId) endDrag();
});

function dragFrame() {
  if (!drag.active) return;
  // si el dedo llega cerca del borde, la pantalla se desplaza sola
  const topEdge = document.querySelector('.top').getBoundingClientRect().bottom + 50;
  const bottomEdge = $('composer').getBoundingClientRect().top - 50;
  if (drag.pointerY < topEdge) window.scrollBy(0, -10);
  else if (drag.pointerY > bottomEdge) window.scrollBy(0, 10);

  const list = $('todo');
  const li = drag.li;
  const y = drag.pointerY + window.scrollY;
  let prev = li.previousElementSibling;
  while (prev && y < pageMid(prev)) {
    list.insertBefore(li, prev);
    prev = li.previousElementSibling;
  }
  let next = li.nextElementSibling;
  while (next && y > pageMid(next)) {
    list.insertBefore(next, li);
    next = li.nextElementSibling;
  }
  li.style.transform = `translateY(${y - drag.startY - (li.offsetTop - drag.startTop)}px)`;
  drag.raf = requestAnimationFrame(dragFrame);
}

function endDrag() {
  drag.active = false;
  cancelAnimationFrame(drag.raf);
  drag.li.style.transform = '';
  drag.li.classList.remove('is-dragging');
  document.body.classList.remove('dragging');

  const todo = state.items.filter((i) => !i.checked);
  const ids = [...$('todo').children].map((el) => el.dataset.id);
  const ordered = ids.map((id) => todo.find((i) => i.id === id)).filter(Boolean);
  const item = todo.find((i) => i.id === drag.id);
  const newIndex = ordered.indexOf(item);
  if (!item || newIndex === todo.indexOf(item)) return render();

  // nueva posición: a mitad de camino entre los vecinos
  const before = ordered[newIndex - 1];
  const after = ordered[newIndex + 1];
  const position = before && after
    ? (before.position + after.position) / 2
    : before ? before.position + 1000 : after.position - 1000;
  const old = item.position;
  mutate(
    () => { item.position = position; item._pending = true; sortItems(); },
    async () => {
      const { item: saved } = await api('PATCH', `/api/items/${item.id}`, { position });
      Object.assign(item, saved);
      delete item._pending;
    },
    () => { item.position = old; delete item._pending; sortItems(); }
  );
}

// Hoja de confirmación propia (reemplaza al confirm() del navegador). Devuelve true si confirman.
function ask({ title, text, ok = 'Borrar' }) {
  const dlg = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  $('confirm-ok').focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}
$('confirm').addEventListener('click', (e) => {
  if (e.target === $('confirm')) $('confirm').close('cancel'); // tocar fuera cancela
});

async function clearChecked() {
  const done = state.items.filter((i) => i.checked);
  if (!done.length) return;
  const n = done.length;
  const okay = await ask({
    title: n === 1 ? '¿Borrar el tildado?' : `¿Borrar los ${n} tildados?`,
    text: 'Se sacan de la lista lo que ya está en el carrito. Lo pendiente queda como está.',
    ok: 'Borrar tildados',
  });
  if (!okay) return;
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

async function clearAll() {
  const n = state.items.length;
  if (!n) return;
  const okay = await ask({
    title: '¿Borrar toda la lista?',
    text: `Se borran ${n === 1 ? 'el único ítem' : `los ${n} ítems`}, tildados o no, en los dos teléfonos. No se puede deshacer.`,
    ok: 'Borrar todo',
  });
  if (!okay) return;
  const before = state.items.slice();
  mutate(
    () => (state.items = []),
    async () => {
      await api('POST', '/api/items/clear-all');
      toast('Lista borrada');
    },
    () => (state.items = before)
  );
}
$('clear-all-btn').addEventListener('click', clearAll);

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

// ---------- Semana ----------
const SLOT_NAMES = { almuerzo: 'Almuerzo', cena: 'Cena' };
const week = { start: mondayOf(new Date()), meals: [], loadedFor: null, editing: null };

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(x, -((x.getDay() + 6) % 7));
}
function fromYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtWeekday = new Intl.DateTimeFormat('es-AR', { weekday: 'long' });
const fmtMonth = new Intl.DateTimeFormat('es-AR', { month: 'long' });
const dayName = (d) => `${cap(fmtWeekday.format(d))} ${d.getDate()}`;

function rangeLabel(start) {
  const end = addDays(start, 6);
  const m1 = fmtMonth.format(start);
  const m2 = fmtMonth.format(end);
  return m1 === m2
    ? `${start.getDate()} al ${end.getDate()} de ${m2}`
    : `${start.getDate()} de ${m1} al ${end.getDate()} de ${m2}`;
}

async function loadWeek({ manual = false } = {}) {
  if (!state.key) return;
  const from = ymd(week.start);
  const to = ymd(addDays(week.start, 6));
  const btn = $('refresh-btn');
  if (manual) btn.classList.add('spinning');
  try {
    const data = await api('GET', `/api/meals?from=${from}&to=${to}`);
    if (ymd(week.start) !== from) return; // cambiaron de semana mientras cargaba
    week.meals = data.meals;
    week.loadedFor = from;
    renderWeek();
  } catch (err) {
    handleError(err);
  } finally {
    if (manual) setTimeout(() => btn.classList.remove('spinning'), 400);
  }
}

function renderWeek() {
  const today = ymd(new Date());
  const isCurrent = ymd(week.start) === ymd(mondayOf(new Date()));
  $('week-range').textContent = rangeLabel(week.start);
  $('week-today').hidden = isCurrent;

  const loaded = week.loadedFor === ymd(week.start);
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(week.start, i);
    const key = ymd(d);
    html += `<section class="day${key < today ? ' is-past' : ''}" aria-label="${esc(dayName(d))}">
      <h2 class="day-head">${esc(dayName(d))}${key === today ? '<span class="today">Hoy</span>' : ''}</h2>`;
    for (const slot of ['almuerzo', 'cena']) {
      const meal = loaded ? week.meals.find((m) => m.date === key && m.slot === slot) : null;
      html += `<button type="button" class="slot${meal?._pending ? ' is-pending' : ''}" data-date="${key}" data-slot="${slot}">
        <span class="slot-label">${SLOT_NAMES[slot]}</span>
        ${
          meal
            ? `<span class="slot-meal"><span class="slot-title">${esc(meal.title)}</span>${
                meal.notes ? `<span class="slot-notes">${esc(meal.notes)}</span>` : ''
              }</span>`
            : `<span class="slot-empty">${loaded ? 'Agregar' : '…'}</span>`
        }
      </button>`;
    }
    html += '</section>';
  }
  $('week').innerHTML = html;
}

function shiftWeek(n) {
  week.start = addDays(week.start, 7 * n);
  week.meals = [];
  renderWeek();
  loadWeek();
}

$('week-prev').addEventListener('click', () => shiftWeek(-1));
$('week-next').addEventListener('click', () => shiftWeek(1));
$('week-today').addEventListener('click', () => {
  week.start = mondayOf(new Date());
  week.meals = [];
  renderWeek();
  loadWeek();
});

$('week').addEventListener('click', (e) => {
  const btn = e.target.closest('.slot');
  if (!btn || week.loadedFor !== ymd(week.start)) return;
  const meal = week.meals.find((m) => m.date === btn.dataset.date && m.slot === btn.dataset.slot);
  if (meal?._pending) return;
  openMeal(btn.dataset.date, btn.dataset.slot, meal);
});

function openMeal(date, slot, meal) {
  week.editing = { date, slot, meal: meal || null };
  $('meal-title').textContent = `${dayName(fromYmd(date))}, ${SLOT_NAMES[slot].toLowerCase()}`;
  $('meal-name').value = meal?.title || '';
  $('meal-notes').value = meal?.notes || '';
  $('meal-delete').hidden = !meal;
  $('meal-move').hidden = !meal;
  if (meal) {
    // opciones: esta semana y la siguiente
    let opts = '';
    for (let i = 0; i < 14; i++) {
      const d = addDays(week.start, i);
      const key = ymd(d);
      opts += `<option value="${key}"${key === date ? ' selected' : ''}>${esc(dayName(d))}${
        i === 7 ? ' (sem. siguiente)' : ''
      }</option>`;
    }
    $('meal-date').innerHTML = opts;
    $('meal-slot').value = slot;
  }
  updateSwapHint();
  $('meal').showModal();
  if (!meal) $('meal-name').focus();
}

function updateSwapHint() {
  const ed = week.editing;
  const hint = $('meal-swap-hint');
  if (!ed?.meal) return (hint.hidden = true);
  const date = $('meal-date').value;
  const slot = $('meal-slot').value;
  const other =
    (date !== ed.date || slot !== ed.slot) && week.meals.find((m) => m.date === date && m.slot === slot);
  hint.hidden = !other;
  if (other) hint.textContent = `Ahí ya está "${other.title}". Van a intercambiar lugares.`;
}
$('meal-date').addEventListener('change', updateSwapHint);
$('meal-slot').addEventListener('change', updateSwapHint);

$('meal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ed = week.editing;
  const title = $('meal-name').value.trim();
  if (!title || !ed) return;
  const notes = $('meal-notes').value.trim();
  $('meal').close();

  try {
    if (!ed.meal) {
      const temp = { id: `tmp-${Date.now()}`, date: ed.date, slot: ed.slot, title, notes, _pending: true };
      week.meals.push(temp);
      renderWeek();
      await api('POST', '/api/meals', { date: ed.date, slot: ed.slot, title, notes });
    } else {
      const date = ed.meal ? $('meal-date').value : ed.date;
      const slot = ed.meal ? $('meal-slot').value : ed.slot;
      Object.assign(ed.meal, { title, notes, _pending: true });
      renderWeek();
      const res = await api('PATCH', `/api/meals/${ed.meal.id}`, { title, notes, date, slot });
      const outside = date < ymd(week.start) || date > ymd(addDays(week.start, 6));
      if (res.swapped) toast('Comidas intercambiadas');
      else if (outside) toast(`${title}: movida a la semana siguiente`);
    }
  } catch (err) {
    handleError(err);
  }
  loadWeek();
});

$('meal-delete').addEventListener('click', async () => {
  const meal = week.editing?.meal;
  if (!meal) return;
  $('meal').close();
  week.meals = week.meals.filter((m) => m !== meal);
  renderWeek();
  try {
    await api('DELETE', `/api/meals/${meal.id}`);
    toast(`${meal.title}: borrada`);
  } catch (err) {
    handleError(err);
  }
  loadWeek();
});
$('meal-cancel').addEventListener('click', () => $('meal').close());
$('meal').addEventListener('click', (e) => {
  if (e.target === $('meal')) $('meal').close();
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
  $('status-row').hidden = !isList;
  $('week-nav').hidden = tab !== 'semana';
  if (tab === 'semana') renderWeek();
  refreshCurrent();
}

function refreshCurrent(opts) {
  if (state.tab === 'lista') return refresh(opts);
  if (state.tab === 'semana') return loadWeek(opts);
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}

// ---------- Refresco ----------
$('refresh-btn').addEventListener('click', () => refreshCurrent({ manual: true }));

setInterval(() => {
  if (state.key && state.tab === 'lista' && document.visibilityState === 'visible') refresh();
}, POLL_MS);

setInterval(renderSynced, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // si la app quedó abierta de un día para otro, que "Hoy" se actualice
  if (state.tab === 'semana') renderWeek();
  refreshCurrent();
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

// ---------- Tema claro / oscuro ----------
// Arranca siguiendo al teléfono; si se toca el botón, queda fijo en este teléfono.
const THEME_KEY = 'planimorfi.tema';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');

function paintThemeButton() {
  const dark = currentTheme() === 'dark';
  $('theme-btn').classList.toggle('is-dark', dark);
  $('theme-btn').setAttribute('aria-label', dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  document.querySelector('meta[name=theme-color]').content = dark ? '#0B1814' : '#1E3B33';
}
$('theme-btn').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  paintThemeButton();
});
darkQuery.addEventListener('change', paintThemeButton);
paintThemeButton();

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
