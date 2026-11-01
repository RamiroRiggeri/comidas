# Comidas

App web instalable (PWA) para planificar los almuerzos y las cenas de la semana entre dos personas y armar la lista del súper compartida.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Usuarios | Dos personas, ambos con Android. Sin cuentas ni login. |
| Seguridad | "Clave de la casa": se escribe una vez por teléfono y queda guardada. El servidor rechaza todo pedido sin ella. |
| Comidas | Almuerzo y cena, 7 días, siempre para 2 porciones. |
| Lista del súper | Una sola lista continua (no se reinicia cada semana): sirve para la compra grande y para las de reposición. Se agrega a mano o desde la semana. CRUD completo. |
| Sincronización | Sin tiempo real. La lista se refresca sola cada 10 s mientras está abierta, al volver a la app y con el botón. |
| Duplicados | Si se agrega algo que ya está pendiente, no se duplica; si trae otra cantidad, se actualiza. |
| IA | API de Anthropic llamada desde el servidor (la key nunca llega al teléfono). Recetas escritas por Claude, kcal estimadas (±20 %). |
| Despensa | Sal, aceite, especias, etc. se separan de la compra real (paso 3). |

## Stack

- **Cloudflare Workers** sirve la interfaz (`public/`) y la API (`src/worker.js`).
- **Cloudflare D1** (SQLite) guarda los datos. El esquema se crea solo con migraciones versionadas en `src/worker.js`: para cambiarlo se agrega una entrada nueva al final de `MIGRATIONS`, nunca se editan las anteriores.
- **Interfaz** en HTML/CSS/JS sin framework ni paso de build.
- Deploy automático: cada push a `main` en GitHub lo publica Cloudflare.

## Plan

- [x] **Paso 0** — Infraestructura, instalación, clave de la casa y lista del súper manual compartida.
- [x] **Paso 1** — Planificador semanal: 7 días × almuerzo/cena, cargar, editar, borrar y mover comidas.
- [ ] **Paso 2** — "Quiero hacer X" → receta estructurada (ingredientes con cantidad, unidad y sector; pasos; kcal por porción). Requiere el secreto `ANTHROPIC_API_KEY`.
- [ ] **Paso 3** — Lista desde la semana: consolidar ingredientes, pasar a unidades de compra, agrupar por sector, separar despensa y mostrar frecuentes.
- [ ] **Paso 4** — Sugerencias de la semana.
- [ ] **Paso 5** — Recetario de favoritos, kcal totales por día y opción de repetir una semana.

## API

Todas las rutas requieren el header `x-clave`.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/ping` | Verifica la clave |
| GET | `/api/items` | Lista (pendientes primero) |
| POST | `/api/items` | Crea `{name, qty?}` |
| PATCH | `/api/items/:id` | Edita `{name?, qty?, checked?}` |
| DELETE | `/api/items/:id` | Borra |
| POST | `/api/items/clear-checked` | Borra todo lo tildado |
| POST | `/api/items/clear-all` | Borra toda la lista |
| GET | `/api/meals?from=| POST | `/api/items/clear-checked` | Borra todo lo tildado |to=` | Comidas entre dos fechas (YYYY-MM-DD) |
| POST | `/api/meals` | Crea `{date, slot, title, notes?}` (409 si el lugar está ocupado) |
| PATCH | `/api/meals/:id` | Edita y/o mueve; si el destino está ocupado, intercambia |
| DELETE | `/api/meals/:id` | Borra |

## Desarrollo local

```bash
npm install
echo "APP_KEY=prueba-local" > .dev.vars
npm run dev          # http://localhost:8787
```

## Configuración en Cloudflare (una sola vez)

1. Crear una base D1 llamada `comidas` y poner su ID en `database_id` de `wrangler.jsonc`.
2. Crear un Worker importando este repositorio desde GitHub (deploy command: `npx wrangler deploy`).
3. En las variables del Worker, cargar como **secreto**:
   - `APP_KEY`: la clave de la casa.
   - `ANTHROPIC_API_KEY`: a partir del paso 2.
