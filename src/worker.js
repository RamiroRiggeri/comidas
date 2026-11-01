// Servidor de la app de comidas.
// Atiende /api/* (protegido por la clave de la casa) y delega el resto a los archivos estáticos.

// ---------- Migraciones de la base ----------
// Cada entrada es una versión del esquema. Para cambiar la base en el futuro
// se AGREGA una entrada nueva al final; nunca se editan las anteriores.
const MIGRATIONS = [
  // v1 — lista del súper
  [
    `CREATE TABLE IF NOT EXISTS items (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      qty         TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL DEFAULT 'Otros',
      checked     INTEGER NOT NULL DEFAULT 0,
      source      TEXT NOT NULL DEFAULT 'manual',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )`,
  ],
];

let migrated = null; // se ejecuta una vez por instancia del servidor

async function migrate(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
  let version = row ? Number(row.value) : 0;
  for (; version < MIGRATIONS.length; version++) {
    const stmts = MIGRATIONS[version].map((sql) => db.prepare(sql));
    stmts.push(
      db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .bind(String(version + 1))
    );
    await db.batch(stmts); // batch = transacción: o entra todo o nada
  }
}

function ensureSchema(db) {
  if (!migrated) {
    migrated = migrate(db).catch((err) => {
      migrated = null; // reintenta en el próximo pedido
      throw err;
    });
  }
  return migrated;
}

// ---------- Utilidades ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, error) => json({ error }, status);

function sameKey(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- Lista del súper ----------
const ITEM_COLUMNS = 'id, name, qty, category, checked, source, created_at, updated_at';

function toItem(row) {
  return { ...row, checked: row.checked === 1 };
}

async function listItems(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${ITEM_COLUMNS} FROM items ORDER BY checked ASC, created_at ASC`
  ).all();
  return json({ items: results.map(toItem), now: Date.now() });
}

async function createItem(request, env) {
  const body = await readBody(request);
  const name = clean(body.name, 80);
  if (!name) return fail(400, 'Escribí qué hay que comprar.');
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    name,
    qty: clean(body.qty, 40),
    category: clean(body.category, 30) || 'Otros',
    checked: 0,
    source: body.source === 'semana' ? 'semana' : 'manual',
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(item.id, item.name, item.qty, item.category, item.checked, item.source, item.created_at, item.updated_at)
    .run();
  return json({ item: toItem(item) }, 201);
}

async function updateItem(request, env, id) {
  const body = await readBody(request);
  const sets = [];
  const values = [];
  if ('name' in body) {
    const name = clean(body.name, 80);
    if (!name) return fail(400, 'El nombre no puede quedar vacío.');
    sets.push('name = ?');
    values.push(name);
  }
  if ('qty' in body) {
    sets.push('qty = ?');
    values.push(clean(body.qty, 40));
  }
  if ('category' in body) {
    sets.push('category = ?');
    values.push(clean(body.category, 30) || 'Otros');
  }
  if ('checked' in body) {
    sets.push('checked = ?');
    values.push(body.checked ? 1 : 0);
  }
  if (!sets.length) return fail(400, 'No hay cambios para guardar.');
  sets.push('updated_at = ?');
  values.push(Date.now());

  const row = await env.DB.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? RETURNING ${ITEM_COLUMNS}`)
    .bind(...values, id)
    .first();
  if (!row) return fail(404, 'Ese ítem ya no está en la lista.');
  return json({ item: toItem(row) });
}

async function deleteItem(env, id) {
  const { meta } = await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
  return json({ deleted: meta.changes });
}

async function clearChecked(env) {
  const { meta } = await env.DB.prepare('DELETE FROM items WHERE checked = 1').run();
  return json({ deleted: meta.changes });
}

// ---------- Router ----------
async function handleApi(request, env, url) {
  if (!env.APP_KEY) return fail(500, 'Falta configurar la clave de la casa (APP_KEY) en Cloudflare.');
  if (!sameKey(request.headers.get('x-clave') || '', env.APP_KEY)) return fail(401, 'Clave incorrecta.');

  await ensureSchema(env.DB);

  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/ping' && method === 'GET') return json({ ok: true });

  if (path === '/api/items') {
    if (method === 'GET') return listItems(env);
    if (method === 'POST') return createItem(request, env);
  }
  if (path === '/api/items/clear-checked' && method === 'POST') return clearChecked(env);

  const match = path.match(/^\/api\/items\/([0-9a-f-]{36})$/);
  if (match) {
    if (method === 'PATCH') return updateItem(request, env, match[1]);
    if (method === 'DELETE') return deleteItem(env, match[1]);
  }

  return fail(404, 'Ruta inexistente.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      console.error(err);
      return fail(500, 'Error del servidor. Probá de nuevo en un momento.');
    }
  },
};
