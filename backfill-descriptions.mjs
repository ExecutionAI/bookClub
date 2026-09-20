// Backfill missing book descriptions from OpenLibrary.
// Usage: node backfill-descriptions.mjs
// Requires api.mjs running on :3001 with a live DB (no MOCK=1).

const BASE = 'http://localhost:3001';
const ADMIN = { 'x-admin-token': process.env.ADMIN_TOKEN || 'club_lectura.2026' };

async function fetchDescription(title, author) {
  const q = encodeURIComponent(`${title} ${author || ''}`.trim());
  const res = await fetch(`https://openlibrary.org/search.json?q=${q}&limit=3&fields=title,key`);
  if (!res.ok) return null;
  const { docs } = await res.json();
  if (!docs?.length) return null;

  // Try each candidate until we find one with a description
  for (const doc of docs) {
    if (!doc.key) continue;
    const work = await fetch(`https://openlibrary.org${doc.key}.json`).then(r => r.ok ? r.json() : null);
    if (!work) continue;
    const raw = work.description;
    const desc = raw ? (typeof raw === 'string' ? raw : raw.value || null) : null;
    if (desc) return desc;
  }
  return null;
}

const books = await fetch(`${BASE}/api/admin/books`, { headers: ADMIN }).then(r => r.json());
const missing = books.filter(b => !b.description);

if (!missing.length) {
  console.log('Todos los libros ya tienen sinopsis.');
  process.exit(0);
}

console.log(`Buscando sinopsis para ${missing.length} libro(s)…\n`);

for (const book of missing) {
  process.stdout.write(`  "${book.title}" … `);
  try {
    const desc = await fetchDescription(book.title, book.author);
    if (!desc) { console.log('no encontrada'); continue; }

    const r = await fetch(`${BASE}/api/admin/books/${book.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc }),
    });
    if (r.ok) {
      console.log(`✓ (${desc.length} chars)`);
    } else {
      const err = await r.json();
      console.log(`error al guardar: ${err.error}`);
    }
  } catch (e) {
    console.log(`error: ${e.message}`);
  }

  // Be polite to OpenLibrary — avoid rate limiting
  await new Promise(r => setTimeout(r, 600));
}

console.log('\nListo.');
