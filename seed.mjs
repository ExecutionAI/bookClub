// Backfill script for the real Supabase DB — members, past books, events,
// ratings, attendance. Idempotent: safe to run multiple times.
// Usage: node seed.mjs   (requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, no MOCK=1)
//
// Paola: fill in the arrays below with the club's real history, then run.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { hashPin } from './pin.mjs';

if (process.env.MOCK === '1') {
  console.error('MOCK=1 is set — seed targets the real DB only. Remove MOCK=1 from .env first.');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'bookclub' } });

// ══════════════════════════════════════════════════════════════════════════════
// EDIT THIS DATA
// ══════════════════════════════════════════════════════════════════════════════

const MEMBERS = [
  // { name: 'Paola', pin: '1234', joined_at: '2024-03-15' },
];

const PAST_BOOKS = [
  // event_date = primer día del mes (placeholder — actualizar a fechas reales antes de ejecutar)
  { title: 'Cadáver exquisito',                   author: 'Agustina Bazterrica',   year: 2017, cover_url: 'https://covers.openlibrary.org/b/id/15242766-L.jpg', event_date: '2025-09-01' },
  { title: 'Dioses de Jade y Sombra',             author: 'Silvia Moreno García',  year: 2019, isbn: '9780525620778', event_date: '2025-10-01' },
  { title: 'Las crónicas de un gato viajero',     author: 'Hiro Arikawa',          year: 2012, isbn: '9780857524195', event_date: '2025-11-01' },
  { title: 'The Housemaid',                       author: 'Freida McFadden',        year: 2022, cover_url: 'https://covers.openlibrary.org/b/id/14745848-L.jpg', event_date: '2025-12-01' },
  { title: 'La biblioteca de medianoche',         author: 'Matt Haig',              year: 2020, isbn: '9780525559474', event_date: '2026-01-01' },
  { title: 'Pachinko',                            author: 'Min Jin Lee',            year: 2017, isbn: '9781455563920', event_date: '2026-02-01' },
  { title: 'La vegetariana',                      author: 'Han Kang',               year: 2007, isbn: '9780553448184', event_date: '2026-03-01' },
  { title: 'La mala costumbre',                   author: 'Alana S. Portero',       year: 2023, cover_url: 'https://covers.openlibrary.org/b/id/14271576-L.jpg', event_date: '2026-04-01' },
  { title: 'La canción de Aquiles',               author: 'Madeline Miller',        year: 2011, isbn: '9780062060624', event_date: '2026-05-01' },
  { title: 'Funny Story',                         author: 'Emily Henry',            year: 2024, isbn: '9780593441282', event_date: '2026-06-01' },
  { title: 'Yo que nunca supe de los hombres',    author: 'Jacqueline Harpman',     year: 1995, cover_url: 'https://covers.openlibrary.org/b/id/14052201-L.jpg', event_date: '2026-07-01' },
  { title: 'Ministry of Time',                    author: 'Kaliane Bradley',        year: 2024, isbn: '9781668045152', event_date: '2026-08-01' },
  { title: 'Solaris',                             author: 'Stanisław Lem',          year: 1961, isbn: '9780156027601', event_date: '2026-09-01' },
];

const RATINGS = [
  // { member_name: 'Paola', book_title: 'Cien años de soledad', score: 9.5, note: null },
];

const ATTENDANCE = [
  // { event_date: '2026-02-28', member_names: ['Paola', 'Carolina'] },
];

// ══════════════════════════════════════════════════════════════════════════════

const AVATAR_COLORS = ['#d9a441', '#c9679a', '#f5c96b', '#8ec07c', '#d3869b', '#b28ae0', '#83a598', '#e07a5f'];

async function main() {
  console.log('Seeding bookclub schema…\n');

  // 1. Members (skip existing by name — never overwrite PINs on re-run)
  const { data: existingMembers } = await supabase.from('members').select('id, name');
  const membersByName = Object.fromEntries((existingMembers || []).map(m => [m.name, m]));

  for (const m of MEMBERS) {
    if (membersByName[m.name]) { console.log(`  member exists: ${m.name}`); continue; }
    const { data, error } = await supabase.from('members').insert({
      name: m.name,
      pin_hash: hashPin(m.pin),
      joined_at: m.joined_at || undefined,
      avatar_color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    }).select('id, name').single();
    if (error) { console.error(`  member FAILED: ${m.name} — ${error.message}`); continue; }
    membersByName[data.name] = data;
    console.log(`  member created: ${m.name}`);
  }

  // 2. Past books + completed events
  const { data: existingBooks } = await supabase.from('books').select('id, title');
  const booksByTitle = Object.fromEntries((existingBooks || []).map(b => [b.title, b]));
  const { data: existingEvents } = await supabase.from('events').select('id, event_at, winning_book_id');

  const eventsByDate = {};
  for (const e of existingEvents || []) eventsByDate[String(e.event_at).split('T')[0]] = e;

  for (const b of PAST_BOOKS) {
    let book = booksByTitle[b.title];
    if (!book) {
      const cover_url = b.cover_url || (b.isbn ? `https://covers.openlibrary.org/b/isbn/${b.isbn}-L.jpg` : null);
      const { data, error } = await supabase.from('books').insert({
        title: b.title, author: b.author || null, year: b.year || null, isbn: b.isbn || null,
        cover_url, status: 'read', read_at: b.event_date,
      }).select('id, title').single();
      if (error) { console.error(`  book FAILED: ${b.title} — ${error.message}`); continue; }
      book = data;
      booksByTitle[b.title] = book;
      console.log(`  book created: ${b.title}`);
    } else {
      console.log(`  book exists: ${b.title}`);
    }

    if (!eventsByDate[b.event_date]) {
      const { data, error } = await supabase.from('events').insert({
        title: `Encuentro — ${b.title}`,
        location: b.location || null,
        event_at: `${b.event_date}T19:00:00Z`,
        status: 'completed',
        winning_book_id: book.id,
        // winning_suggestion_id stays NULL for backfilled events
      }).select('id, event_at').single();
      if (error) { console.error(`  event FAILED: ${b.event_date} — ${error.message}`); continue; }
      eventsByDate[b.event_date] = data;
      console.log(`  event created: ${b.event_date}`);
    } else {
      console.log(`  event exists: ${b.event_date}`);
    }
  }

  // 3. Ratings (upsert — safe to re-run)
  for (const r of RATINGS) {
    const member = membersByName[r.member_name];
    const book = booksByTitle[r.book_title];
    if (!member || !book) { console.error(`  rating skipped (unknown member/book): ${r.member_name} → ${r.book_title}`); continue; }
    const { error } = await supabase.from('ratings').upsert(
      { member_id: member.id, book_id: book.id, score: r.score, note: r.note || null },
      { onConflict: 'member_id,book_id' }
    );
    if (error) console.error(`  rating FAILED: ${r.member_name} → ${r.book_title} — ${error.message}`);
    else console.log(`  rating: ${r.member_name} → ${r.book_title} = ${r.score}`);
  }

  // 4. Attendance (insert, ignore duplicates)
  for (const a of ATTENDANCE) {
    const event = eventsByDate[a.event_date];
    if (!event) { console.error(`  attendance skipped (no event on ${a.event_date})`); continue; }
    for (const name of a.member_names) {
      const member = membersByName[name];
      if (!member) { console.error(`  attendance skipped (unknown member ${name})`); continue; }
      const { error } = await supabase.from('attendance').insert({ event_id: event.id, member_id: member.id });
      if (error && !/duplicate/i.test(error.message)) console.error(`  attendance FAILED: ${name} @ ${a.event_date} — ${error.message}`);
    }
    console.log(`  attendance: ${a.event_date} (${a.member_names.length})`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
