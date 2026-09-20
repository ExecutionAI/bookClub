// In-memory mock of the supabase-js subset used by api.mjs.
// Active when MOCK=1 or Supabase env vars are missing — lets the whole app run
// (including the raffle) with zero infrastructure. Preloaded with demo data.
// All member PINs in mock mode: 1234

import crypto from 'crypto';
import { hashPin } from './pin.mjs';

const uuid = () => crypto.randomUUID();

const UNIQUE = {
  members: [['name']],
  suggestions: [],
  ratings: [['member_id', 'book_id']],
  attendance: [['event_id', 'member_id']],
  event_rsvp: [['event_id', 'member_id']],
  votes: [['event_id', 'member_id', 'suggestion_id', 'round']],
};

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this._filters = [];
    this._action = { type: 'select' };
    this._order = null;
    this._single = false;
    this._count = false;
    this._head = false;
    this._selectAfter = false;
    this._cols = '*';
  }

  select(cols, opts) {
    if (this._action.type === 'select') {
      this._cols = cols || '*';
      if (opts?.count) this._count = true;
      if (opts?.head) this._head = true;
    } else {
      this._selectAfter = true;
    }
    return this;
  }
  insert(rows) { this._action = { type: 'insert', rows: Array.isArray(rows) ? rows : [rows] }; return this; }
  update(patch) { this._action = { type: 'update', patch }; return this; }
  upsert(row, opts) { this._action = { type: 'upsert', row, onConflict: (opts?.onConflict || '').split(',').map(s => s.trim()).filter(Boolean) }; return this; }
  delete() { this._action = { type: 'delete' }; return this; }

  eq(c, v)  { this._filters.push(r => String(r[c]) === String(v)); return this; }
  neq(c, v) { this._filters.push(r => String(r[c]) !== String(v)); return this; }
  in(c, vals) { const set = new Set(vals.map(String)); this._filters.push(r => set.has(String(r[c]))); return this; }
  is(c, v)  { this._filters.push(r => v === null ? (r[c] === null || r[c] === undefined) : r[c] === v); return this; }
  order(c, opts) { this._order = { col: c, asc: opts?.ascending !== false, nullsFirst: !!opts?.nullsFirst }; return this; }
  single() { this._single = true; return this; }

  _matching() {
    return (this.db.tables[this.table] || []).filter(r => this._filters.every(f => f(r)));
  }

  _sorted(rows) {
    if (!this._order) return rows;
    const { col, asc, nullsFirst } = this._order;
    return [...rows].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return nullsFirst ? -1 : 1;
      if (bv == null) return nullsFirst ? 1 : -1;
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
      return 0;
    });
  }

  _uniqueViolation(row, excludeRow = null) {
    for (const cols of (UNIQUE[this.table] || [])) {
      const clash = (this.db.tables[this.table] || []).find(r =>
        r !== excludeRow && cols.every(c => String(r[c]) === String(row[c]))
      );
      if (clash) return `duplicate key value violates unique constraint (${cols.join(',')})`;
    }
    return null;
  }

  _embed(row) {
    // Only embedded join used by api.mjs: sessions → member:members(...)
    const clone = { ...row };
    if (this.table === 'sessions' && String(this._cols).includes('member:members')) {
      clone.member = this.db.tables.members.find(m => String(m.id) === String(row.member_id)) || null;
    }
    return clone;
  }

  _exec() {
    const t = this.db.tables[this.table] || (this.db.tables[this.table] = []);

    if (this._action.type === 'select') {
      let rows = this._sorted(this._matching()).map(r => this._embed(r));
      if (this._count) return { data: this._head ? null : rows, error: null, count: rows.length };
      if (this._single) {
        if (rows.length !== 1) return { data: null, error: { message: `Expected 1 row, got ${rows.length}` } };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    }

    if (this._action.type === 'insert') {
      const inserted = [];
      for (const raw of this._action.rows) {
        const row = { ...raw };
        if (!('id' in row) && this.table !== 'attendance' && this.table !== 'sessions' && this.table !== 'event_rsvp') row.id = uuid();
        if (!row.created_at) row.created_at = new Date().toISOString();
        const err = this._uniqueViolation(row);
        if (err) return { data: null, error: { message: err } };
        t.push(row);
        inserted.push({ ...row });
      }
      return { data: this._single ? inserted[0] : inserted, error: null };
    }

    if (this._action.type === 'update') {
      const rows = this._matching();
      const updated = [];
      for (const row of rows) {
        const candidate = { ...row, ...this._action.patch };
        const err = this._uniqueViolation(candidate, row);
        if (err) return { data: null, error: { message: err } };
        Object.assign(row, this._action.patch);
        updated.push({ ...row });
      }
      if (this._single) {
        if (updated.length !== 1) return { data: null, error: { message: `Expected 1 row, got ${updated.length}` } };
        return { data: updated[0], error: null };
      }
      return { data: updated, error: null };
    }

    if (this._action.type === 'upsert') {
      const { row: raw, onConflict } = this._action;
      const existing = onConflict.length
        ? t.find(r => onConflict.every(c => String(r[c]) === String(raw[c])))
        : null;
      if (existing) {
        Object.assign(existing, raw, { updated_at: new Date().toISOString() });
        return { data: this._single ? { ...existing } : [{ ...existing }], error: null };
      }
      const row = { ...raw, id: raw.id || uuid(), created_at: new Date().toISOString() };
      const err = this._uniqueViolation(row);
      if (err) return { data: null, error: { message: err } };
      t.push(row);
      return { data: this._single ? { ...row } : [{ ...row }], error: null };
    }

    if (this._action.type === 'delete') {
      const rows = this._matching();
      this.db.tables[this.table] = t.filter(r => !rows.includes(r));
      return { data: null, error: null };
    }

    return { data: null, error: { message: 'Unknown action' } };
  }

  then(resolve) {
    try { resolve(this._exec()); }
    catch (e) { resolve({ data: null, error: { message: e.message } }); }
  }
}

export function createMockClient() {
  const db = { tables: { members: [], sessions: [], books: [], events: [], suggestions: [], ratings: [], attendance: [], event_rsvp: [], votes: [], photos: [], event_materials: [] } };
  const files = new Map();

  seedDemo(db);

  return {
    _isMock: true,
    _db: db,
    from: (table) => new Query(db, table),
    storage: {
      _files: files,
      createBucket: async () => ({ data: null, error: null }),
      from: () => ({
        upload: async (path, buffer) => { files.set(path, buffer); return { data: { path }, error: null }; },
        createSignedUrl: async (path) => {
          if (files.has(path)) {
            const route = path.startsWith('photos/') ? 'mock-photo'
                        : path.startsWith('materials/') ? 'mock-material'
                        : 'mock-pdf';
            return { data: { signedUrl: `/${route}/${encodeURIComponent(path)}` }, error: null };
          }
          // Demo photos that aren't in the files map get a placeholder image
          if (path.startsWith('photos/')) {
            const colors = ['2a1f47/d9a441', '3d2f61/c9679a', '1e1533/f5c96b'];
            const idx = path.charCodeAt(7) % 3;
            return { data: { signedUrl: `https://placehold.co/800x600/${colors[idx]}?text=📸` }, error: null };
          }
          return { data: null, error: { message: 'Object not found' } };
        },
        remove: async (paths) => { paths.forEach(p => files.delete(p)); return { data: null, error: null }; },
      }),
    },
  };
}

// ── Demo data ─────────────────────────────────────────────────────────────────

function seedDemo(db) {
  const pin = hashPin('1234');
  const M = (name, joined_at, avatar_color) => ({ id: uuid(), name, pin_hash: pin, joined_at, is_active: true, avatar_color, created_at: new Date().toISOString() });

  const paola = M('Paola', '2024-03-15', '#d9a441');
  const caro = M('Carolina', '2024-03-15', '#c9679a');
  const diego = M('Diego', '2024-06-02', '#b28ae0');
  const luz = M('Luz', '2024-09-20', '#f5c96b');
  const mateo = M('Mateo', '2025-01-11', '#8ec07c');
  const vale = M('Valentina', '2025-05-30', '#d3869b');
  const members = [paola, caro, diego, luz, mateo, vale];
  db.tables.members = members;

  const cover = isbn => `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
  const B = (title, author, year, isbn, status, read_at, description) => ({
    id: uuid(), title, author, year, isbn, cover_url: cover(isbn), description,
    status, read_at, pdf_path: null, pdf_uploaded_at: null, created_at: new Date().toISOString(),
  });

  const cien = B('Cien años de soledad', 'Gabriel García Márquez', 1967, '9780307474728', 'read', '2026-02-28', 'La saga de la familia Buendía en Macondo.');
  const amor = B('El amor en los tiempos del cólera', 'Gabriel García Márquez', 1985, '9780307389732', 'read', '2026-03-28', 'Un amor que espera más de cincuenta años.');
  const casa = B('La casa de los espíritus', 'Isabel Allende', 1982, '9781501117015', 'read', '2026-04-25', 'Cuatro generaciones de la familia Trueba.');
  const pedro = B('Pedro Páramo', 'Juan Rulfo', 1955, '9780802133908', 'read', '2026-05-30', 'Un viaje a Comala en busca del padre.');
  const agua = B('Como agua para chocolate', 'Laura Esquivel', 1989, '9780385420174', 'read', '2026-06-27', 'Recetas, amores y revolución.');
  const sombra = B('La sombra del viento', 'Carlos Ruiz Zafón', 2001, '9780143126393', 'read', '2026-08-29', 'El Cementerio de los Libros Olvidados.');
  const rayuela = B('Rayuela', 'Julio Cortázar', 1963, '9788437604572', 'reading', null, 'Una novela que se lee de muchas maneras.');
  db.tables.books = [cien, amor, casa, pedro, agua, sombra, rayuela];

  // Suggested books for the upcoming raffle (titles secret until the draw)
  const sug1 = B('Ficciones', 'Jorge Luis Borges', 1944, '9780802130303', 'suggested', null, null);
  const sug2 = B('La ciudad y los perros', 'Mario Vargas Llosa', 1963, '9780571148196', 'suggested', null, null);
  const sug3 = B('Mujeres que corren con los lobos', 'Clarissa Pinkola Estés', 1992, '9780345409874', 'suggested', null, null);
  const sug4 = B('El túnel', 'Ernesto Sabato', 1948, '9780345804181', 'suggested', null, null);
  db.tables.books.push(sug1, sug2, sug3, sug4);

  // Candidates for the November vote event (theme: mujeres que escriben)
  const sug5 = B('Temporada de huracanes', 'Fernanda Melchor', 2017, '9786079709310', 'suggested', null, null);
  const sug6 = B('Las malas', 'Camila Sosa Villada', 2019, '9788490668153', 'suggested', null, null);
  const sug7 = B('Nuestra parte de noche', 'Mariana Enríquez', 2019, '9788433998521', 'suggested', null, null);
  db.tables.books.push(sug5, sug6, sug7);

  const E = (title, location, event_at, raffle_at, status, winning_book_id, drawn_at) => ({
    id: uuid(), title, description: null, location, event_at, raffle_at, status,
    selection_method: 'raffle', theme: null, vote_deadline: null, vote_round: 1, runoff_candidate_ids: null,
    winning_book_id: winning_book_id || null, winning_suggestion_id: null, drawn_at: drawn_at || null,
    created_at: new Date().toISOString(),
  });

  const evts = [
    E('Encuentro de Febrero', 'Café Belén, De Pijp', '2026-02-28T19:00:00Z', null, 'completed', cien.id),
    E('Encuentro de Marzo', 'Casa de Carolina, Oost', '2026-03-28T19:00:00Z', null, 'completed', amor.id),
    E('Encuentro de Abril', 'Parque Vondelpark (picnic)', '2026-04-25T15:00:00Z', null, 'completed', casa.id),
    E('Encuentro de Mayo', 'Café Belén, De Pijp', '2026-05-30T19:00:00Z', null, 'completed', pedro.id),
    E('Encuentro de Junio', 'Terraza de Diego, Noord', '2026-06-27T18:00:00Z', null, 'completed', agua.id),
    E('Encuentro de Agosto', 'Café Belén, De Pijp', '2026-08-29T19:00:00Z', null, 'completed', sombra.id),
  ];

  // Current cycle: raffled event (reading Rayuela), drawn 5 days ago
  const current = E('Encuentro de Septiembre', 'Casa de Paola, Rivierenbuurt', '2026-09-20T19:00:00Z', '2026-09-06T20:00:00Z', 'raffled', rayuela.id, '2026-09-06T20:04:00Z');
  current.theme = 'Realismo mágico';
  // Next cycle: planned raffle event with open suggestions
  const next = E('Encuentro de Octubre', 'Café Belén, De Pijp', '2026-10-24T19:00:00Z', '2026-10-09T20:00:00Z', 'planned', null);
  next.theme = 'Voces de la diáspora';
  // Cycle after: planned VOTE event — book decided by public poll
  const nov = E('Encuentro de Noviembre', 'Casa de Luz, Jordaan', '2026-11-21T19:00:00Z', null, 'planned', null);
  nov.selection_method = 'vote';
  nov.theme = 'Mujeres que escriben';
  nov.vote_deadline = '2026-11-07T20:00:00Z';
  db.tables.events = [...evts, current, next, nov];

  const S = (event_id, member_id, book_id) => ({ id: uuid(), event_id, member_id, book_id, created_at: new Date().toISOString() });
  const curSug = S(current.id, luz.id, rayuela.id);
  const novSugCaro = S(nov.id, caro.id, sug5.id);
  db.tables.suggestions = [
    curSug,
    S(current.id, diego.id, sug4.id),
    S(next.id, caro.id, sug1.id),
    S(next.id, mateo.id, sug2.id),
    S(next.id, vale.id, sug3.id),
    novSugCaro,
    S(nov.id, mateo.id, sug6.id),
    S(nov.id, vale.id, sug7.id),
  ];
  current.winning_suggestion_id = curSug.id;

  // One seeded vote so the poll page looks alive in demo mode
  db.tables.votes = [
    { id: uuid(), event_id: nov.id, member_id: luz.id, suggestion_id: novSugCaro.id, round: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];

  const R = (member, book, score, note) => ({ id: uuid(), member_id: member.id, book_id: book.id, score, note: note || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  db.tables.ratings = [
    R(paola, cien, 9.5, 'Macondo para siempre.'), R(caro, cien, 9), R(diego, cien, 8.5), R(luz, cien, 10), R(mateo, cien, 8),
    R(paola, amor, 8.5), R(caro, amor, 9), R(luz, amor, 7.5), R(vale, amor, 8),
    R(paola, casa, 8), R(caro, casa, 8.5, 'Clara es mi personaje favorito.'), R(diego, casa, 7), R(mateo, casa, 7.5),
    R(paola, pedro, 7.5), R(diego, pedro, 9, 'Denso pero brutal.'), R(luz, pedro, 6.5), R(vale, pedro, 7),
    R(paola, agua, 8), R(caro, agua, 8.5), R(luz, agua, 9), R(vale, agua, 9.5, 'Lloré con las recetas.'),
    R(paola, sombra, 9), R(caro, sombra, 8.5), R(diego, sombra, 8), R(mateo, sombra, 9.5), R(vale, sombra, 9),
  ];

  const pid1 = uuid(), pid2 = uuid(), pid3 = uuid();
  db.tables.photos = [
    { id: pid1, path: `photos/${pid1}.jpg`, event_id: evts[0].id, caption: 'Así arrancó todo — Cien años de soledad', uploaded_at: evts[0].event_at },
    { id: pid2, path: `photos/${pid2}.jpg`, event_id: evts[4].id, caption: 'Picnic con Agua para chocolate en el parque', uploaded_at: evts[4].event_at },
    { id: pid3, path: `photos/${pid3}.jpg`, event_id: null, caption: null, uploaded_at: new Date().toISOString() },
  ];

  const A = (event, ...ms) => ms.map(m => ({ event_id: event.id, member_id: m.id, created_at: new Date().toISOString() }));
  db.tables.attendance = [
    ...A(evts[0], paola, caro, diego, luz, mateo),
    ...A(evts[1], paola, caro, luz, vale),
    ...A(evts[2], paola, caro, diego, mateo),
    ...A(evts[3], paola, diego, luz, vale),
    ...A(evts[4], paola, caro, luz, vale, mateo),
    ...A(evts[5], paola, caro, diego, mateo, vale),
  ];
}
