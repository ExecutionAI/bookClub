import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { hashPin, verifyPin } from './pin.mjs';
import { createMockClient } from './mockdb.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// ── Clients ───────────────────────────────────────────────────────────────────

const useMock = process.env.MOCK === '1' || !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = useMock
  ? createMockClient()
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'bookclub' } });
if (useMock) console.warn('MOCK MODE — in-memory demo data, all PINs are 1234. Remove MOCK=1 from .env to use Supabase.');
else         console.log('Supabase connected (bookclub schema)');

const PDF_BUCKET = 'bookclub-pdfs';

// Create the private PDF bucket if it doesn't exist yet (idempotent)
async function ensureBucket() {
  if (!supabase) return;
  const { error } = await supabase.storage.createBucket(PDF_BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) {
    console.warn(`Bucket check: ${error.message}`);
  }
}
ensureBucket();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Serve mock-stored PDFs/photos when running without Supabase
if (useMock) {
  app.get('/mock-pdf/:path', (req, res) => {
    const buffer = supabase.storage._files.get(decodeURIComponent(req.params.path));
    if (!buffer) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', 'application/pdf');
    res.send(buffer);
  });
  app.get('/mock-photo/:path', (req, res) => {
    const buffer = supabase.storage._files.get(decodeURIComponent(req.params.path));
    if (!buffer) return res.status(404).json({ error: 'Not found' });
    const ext = req.params.path.split('.').pop().toLowerCase();
    res.set('Content-Type', ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    res.send(buffer);
  });
  app.get('/mock-material/:path(*)', (req, res) => {
    const decodedPath = decodeURIComponent(req.params.path);
    const buffer = supabase.storage._files.get(decodedPath);
    if (!buffer) return res.status(404).json({ error: 'Not found' });
    const mat = supabase._db.tables.event_materials.find(m => m.path === decodedPath);
    res.set('Content-Type', mat?.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${decodedPath.split('/').pop()}"`);
    res.send(buffer);
  });
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// In-memory session cache to avoid a DB hit on every 2s raffle poll
const sessionCache = new Map(); // token → { member, cachedAt }
const SESSION_CACHE_TTL = 5 * 60 * 1000;

async function requireMember(req, res, next) {
  const token = req.headers['x-member-token'];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  if (!supabase) return res.status(503).json({ error: 'DB not configured' });

  const cached = sessionCache.get(token);
  if (cached && Date.now() - cached.cachedAt < SESSION_CACHE_TTL) {
    req.member = cached.member;
    return next();
  }

  const { data: session } = await supabase
    .from('sessions')
    .select('token, expires_at, member:members(id, name, joined_at, avatar_color, is_active)')
    .eq('token', token)
    .single();

  if (!session || !session.member?.is_active || new Date(session.expires_at) < new Date()) {
    sessionCache.delete(token);
    return res.status(401).json({ error: 'Sesión expirada' });
  }

  sessionCache.set(token, { member: session.member, cachedAt: Date.now() });
  req.member = session.member;
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const AVATAR_COLORS = ['#d9a441', '#c9679a', '#f5c96b', '#8ec07c', '#d3869b', '#b28ae0', '#83a598', '#e07a5f'];

function validScore(score) {
  const n = Number(score);
  return Number.isFinite(n) && n >= 0 && n <= 10 && n * 2 === Math.floor(n * 2);
}

function avgRatings(ratings) {
  if (!ratings.length) return null;
  return Math.round((ratings.reduce((s, r) => s + Number(r.score), 0) / ratings.length) * 10) / 10;
}

// Suggestions eligible in the event's current voting round (runoff restricts to tied ones)
function currentRoundCandidates(event, suggestions) {
  if (!event.runoff_candidate_ids?.length) return suggestions;
  const allowed = new Set(event.runoff_candidate_ids.map(String));
  return suggestions.filter(s => allowed.has(String(s.id)));
}

// Guarded finalize shared by draw + close-vote: only wins if nobody finalized yet.
async function finalizeWinner(eventId, suggestion) {
  const { data: updated } = await supabase
    .from('events')
    .update({
      winning_suggestion_id: suggestion.id,
      winning_book_id: suggestion.book_id,
      drawn_at: new Date().toISOString(),
      status: 'raffled',
    })
    .eq('id', eventId)
    .is('winning_suggestion_id', null)
    .select();

  if (updated?.length) {
    await supabase.from('books').update({ status: 'picked' }).eq('id', suggestion.book_id);
    return { finalized: true, winning_suggestion_id: suggestion.id, winning_book_id: suggestion.book_id };
  }
  const { data: existing } = await supabase.from('events').select('winning_suggestion_id, winning_book_id').eq('id', eventId).single();
  return { finalized: false, ...existing };
}

// Winner payload { book, suggested_by } for a finalized suggestion
async function winnerPayload(suggestionId, bookId, suggestions) {
  const { data: book } = await supabase.from('books').select('id, title, author, cover_url').eq('id', bookId).single();
  const winSug = suggestions.find(s => String(s.id) === String(suggestionId));
  let suggested_by = null;
  if (winSug) {
    const { data: m } = await supabase.from('members').select('name').eq('id', winSug.member_id).single();
    suggested_by = m?.name || null;
  }
  return { book, suggested_by };
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC
// ══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'bookclub-api' }));

// Login picker — active member names only, nothing sensitive
app.get('/api/members', async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from('members')
    .select('id, name, avatar_color')
    .eq('is_active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/login', async (req, res) => {
  const { member_id, pin } = req.body;
  if (!member_id || !pin) return res.status(400).json({ error: 'Faltan datos' });
  if (!supabase) return res.status(503).json({ error: 'DB not configured' });

  const { data: member } = await supabase
    .from('members')
    .select('id, name, pin_hash, joined_at, avatar_color, is_active')
    .eq('id', member_id)
    .single();

  if (!member || !member.is_active || !verifyPin(pin, member.pin_hash)) {
    return res.status(401).json({ error: 'PIN incorrecto' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const expires_at = new Date(Date.now() + 90 * 86400000).toISOString();
  const { error } = await supabase.from('sessions').insert({ token, member_id: member.id, expires_at });
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    token,
    member: { id: member.id, name: member.name, joined_at: member.joined_at, avatar_color: member.avatar_color },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// MEMBER
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/logout', requireMember, async (req, res) => {
  const token = req.headers['x-member-token'];
  sessionCache.delete(token);
  await supabase.from('sessions').delete().eq('token', token);
  res.json({ success: true });
});

// Profile: membership, my books, my ratings + notes, stats
app.get('/api/me', requireMember, async (req, res) => {
  try {
    const memberId = req.member.id;
    const [ratingsQ, attendanceQ, suggestionsQ, eventsQ] = await Promise.all([
      supabase.from('ratings').select('book_id, score, note, updated_at').eq('member_id', memberId),
      supabase.from('attendance').select('event_id').eq('member_id', memberId),
      supabase.from('suggestions').select('id, event_id, book_id').eq('member_id', memberId),
      supabase.from('events').select('id, status, winning_suggestion_id, winning_book_id, event_at'),
    ]);

    const ratings = ratingsQ.data || [];
    const attendance = attendanceQ.data || [];
    const suggestions = suggestionsQ.data || [];
    const events = eventsQ.data || [];

    const completedEvents = events.filter(e => e.status === 'completed');
    const attendedCompleted = completedEvents.filter(e => attendance.some(a => a.event_id === e.id));
    const pickedCount = suggestions.filter(s => events.some(e => e.winning_suggestion_id === s.id)).length;

    // Books I've read = read books from events I attended, plus any book I rated
    const readBookIds = new Set(attendedCompleted.map(e => e.winning_book_id).filter(Boolean));
    for (const r of ratings) readBookIds.add(r.book_id);

    let books = [];
    if (readBookIds.size) {
      const { data } = await supabase
        .from('books')
        .select('id, title, author, year, cover_url, status, read_at')
        .in('id', [...readBookIds])
        .order('read_at', { ascending: false });
      books = (data || []).map(b => {
        const mine = ratings.find(r => r.book_id === b.id);
        return { ...b, my_score: mine ? Number(mine.score) : null, my_note: mine?.note || null };
      });
    }

    res.json({
      member: req.member,
      stats: {
        books_read: readBookIds.size,
        events_attended: attendedCompleted.length,
        suggestions: suggestions.length,
        picked: pickedCount,
      },
      books,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Events list — upcoming + past, with winning book info
app.get('/api/events', requireMember, async (req, res) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .neq('status', 'cancelled')
      .order('event_at', { ascending: false });
    if (error) throw error;

    // Two-step lookup for winning books (avoids ambiguous joins)
    const bookIds = [...new Set(events.map(e => e.winning_book_id).filter(Boolean))];
    let booksById = {};
    if (bookIds.length) {
      const { data: books } = await supabase.from('books').select('id, title, author, cover_url').in('id', bookIds);
      booksById = Object.fromEntries((books || []).map(b => [b.id, b]));
    }

    const now = Date.now();
    const enriched = events.map(e => ({ ...e, winning_book: booksById[e.winning_book_id] || null }));
    res.json({
      upcoming: enriched.filter(e => new Date(e.event_at).getTime() >= now).sort((a, b) => new Date(a.event_at) - new Date(b.event_at)),
      past: enriched.filter(e => new Date(e.event_at).getTime() < now),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Event detail
app.get('/api/events/:id', requireMember, async (req, res) => {
  try {
    const { data: event } = await supabase.from('events').select('*').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    const [suggestionsQ, attendanceQ, rsvpQ] = await Promise.all([
      supabase.from('suggestions').select('id, member_id, book_id').eq('event_id', event.id),
      supabase.from('attendance').select('member_id').eq('event_id', event.id),
      supabase.from('event_rsvp').select('member_id, going').eq('event_id', event.id),
    ]);
    const suggestions = suggestionsQ.data || [];

    let winning_book = null;
    if (event.winning_book_id) {
      const { data } = await supabase.from('books').select('id, title, author, year, cover_url, description').eq('id', event.winning_book_id).single();
      winning_book = data;
    }

    let suggested_by = null;
    if (event.winning_suggestion_id) {
      const winSug = suggestions.find(s => s.id === event.winning_suggestion_id);
      if (winSug) {
        const { data: m } = await supabase.from('members').select('name').eq('id', winSug.member_id).single();
        suggested_by = m?.name || null;
      }
    }

    // My suggestions (array, with book details for each)
    let my_suggestions = [];
    const mine = suggestions.filter(s => String(s.member_id) === String(req.member.id));
    if (mine.length) {
      const { data: myBooks } = await supabase.from('books')
        .select('id, title, author, year, cover_url').in('id', mine.map(s => s.book_id));
      const booksById = Object.fromEntries((myBooks || []).map(b => [b.id, b]));
      my_suggestions = mine.map(s => ({ suggestion_id: s.id, ...booksById[s.book_id] }));
    }

    // Locked: vote events lock suggestions once suggestions_deadline passes (fallback: once any vote exists)
    let locked = false;
    if (event.status === 'planned' && event.selection_method === 'vote') {
      if (event.suggestions_deadline) {
        locked = new Date(event.suggestions_deadline) < new Date();
      } else {
        const { data: voteCheck } = await supabase.from('votes').select('id').eq('event_id', event.id);
        locked = !!(voteCheck?.length);
      }
    }

    // Attendees (names) — only for completed events
    let attendees = [];
    if (event.status === 'completed' && attendanceQ.data?.length) {
      const { data: ms } = await supabase.from('members').select('name, avatar_color').in('id', attendanceQ.data.map(a => a.member_id));
      attendees = ms || [];
    }

    // RSVP — member's own intent + who's going
    const rsvps = rsvpQ.data || [];
    const myRsvpRow = rsvps.find(r => String(r.member_id) === String(req.member.id));
    const my_rsvp = myRsvpRow !== undefined ? myRsvpRow.going : null;
    const goingIds = rsvps.filter(r => r.going).map(r => r.member_id);
    let rsvp_going = [];
    if (goingIds.length) {
      const { data: goingMs } = await supabase.from('members').select('name, avatar_color').in('id', goingIds);
      rsvp_going = goingMs || [];
    }

    res.json({
      ...event,
      winning_book,
      suggested_by,
      my_suggestions,
      locked,
      suggestion_count: suggestions.length,
      attendees,
      my_rsvp,
      rsvp_going,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RSVP — member registers attendance intent (going: true / false)
app.put('/api/events/:id/rsvp', requireMember, async (req, res) => {
  const { going } = req.body;
  if (typeof going !== 'boolean') return res.status(400).json({ error: 'going (boolean) es requerido' });
  try {
    const { data: event } = await supabase.from('events').select('status').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (!['planned', 'raffled'].includes(event.status)) return res.status(400).json({ error: 'Solo puedes registrar asistencia para eventos futuros' });
    const { error } = await supabase.from('event_rsvp')
      .upsert({ event_id: req.params.id, member_id: req.member.id, going, updated_at: new Date().toISOString() }, { onConflict: 'event_id,member_id' });
    if (error) throw error;
    res.json({ success: true, going });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/events/:id/rsvp', requireMember, async (req, res) => {
  try {
    await supabase.from('event_rsvp').delete().eq('event_id', req.params.id).eq('member_id', req.member.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new suggestion — members can have multiple per event, locked once drawn or once votes exist
app.post('/api/events/:id/suggestion', requireMember, async (req, res) => {
  const { title, author, year, isbn, cover_url, description } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'El título es obligatorio' });

  try {
    const { data: event } = await supabase.from('events').select('id, status, drawn_at, selection_method').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.drawn_at || event.status !== 'planned') {
      return res.status(400).json({ error: 'La elección ya se celebró — no se pueden añadir propuestas' });
    }
    if (event.selection_method === 'vote') {
      if (event.suggestions_deadline && new Date(event.suggestions_deadline) < new Date()) {
        return res.status(400).json({ error: 'El plazo de propuestas ya cerró' });
      }
      if (!event.suggestions_deadline) {
        // legacy fallback: lock once any vote exists
        const { data: existingVotes } = await supabase.from('votes').select('id').eq('event_id', event.id);
        if (existingVotes?.length) {
          return res.status(400).json({ error: 'Ya hay votos — las propuestas están bloqueadas' });
        }
      }
    }

    const { data: book, error: bookErr } = await supabase
      .from('books')
      .insert({
        title: title.trim(),
        author: author || null,
        year: year ? parseInt(year) : null,
        isbn: isbn || null,
        cover_url: cover_url || null,
        description: description || null,
        status: 'suggested',
      })
      .select()
      .single();
    if (bookErr) throw bookErr;

    const { data: suggestion, error: sugErr } = await supabase
      .from('suggestions')
      .insert({ event_id: event.id, member_id: req.member.id, book_id: book.id })
      .select()
      .single();
    if (sugErr) throw sugErr;

    res.json({ success: true, suggestion, book });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove one of my suggestions (locked once drawn or once votes exist)
app.delete('/api/events/:id/suggestion/:suggestion_id', requireMember, async (req, res) => {
  try {
    const { data: event } = await supabase.from('events').select('id, status, drawn_at, selection_method').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.drawn_at || event.status !== 'planned') {
      return res.status(400).json({ error: 'La elección ya se celebró — no se pueden quitar propuestas' });
    }
    if (event.selection_method === 'vote') {
      const { data: existingVotes } = await supabase.from('votes').select('id').eq('event_id', event.id);
      if (existingVotes?.length) {
        return res.status(400).json({ error: 'Ya hay votos — las propuestas están bloqueadas' });
      }
    }

    const { data: suggestion } = await supabase.from('suggestions')
      .select('id, member_id').eq('id', req.params.suggestion_id).eq('event_id', req.params.id).single();
    if (!suggestion) return res.status(404).json({ error: 'Propuesta no encontrada' });
    if (String(suggestion.member_id) !== String(req.member.id)) {
      return res.status(403).json({ error: 'Solo puedes quitar tus propias propuestas' });
    }

    await supabase.from('suggestions').delete().eq('id', req.params.suggestion_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raffle polling endpoint — clients hit this every ~2s from rifa.html
app.get('/api/events/:id/raffle', requireMember, async (req, res) => {
  try {
    const { data: event } = await supabase
      .from('events')
      .select('id, status, drawn_at, winning_book_id, winning_suggestion_id, title, event_at, selection_method')
      .eq('id', req.params.id)
      .single();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    const { data: suggestions } = await supabase.from('suggestions').select('id, member_id').eq('event_id', event.id);
    const memberIds = [...new Set((suggestions || []).map(s => s.member_id))];
    let membersById = {};
    if (memberIds.length) {
      const { data: ms } = await supabase.from('members').select('id, name, avatar_color').in('id', memberIds);
      membersById = Object.fromEntries((ms || []).map(m => [m.id, m]));
    }

    // Pre-draw: names only — book titles stay secret until the reveal
    const entries = (suggestions || []).map(s => ({
      member_name: membersById[s.member_id]?.name || '???',
      color: membersById[s.member_id]?.avatar_color || '#d9a441',
    }));

    let winner = null;
    if (event.drawn_at && event.winning_book_id) {
      const { data: book } = await supabase.from('books').select('title, author, cover_url').eq('id', event.winning_book_id).single();
      const winSug = (suggestions || []).find(s => s.id === event.winning_suggestion_id);
      winner = {
        book,
        suggested_by: winSug ? (membersById[winSug.member_id]?.name || null) : null,
      };
    }

    res.json({
      state: event.drawn_at ? 'drawn' : 'open',
      selection_method: event.selection_method || 'raffle',
      event_title: event.title,
      suggestion_count: entries.length,
      entries,
      drawn_at: event.drawn_at,
      winner,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vote polling endpoint — clients hit this every ~3s from votacion.html.
// Voting is fully public: tallies AND voter names are visible live.
app.get('/api/events/:id/votes', requireMember, async (req, res) => {
  try {
    const { data: event } = await supabase.from('events').select('*').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.selection_method !== 'vote') {
      return res.status(400).json({ error: 'Este evento se decide por rifa', selection_method: event.selection_method || 'raffle' });
    }

    const { data: allSuggestions } = await supabase.from('suggestions').select('id, member_id, book_id').eq('event_id', event.id);
    const candidates = currentRoundCandidates(event, allSuggestions || []);

    const { data: votes } = await supabase.from('votes').select('member_id, suggestion_id').eq('event_id', event.id).eq('round', event.vote_round || 1);

    const memberIds = [...new Set([...(allSuggestions || []).map(s => s.member_id), ...(votes || []).map(v => v.member_id)])];
    let membersById = {};
    if (memberIds.length) {
      const { data: ms } = await supabase.from('members').select('id, name, avatar_color').in('id', memberIds);
      membersById = Object.fromEntries((ms || []).map(m => [m.id, m]));
    }

    const bookIds = candidates.map(s => s.book_id);
    let booksById = {};
    if (bookIds.length) {
      const { data: books } = await supabase.from('books').select('id, title, author, cover_url, description').in('id', bookIds);
      booksById = Object.fromEntries((books || []).map(b => [b.id, b]));
    }

    const candidatePayload = candidates.map(s => {
      const voters = (votes || []).filter(v => String(v.suggestion_id) === String(s.id)).map(v => ({
        name: membersById[v.member_id]?.name || '???',
        avatar_color: membersById[v.member_id]?.avatar_color || '#d9a441',
      }));
      return {
        suggestion_id: s.id,
        book: booksById[s.book_id] || null,
        suggested_by: membersById[s.member_id]?.name || '???',
        votes: voters.length,
        voters,
      };
    });

    const myVotes = (votes || [])
      .filter(v => String(v.member_id) === String(req.member.id))
      .map(v => v.suggestion_id);

    let winner = null;
    if (event.drawn_at && event.winning_book_id) {
      winner = await winnerPayload(event.winning_suggestion_id, event.winning_book_id, allSuggestions || []);
    }

    res.json({
      state: event.drawn_at ? 'decided' : 'open',
      selection_method: 'vote',
      event_title: event.title,
      theme: event.theme || null,
      round: event.vote_round || 1,
      suggestions_deadline: event.suggestions_deadline || null,
      voting_open: !event.suggestions_deadline || new Date(event.suggestions_deadline) <= new Date(),
      vote_deadline: event.vote_deadline || null,
      deadline_passed: !!(event.vote_deadline && new Date(event.vote_deadline) < new Date()),
      candidates: candidatePayload,
      my_votes: myVotes,
      total_votes: (votes || []).length,
      total_voters: new Set((votes || []).map(v => v.member_id)).size,
      drawn_at: event.drawn_at,
      winner,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle a vote — cast if not yet voted for this book, remove if already voted
app.put('/api/events/:id/vote', requireMember, async (req, res) => {
  const { suggestion_id } = req.body;
  if (!suggestion_id) return res.status(400).json({ error: 'Falta el libro elegido' });

  try {
    const { data: event } = await supabase.from('events').select('*').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.selection_method !== 'vote') return res.status(400).json({ error: 'Este evento se decide por rifa' });
    if (event.drawn_at) return res.status(400).json({ error: 'La votación ya terminó' });
    if (event.suggestions_deadline && new Date(event.suggestions_deadline) > new Date()) {
      return res.status(400).json({ error: 'La votación aún no ha abierto' });
    }
    if (event.vote_deadline && new Date(event.vote_deadline) < new Date()) {
      return res.status(400).json({ error: 'La votación cerró' });
    }

    const { data: suggestions } = await supabase.from('suggestions').select('id, member_id, book_id').eq('event_id', event.id);
    const candidates = currentRoundCandidates(event, suggestions || []);
    if (!candidates.some(s => String(s.id) === String(suggestion_id))) {
      return res.status(400).json({ error: 'Ese libro no está en esta ronda' });
    }

    const round = event.vote_round || 1;
    const { data: existing } = await supabase.from('votes')
      .select('id')
      .eq('event_id', event.id)
      .eq('member_id', req.member.id)
      .eq('suggestion_id', suggestion_id)
      .eq('round', round)
      .single();

    if (existing) {
      await supabase.from('votes').delete().eq('id', existing.id);
      return res.json({ success: true, voted: false });
    }

    const { data: vote, error } = await supabase
      .from('votes')
      .insert({ event_id: event.id, member_id: req.member.id, suggestion_id, round })
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, voted: true, vote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Books — reading + read, with average score and my rating
app.get('/api/books', requireMember, async (req, res) => {
  try {
    const { data: books, error } = await supabase
      .from('books')
      .select('id, title, author, year, isbn, cover_url, description, status, read_at, pdf_path')
      .in('status', ['reading', 'read'])
      .order('read_at', { ascending: false, nullsFirst: true });
    if (error) throw error;

    const bookIds = books.map(b => b.id);
    let ratings = [];
    if (bookIds.length) {
      const { data } = await supabase.from('ratings').select('book_id, member_id, score').in('book_id', bookIds);
      ratings = data || [];
    }

    res.json(books.map(b => {
      const bookRatings = ratings.filter(r => r.book_id === b.id);
      const mine = bookRatings.find(r => r.member_id === req.member.id);
      return {
        id: b.id, title: b.title, author: b.author, year: b.year,
        cover_url: b.cover_url, description: b.description,
        status: b.status, read_at: b.read_at,
        has_pdf: !!b.pdf_path,
        avg_score: avgRatings(bookRatings),
        rating_count: bookRatings.length,
        my_score: mine ? Number(mine.score) : null,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rate a book (0–10 in half-point steps) + private note
app.put('/api/books/:id/rating', requireMember, async (req, res) => {
  const { score, note } = req.body;
  if (!validScore(score)) return res.status(400).json({ error: 'La nota debe estar entre 0 y 10, en pasos de 0.5' });

  try {
    const { data, error } = await supabase
      .from('ratings')
      .upsert(
        { member_id: req.member.id, book_id: req.params.id, score: Number(score), note: note || null },
        { onConflict: 'member_id,book_id' }
      )
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, rating: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Signed URL for a book PDF (1 hour)
app.get('/api/books/:id/pdf-url', requireMember, async (req, res) => {
  try {
    const { data: book } = await supabase.from('books').select('pdf_path, title').eq('id', req.params.id).single();
    if (!book?.pdf_path) return res.status(404).json({ error: 'Este libro no tiene PDF' });

    const ext = book.pdf_path.endsWith('.epub') ? 'epub' : 'pdf';
    const { data, error } = await supabase.storage.from(PDF_BUCKET).createSignedUrl(book.pdf_path, 3600, {
      download: `${book.title}.${ext}`,
    });
    if (error) throw error;
    res.json({ url: data.signedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard — computed live (small club)
app.get('/api/leaderboard', requireMember, async (req, res) => {
  try {
    const [membersQ, attendanceQ, suggestionsQ, eventsQ] = await Promise.all([
      supabase.from('members').select('id, name, avatar_color, joined_at').eq('is_active', true),
      supabase.from('attendance').select('event_id, member_id'),
      supabase.from('suggestions').select('id, member_id'),
      supabase.from('events').select('id, status, winning_suggestion_id, winning_book_id'),
    ]);

    const members = membersQ.data || [];
    const attendance = attendanceQ.data || [];
    const suggestions = suggestionsQ.data || [];
    const events = eventsQ.data || [];

    const completedIds = new Set(events.filter(e => e.status === 'completed').map(e => e.id));
    const completedById = Object.fromEntries(events.filter(e => e.status === 'completed').map(e => [e.id, e]));
    const winningSugIds = new Set(events.map(e => e.winning_suggestion_id).filter(Boolean));

    const rows = members.map(m => {
      const attended = attendance.filter(a => a.member_id === m.id && completedIds.has(a.event_id));
      const readBooks = new Set(attended.map(a => completedById[a.event_id]?.winning_book_id).filter(Boolean));
      const mySugs = suggestions.filter(s => s.member_id === m.id);
      return {
        id: m.id, name: m.name, avatar_color: m.avatar_color, joined_at: m.joined_at,
        books_read: readBooks.size,
        events_attended: attended.length,
        suggestions: mySugs.length,
        picked: mySugs.filter(s => winningSugIds.has(s.id)).length,
      };
    });

    rows.sort((a, b) => (b.books_read - a.books_read) || (b.events_attended - a.events_attended) || (b.picked - a.picked) || a.name.localeCompare(b.name));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════

// ── Members ───────────────────────────────────────────────────────────────────

app.get('/api/admin/members', requireAdmin, async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from('members')
    .select('id, name, joined_at, is_active, avatar_color, created_at')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/admin/members', requireAdmin, async (req, res) => {
  const { name, pin, joined_at } = req.body;
  if (!name?.trim() || !pin) return res.status(400).json({ error: 'name and pin are required' });
  if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-6 digits' });

  const { data, error } = await supabase
    .from('members')
    .insert({
      name: name.trim(),
      pin_hash: hashPin(pin),
      joined_at: joined_at || new Date().toISOString().split('T')[0],
      is_active: true, // explicit — mockdb doesn't apply SQL column defaults
      avatar_color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    })
    .select('id, name, joined_at, is_active, avatar_color')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/members/:id', requireAdmin, async (req, res) => {
  const { name, pin, joined_at, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (joined_at !== undefined) updates.joined_at = joined_at;
  if (is_active !== undefined) updates.is_active = is_active;
  if (pin !== undefined) {
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    updates.pin_hash = hashPin(pin);
  }

  const { data, error } = await supabase
    .from('members')
    .update(updates)
    .eq('id', req.params.id)
    .select('id, name, joined_at, is_active, avatar_color')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  sessionCache.clear();
  res.json(data);
});

// Soft delete
app.delete('/api/admin/members/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('members').update({ is_active: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  sessionCache.clear();
  res.json({ success: true });
});

// ── Events ────────────────────────────────────────────────────────────────────

const EVENT_TRANSITIONS = {
  planned:   ['raffled', 'cancelled'],
  raffled:   ['completed', 'cancelled'],
  completed: [],
  cancelled: ['planned'],
};

app.get('/api/admin/events', requireAdmin, async (req, res) => {
  if (!supabase) return res.json([]);
  try {
    const { data: events, error } = await supabase.from('events').select('*').order('event_at', { ascending: false });
    if (error) throw error;

    const bookIds = [...new Set(events.map(e => e.winning_book_id).filter(Boolean))];
    let booksById = {};
    if (bookIds.length) {
      const { data: books } = await supabase.from('books').select('id, title, author, cover_url').in('id', bookIds);
      booksById = Object.fromEntries((books || []).map(b => [b.id, b]));
    }
    const { data: allSugs } = await supabase.from('suggestions').select('id, event_id');
    const { data: allAtt } = await supabase.from('attendance').select('event_id, member_id');

    res.json(events.map(e => ({
      ...e,
      winning_book: booksById[e.winning_book_id] || null,
      suggestion_count: (allSugs || []).filter(s => s.event_id === e.id).length,
      attendee_ids: (allAtt || []).filter(a => a.event_id === e.id).map(a => a.member_id),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/events', requireAdmin, async (req, res) => {
  const { title, description, location, event_at, raffle_at, selection_method, theme, suggestions_deadline, vote_deadline } = req.body;
  if (!title?.trim() || !event_at) return res.status(400).json({ error: 'title and event_at are required' });
  if (selection_method !== undefined && !['raffle', 'vote'].includes(selection_method)) {
    return res.status(400).json({ error: "selection_method must be 'raffle' or 'vote'" });
  }

  const { data, error } = await supabase
    .from('events')
    .insert({
      title: title.trim(),
      description: description || null,
      location: location || null,
      event_at,
      raffle_at: raffle_at || null,
      status: 'planned', // explicit — mockdb doesn't apply SQL column defaults
      selection_method: selection_method || 'raffle',
      theme: theme || null,
      suggestions_deadline: suggestions_deadline || null,
      vote_deadline: vote_deadline || null,
      vote_round: 1,
      runoff_candidate_ids: null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/events/:id', requireAdmin, async (req, res) => {
  const { title, description, location, event_at, raffle_at, status, selection_method, theme, suggestions_deadline, vote_deadline } = req.body;

  if (status || selection_method !== undefined) {
    const { data: current } = await supabase.from('events').select('status, drawn_at').eq('id', req.params.id).single();
    if (!current) return res.status(404).json({ error: 'Event not found' });
    if (status) {
      const allowed = EVENT_TRANSITIONS[current.status] || [];
      if (status !== current.status && !allowed.includes(status)) {
        return res.status(400).json({ error: `Invalid transition: ${current.status} → ${status}. Allowed: ${allowed.join(', ') || 'none'}` });
      }
    }
    if (selection_method !== undefined) {
      if (!['raffle', 'vote'].includes(selection_method)) {
        return res.status(400).json({ error: "selection_method must be 'raffle' or 'vote'" });
      }
      if (current.drawn_at) return res.status(400).json({ error: 'El libro ya se eligió — no se puede cambiar el método' });
    }
  }

  const updates = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (location !== undefined) updates.location = location;
  if (event_at !== undefined) updates.event_at = event_at;
  if (raffle_at !== undefined) updates.raffle_at = raffle_at;
  if (status !== undefined) updates.status = status;
  if (selection_method !== undefined) updates.selection_method = selection_method;
  if (theme !== undefined) updates.theme = theme || null;
  if (suggestions_deadline !== undefined) updates.suggestions_deadline = suggestions_deadline || null;
  if (vote_deadline !== undefined) updates.vote_deadline = vote_deadline || null;

  const { data, error } = await supabase.from('events').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/events/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── The raffle draw (idempotent) ──────────────────────────────────────────────

app.post('/api/admin/events/:id/draw', requireAdmin, async (req, res) => {
  try {
    const { data: event } = await supabase.from('events').select('*').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'cancelled') return res.status(409).json({ error: 'Event is cancelled' });
    if (event.selection_method === 'vote') return res.status(400).json({ error: 'Este evento se decide por votación' });

    const { data: suggestions } = await supabase.from('suggestions').select('id, member_id, book_id').eq('event_id', event.id);
    if (!suggestions?.length) return res.status(400).json({ error: 'No suggestions to draw from' });

    const candidate = suggestions[crypto.randomInt(suggestions.length)];
    const result = await finalizeWinner(event.id, candidate);
    const winner = await winnerPayload(result.winning_suggestion_id, result.winning_book_id, suggestions);

    res.json({ success: true, already_drawn: !result.finalized, winner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Close a vote (idempotent; ties open a runoff round) ──────────────────────

app.post('/api/admin/events/:id/close-vote', requireAdmin, async (req, res) => {
  try {
    const { data: event } = await supabase.from('events').select('*').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'cancelled') return res.status(409).json({ error: 'Event is cancelled' });
    if (event.selection_method !== 'vote') return res.status(400).json({ error: 'Este evento se decide por rifa' });

    const { data: suggestions } = await supabase.from('suggestions').select('id, member_id, book_id').eq('event_id', event.id);

    if (event.drawn_at) {
      const winner = await winnerPayload(event.winning_suggestion_id, event.winning_book_id, suggestions || []);
      return res.json({ success: true, already_closed: true, winner });
    }

    const round = event.vote_round || 1;
    const candidates = currentRoundCandidates(event, suggestions || []);
    const { data: votes } = await supabase.from('votes').select('suggestion_id').eq('event_id', event.id).eq('round', round);
    if (!votes?.length) return res.status(400).json({ error: 'No hay votos todavía' });

    const tally = new Map(candidates.map(s => [String(s.id), 0]));
    for (const v of votes) {
      const key = String(v.suggestion_id);
      if (tally.has(key)) tally.set(key, tally.get(key) + 1);
    }
    const max = Math.max(...tally.values());
    const leaders = candidates.filter(s => tally.get(String(s.id)) === max);

    if (leaders.length === 1) {
      const result = await finalizeWinner(event.id, leaders[0]);
      const winner = await winnerPayload(result.winning_suggestion_id, result.winning_book_id, suggestions || []);
      return res.json({ success: true, already_closed: !result.finalized, winner, round });
    }

    // Tie — open a runoff round restricted to the tied suggestions.
    // Guarded on vote_round so a double-click doesn't skip a round.
    const { data: bumped } = await supabase
      .from('events')
      .update({
        vote_round: round + 1,
        runoff_candidate_ids: leaders.map(s => s.id),
        vote_deadline: req.body?.new_deadline || null,
      })
      .eq('id', event.id)
      .eq('vote_round', round)
      .select();

    const { data: fresh } = await supabase.from('events').select('vote_round, runoff_candidate_ids').eq('id', event.id).single();
    const allowed = new Set((fresh?.runoff_candidate_ids || []).map(String));
    const bookIds = leaders.map(s => s.book_id);
    const { data: books } = await supabase.from('books').select('id, title').in('id', bookIds);
    const booksById = Object.fromEntries((books || []).map(b => [b.id, b]));

    res.json({
      success: true,
      runoff: true,
      already_advanced: !bumped?.length,
      round: fresh?.vote_round || round + 1,
      candidates: (suggestions || [])
        .filter(s => allowed.has(String(s.id)))
        .map(s => ({ suggestion_id: s.id, book_title: booksById[s.book_id]?.title || '???' })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete an event: book becomes "read"
app.post('/api/admin/events/:id/complete', requireAdmin, async (req, res) => {
  try {
    const { data: event } = await supabase.from('events').select('*').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.winning_book_id) return res.status(400).json({ error: 'Event has no winning book yet — draw first' });
    if (event.status === 'completed') return res.json({ success: true, already_completed: true });

    await supabase.from('events').update({ status: 'completed' }).eq('id', event.id);
    await supabase.from('books').update({
      status: 'read',
      read_at: String(event.event_at).split('T')[0],
    }).eq('id', event.winning_book_id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark the picked book as "reading" (between raffle and event)
app.post('/api/admin/events/:id/start-reading', requireAdmin, async (req, res) => {
  const { data: event } = await supabase.from('events').select('winning_book_id').eq('id', req.params.id).single();
  if (!event?.winning_book_id) return res.status(400).json({ error: 'No winning book' });
  const { error } = await supabase.from('books').update({ status: 'reading' }).eq('id', event.winning_book_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Attendance: replace the full set
app.put('/api/admin/events/:id/attendance', requireAdmin, async (req, res) => {
  const { member_ids } = req.body;
  if (!Array.isArray(member_ids)) return res.status(400).json({ error: 'member_ids array required' });

  try {
    await supabase.from('attendance').delete().eq('event_id', req.params.id);
    if (member_ids.length) {
      const rows = member_ids.map(mid => ({ event_id: req.params.id, member_id: mid }));
      const { error } = await supabase.from('attendance').insert(rows);
      if (error) throw error;
    }
    res.json({ success: true, count: member_ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suggestions for an event (admin sees titles before the draw; vote tally included)
app.get('/api/admin/events/:id/suggestions', requireAdmin, async (req, res) => {
  try {
    const { data: suggestions } = await supabase.from('suggestions').select('id, member_id, book_id, created_at').eq('event_id', req.params.id);
    if (!suggestions?.length) return res.json([]);

    const [booksQ, membersQ, eventQ] = await Promise.all([
      supabase.from('books').select('id, title, author, cover_url').in('id', suggestions.map(s => s.book_id)),
      supabase.from('members').select('id, name').in('id', suggestions.map(s => s.member_id)),
      supabase.from('events').select('vote_round, selection_method').eq('id', req.params.id).single(),
    ]);
    const booksById = Object.fromEntries((booksQ.data || []).map(b => [b.id, b]));
    const membersById = Object.fromEntries((membersQ.data || []).map(m => [m.id, m]));

    let votesBySug = {};
    if (eventQ.data?.selection_method === 'vote') {
      const { data: votes } = await supabase.from('votes').select('suggestion_id').eq('event_id', req.params.id).eq('round', eventQ.data.vote_round || 1);
      for (const v of votes || []) votesBySug[v.suggestion_id] = (votesBySug[v.suggestion_id] || 0) + 1;
    }

    res.json(suggestions.map(s => ({
      id: s.id,
      book: booksById[s.book_id] || null,
      member_name: membersById[s.member_id]?.name || '???',
      created_at: s.created_at,
      votes: votesBySug[s.id] || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Books ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/books', requireAdmin, async (req, res) => {
  if (!supabase) return res.json([]);
  try {
    const { data: books, error } = await supabase.from('books').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const { data: ratings } = await supabase.from('ratings').select('book_id, score');
    res.json(books.map(b => ({
      ...b,
      has_pdf: !!b.pdf_path,
      avg_score: avgRatings((ratings || []).filter(r => r.book_id === b.id)),
      rating_count: (ratings || []).filter(r => r.book_id === b.id).length,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/books', requireAdmin, async (req, res) => {
  const { title, author, year, isbn, cover_url, description, status, read_at } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

  const { data, error } = await supabase
    .from('books')
    .insert({
      title: title.trim(),
      author: author || null,
      year: year ? parseInt(year) : null,
      isbn: isbn || null,
      cover_url: cover_url || null,
      description: description || null,
      status: status || 'read',
      read_at: read_at || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/books/:id', requireAdmin, async (req, res) => {
  const allowed = ['title', 'author', 'year', 'isbn', 'cover_url', 'description', 'status', 'read_at'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

  const { data, error } = await supabase.from('books').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/books/:id', requireAdmin, async (req, res) => {
  const { data: book } = await supabase.from('books').select('pdf_path').eq('id', req.params.id).single();
  if (book?.pdf_path) await supabase.storage.from(PDF_BUCKET).remove([book.pdf_path]);
  const { error } = await supabase.from('books').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PDF upload (multipart, field name "file")
app.post('/api/admin/books/:id/pdf', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const ALLOWED = { 'application/pdf': 'pdf', 'application/epub+zip': 'epub' };
  if (!ALLOWED[req.file.mimetype]) return res.status(400).json({ error: 'Solo se permiten archivos PDF o EPUB' });

  try {
    const { data: book } = await supabase.from('books').select('id').eq('id', req.params.id).single();
    if (!book) return res.status(404).json({ error: 'Book not found' });

    const pdf_path = `books/${book.id}.${ALLOWED[req.file.mimetype]}`;
    const { error: upErr } = await supabase.storage.from(PDF_BUCKET).upload(pdf_path, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: true,
    });
    if (upErr) throw upErr;

    const { data, error } = await supabase
      .from('books')
      .update({ pdf_path, pdf_uploaded_at: new Date().toISOString() })
      .eq('id', book.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, book: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Photos ────────────────────────────────────────────────────────────────────

const PHOTO_ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MATERIAL_ALLOWED = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

// Upload photo — multipart field "file"; form fields: event_id?, caption?
app.post('/api/admin/photos', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const ext = PHOTO_ALLOWED[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Solo se permiten imágenes JPEG, PNG o WEBP' });
  try {
    const id = crypto.randomUUID();
    const path = `photos/${id}.${ext}`;
    const { error: upErr } = await supabase.storage.from(PDF_BUCKET).upload(path, req.file.buffer, {
      contentType: req.file.mimetype, upsert: false,
    });
    if (upErr) throw upErr;
    const { data, error } = await supabase.from('photos').insert({
      id, path,
      event_id: req.body.event_id || null,
      caption: req.body.caption?.trim() || null,
      uploaded_at: new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all photos for admin (includes signed URLs + event info)
app.get('/api/admin/photos', requireAdmin, async (req, res) => {
  try {
    const { data: photos, error } = await supabase.from('photos').select('*').order('uploaded_at', { ascending: false });
    if (error) throw error;
    const eventIds = [...new Set((photos || []).map(p => p.event_id).filter(Boolean))];
    let eventsById = {};
    if (eventIds.length) {
      const { data: evs } = await supabase.from('events').select('id, title, event_at').in('id', eventIds);
      eventsById = Object.fromEntries((evs || []).map(e => [e.id, e]));
    }
    const withUrls = await Promise.all((photos || []).map(async p => {
      const { data: signed } = await supabase.storage.from(PDF_BUCKET).createSignedUrl(p.path, 3600);
      return { ...p, url: signed?.signedUrl || null, event: eventsById[p.event_id] || null };
    }));
    res.json(withUrls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all photos (member — no URLs, gallery fetches them on demand)
app.get('/api/photos', requireMember, async (req, res) => {
  try {
    const { data: photos, error } = await supabase.from('photos').select('*').order('uploaded_at', { ascending: false });
    if (error) throw error;
    const eventIds = [...new Set((photos || []).map(p => p.event_id).filter(Boolean))];
    let eventsById = {};
    if (eventIds.length) {
      const { data: evs } = await supabase.from('events').select('id, title, event_at').in('id', eventIds);
      eventsById = Object.fromEntries((evs || []).map(e => [e.id, e]));
    }
    res.json((photos || []).map(p => ({ ...p, event: eventsById[p.event_id] || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Photos for a specific event — with signed URLs (member)
app.get('/api/events/:id/photos', requireMember, async (req, res) => {
  try {
    const { data: photos, error } = await supabase.from('photos').select('*').eq('event_id', req.params.id).order('uploaded_at', { ascending: true });
    if (error) throw error;
    const withUrls = await Promise.all((photos || []).map(async p => {
      const { data: signed } = await supabase.storage.from(PDF_BUCKET).createSignedUrl(p.path, 3600);
      return { ...p, url: signed?.signedUrl || null };
    }));
    res.json(withUrls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Signed URL for a single photo (member, gallery lazy-load)
app.get('/api/photos/:id/url', requireMember, async (req, res) => {
  try {
    const { data: photo } = await supabase.from('photos').select('path').eq('id', req.params.id).single();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const { data, error } = await supabase.storage.from(PDF_BUCKET).createSignedUrl(photo.path, 3600);
    if (error) throw error;
    res.json({ url: data.signedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete photo + remove from storage (admin)
app.delete('/api/admin/photos/:id', requireAdmin, async (req, res) => {
  try {
    const { data: photo } = await supabase.from('photos').select('path').eq('id', req.params.id).single();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    await supabase.storage.from(PDF_BUCKET).remove([photo.path]);
    const { error } = await supabase.from('photos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Event materials ───────────────────────────────────────────────────────────

app.post('/api/admin/events/:id/materials', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const ext = MATERIAL_ALLOWED[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Tipo no permitido. Usa PDF, EPUB o PPTX.' });
  try {
    const { data: event } = await supabase.from('events').select('id').eq('id', req.params.id).single();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const id = crypto.randomUUID();
    const path = `materials/${req.params.id}/${id}.${ext}`;
    const rawTitle = req.body.title?.trim();
    const title = rawTitle || (req.file.originalname?.replace(/\.[^.]+$/, '') || 'Material');
    const { error: upErr } = await supabase.storage.from(PDF_BUCKET).upload(path, req.file.buffer, {
      contentType: req.file.mimetype, upsert: false,
    });
    if (upErr) throw upErr;
    const { data, error } = await supabase.from('event_materials').insert({
      id, event_id: req.params.id, title, path, mime_type: req.file.mimetype,
      uploaded_at: new Date().toISOString(),
    }).select().single();
    if (error) {
      await supabase.storage.from(PDF_BUCKET).remove([path]);
      throw error;
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/events/:id/materials', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('event_materials').select('*')
      .eq('event_id', req.params.id).order('uploaded_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/:id/materials', requireMember, async (req, res) => {
  try {
    const { data: materials, error } = await supabase.from('event_materials').select('*')
      .eq('event_id', req.params.id).order('uploaded_at', { ascending: true });
    if (error) throw error;
    const withUrls = await Promise.all((materials || []).map(async m => {
      const ext = m.path.endsWith('.pptx') ? 'pptx' : m.path.endsWith('.epub') ? 'epub' : 'pdf';
      const { data: signed } = await supabase.storage.from(PDF_BUCKET)
        .createSignedUrl(m.path, 3600, { download: `${m.title}.${ext}` });
      return { ...m, url: signed?.signedUrl || null };
    }));
    res.json(withUrls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/events/:id/materials/:materialId', requireAdmin, async (req, res) => {
  try {
    const { data: mat } = await supabase.from('event_materials').select('path')
      .eq('id', req.params.materialId).eq('event_id', req.params.id).single();
    if (!mat) return res.status(404).json({ error: 'Material not found' });
    await supabase.storage.from(PDF_BUCKET).remove([mat.path]);
    const { error } = await supabase.from('event_materials').delete().eq('id', req.params.materialId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  if (!supabase) return res.json({ members: 0, books_read: 0, events_upcoming: 0, events_completed: 0, suggestions: 0, ratings: 0 });
  try {
    const [members, booksRead, evUp, evDone, sugs, rats] = await Promise.all([
      supabase.from('members').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('books').select('id', { count: 'exact', head: true }).eq('status', 'read'),
      supabase.from('events').select('id', { count: 'exact', head: true }).eq('status', 'planned'),
      supabase.from('events').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
      supabase.from('suggestions').select('id', { count: 'exact', head: true }),
      supabase.from('ratings').select('id', { count: 'exact', head: true }),
    ]);
    res.json({
      members: members.count || 0,
      books_read: booksRead.count || 0,
      events_upcoming: evUp.count || 0,
      events_completed: evDone.count || 0,
      suggestions: sugs.count || 0,
      ratings: rats.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Entre bicis y libros API`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health\n`);
});
