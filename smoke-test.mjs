// End-to-end API smoke test. Run: node smoke-test.mjs  (api.mjs must be running)
const BASE = 'http://localhost:3001';
const ADMIN = { 'x-admin-token': 'club_lectura.2026', 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const j = (r) => r.json();

// ── Login ──
const members = await fetch(`${BASE}/api/members`).then(j);
check('members picker returns 6', members.length === 6);

const paola = members.find(m => m.name === 'Paola');
const diego = members.find(m => m.name === 'Diego');

const badLogin = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: paola.id, pin: '9999' }) });
check('wrong PIN → 401', badLogin.status === 401);

const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: paola.id, pin: '1234' }) }).then(j);
check('login returns token', !!login.token);
const H = { 'x-member-token': login.token, 'Content-Type': 'application/json' };

const login2 = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: diego.id, pin: '1234' }) }).then(j);
const H2 = { 'x-member-token': login2.token, 'Content-Type': 'application/json' };

// ── Profile ──
const me = await fetch(`${BASE}/api/me`, { headers: H }).then(j);
check('me: member name', me.member?.name === 'Paola');
check('me: has read books', me.books?.length >= 6, `got ${me.books?.length}`);
check('me: stats present', me.stats?.events_attended === 6, `got ${JSON.stringify(me.stats)}`);

// ── Events ──
const events = await fetch(`${BASE}/api/events`, { headers: H }).then(j);
check('events: upcoming ≥ 2', events.upcoming?.length >= 2, `got ${events.upcoming?.length}`);
check('events: past = 7', events.past?.length === 7, `got ${events.past?.length}`);
const nextEvent = events.upcoming.find(e => e.status === 'planned');
check('planned upcoming event exists', !!nextEvent);

const detail = await fetch(`${BASE}/api/events/${nextEvent.id}`, { headers: H }).then(j);
check('event detail: suggestion_count = 3', detail.suggestion_count === 3, `got ${detail.suggestion_count}`);
check('event detail: my_suggestions empty (Paola)', detail.my_suggestions?.length === 0, `got ${detail.my_suggestions?.length}`);

// ── Suggestions: add multiple, delete, count tracks correctly ──
const sug1 = await fetch(`${BASE}/api/events/${nextEvent.id}/suggestion`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Paradais', author: 'Fernanda Melchor', year: 2021 }) }).then(j);
check('suggestion 1 created', sug1.success === true);
const sug2 = await fetch(`${BASE}/api/events/${nextEvent.id}/suggestion`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Temporada de huracanes', author: 'Fernanda Melchor', year: 2017 }) }).then(j);
check('suggestion 2 created (multi allowed)', sug2.success === true);
const detail2 = await fetch(`${BASE}/api/events/${nextEvent.id}`, { headers: H }).then(j);
check('two adds increment count (count 5)', detail2.suggestion_count === 5, `got ${detail2.suggestion_count}`);
check('my_suggestions has 2 entries', detail2.my_suggestions?.length === 2, `got ${detail2.my_suggestions?.length}`);
const delSug = await fetch(`${BASE}/api/events/${nextEvent.id}/suggestion/${sug1.suggestion.id}`, { method: 'DELETE', headers: H });
check('delete suggestion → 200', delSug.status === 200);
const detail3 = await fetch(`${BASE}/api/events/${nextEvent.id}`, { headers: H }).then(j);
check('count decrements after delete (count 4)', detail3.suggestion_count === 4, `got ${detail3.suggestion_count}`);

// ── Raffle poll (pre-draw) ──
const raffle1 = await fetch(`${BASE}/api/events/${nextEvent.id}/raffle`, { headers: H2 }).then(j);
check('raffle poll: state open', raffle1.state === 'open');
check('raffle poll: entries have names, no titles', raffle1.entries?.length === 4 && !JSON.stringify(raffle1.entries).includes('Temporada'));

// ── Draw: idempotent ──
const draw1 = await fetch(`${BASE}/api/admin/events/${nextEvent.id}/draw`, { method: 'POST', headers: ADMIN }).then(j);
check('draw 1 succeeds', draw1.success === true && !!draw1.winner?.book?.title);
const draw2 = await fetch(`${BASE}/api/admin/events/${nextEvent.id}/draw`, { method: 'POST', headers: ADMIN }).then(j);
check('draw 2 idempotent (same winner)', draw2.already_drawn === true && draw2.winner.book.title === draw1.winner.book.title);

const lateSug = await fetch(`${BASE}/api/events/${nextEvent.id}/suggestion`, { method: 'POST', headers: H2, body: JSON.stringify({ title: 'Tarde' }) });
check('suggestion after draw → 400', lateSug.status === 400);

const raffle2 = await fetch(`${BASE}/api/events/${nextEvent.id}/raffle`, { headers: H2 }).then(j);
check('raffle poll: drawn with winner', raffle2.state === 'drawn' && raffle2.winner?.book?.title === draw1.winner.book.title);
check('raffle poll: suggested_by present', !!raffle2.winner?.suggested_by);

// ── Complete event → book read ──
const complete = await fetch(`${BASE}/api/admin/events/${nextEvent.id}/complete`, { method: 'POST', headers: ADMIN }).then(j);
check('complete event', complete.success === true);
const books = await fetch(`${BASE}/api/books`, { headers: H }).then(j);
const wonBook = books.find(b => b.title === draw1.winner.book.title);
check('winning book now read', wonBook?.status === 'read');

// ── Ratings: upsert, validation ──
const badScore = await fetch(`${BASE}/api/books/${wonBook.id}/rating`, { method: 'PUT', headers: H, body: JSON.stringify({ score: 7.3 }) });
check('invalid score 7.3 → 400', badScore.status === 400);
const r1 = await fetch(`${BASE}/api/books/${wonBook.id}/rating`, { method: 'PUT', headers: H, body: JSON.stringify({ score: 8.5, note: 'primera nota' }) }).then(j);
check('rating 8.5 saved', r1.success === true);
const r2 = await fetch(`${BASE}/api/books/${wonBook.id}/rating`, { method: 'PUT', headers: H, body: JSON.stringify({ score: 9, note: 'nota final' }) }).then(j);
check('rating upsert to 9', r2.success === true);
const books2 = await fetch(`${BASE}/api/books`, { headers: H }).then(j);
const wonBook2 = books2.find(b => b.id === wonBook.id);
check('avg reflects single rating 9 (no dup)', wonBook2.my_score === 9 && wonBook2.rating_count === 1, `got ${wonBook2.my_score}/${wonBook2.rating_count}`);

// ── Books list ──
check('books list has avg scores', books2.filter(b => b.avg_score !== null).length >= 6);

// ── Leaderboard ──
const lb = await fetch(`${BASE}/api/leaderboard`, { headers: H }).then(j);
check('leaderboard: 6 members', lb.length === 6);
check('leaderboard: has picked stat', lb.some(r => r.picked > 0));

// ── PDF upload + signed URL ──
const fakePdf = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
const fd = new FormData();
fd.append('file', fakePdf, 'test.pdf');
const up = await fetch(`${BASE}/api/admin/books/${wonBook.id}/pdf`, { method: 'POST', headers: { 'x-admin-token': 'club_lectura.2026' }, body: fd }).then(j);
check('PDF upload', up.success === true);
const pdfUrl = await fetch(`${BASE}/api/books/${wonBook.id}/pdf-url`, { headers: H }).then(j);
check('signed URL returned', !!pdfUrl.url);
const dl = await fetch(pdfUrl.url.startsWith('http') ? pdfUrl.url : `${BASE}${pdfUrl.url}`);
check('PDF downloads', dl.status === 200);

// ── Admin auth ──
const noAuth = await fetch(`${BASE}/api/admin/members`);
check('admin without token → 401', noAuth.status === 401);
const noMember = await fetch(`${BASE}/api/me`);
check('member route without token → 401', noMember.status === 401);

// ── Admin stats ──
const stats = await fetch(`${BASE}/api/admin/stats`, { headers: ADMIN }).then(j);
check('admin stats', stats.members === 6 && stats.books_read >= 7, JSON.stringify(stats));

// ══ Voting module ══════════════════════════════════════════════════════════
// Seeded state: November vote event, 3 candidates, Luz already voted for
// Carolina's suggestion (candidate A).

const caro = members.find(m => m.name === 'Carolina');
const loginC = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: caro.id, pin: '1234' }) }).then(j);
const H3 = { 'x-member-token': loginC.token, 'Content-Type': 'application/json' };

const events2 = await fetch(`${BASE}/api/events`, { headers: H }).then(j);
const voteEvent = events2.upcoming.find(e => e.selection_method === 'vote');
check('vote event exists in upcoming', !!voteEvent && voteEvent.theme === 'Mujeres que escriben');

// ── Poll shape: public voters, live tally ──
const poll1 = await fetch(`${BASE}/api/events/${voteEvent.id}/votes`, { headers: H }).then(j);
check('vote poll: open, 3 candidates, round 1', poll1.state === 'open' && poll1.candidates?.length === 3 && poll1.round === 1);
check('vote poll: seeded vote visible with name', poll1.total_votes === 1 && JSON.stringify(poll1.candidates).includes('Luz'));
const candA = poll1.candidates.find(c => c.votes === 1);            // Carolina's (Luz voted it)
const candB = poll1.candidates.find(c => c.suggested_by === 'Mateo');
const candC = poll1.candidates.find(c => c.suggestion_id !== candA.suggestion_id && c.suggestion_id !== candB.suggestion_id);

// ── Guards ──
const bogusVote = await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H, body: JSON.stringify({ suggestion_id: 'no-existe' }) });
check('vote for foreign suggestion → 400', bogusVote.status === 400);
const voteOnRaffle = await fetch(`${BASE}/api/events/${nextEvent.id}/vote`, { method: 'PUT', headers: H, body: JSON.stringify({ suggestion_id: candA.suggestion_id }) });
check('vote on raffle event → 400', voteOnRaffle.status === 400);
const drawOnVote = await fetch(`${BASE}/api/admin/events/${voteEvent.id}/draw`, { method: 'POST', headers: ADMIN });
check('draw on vote event → 400', drawOnVote.status === 400);

// Open voting by setting suggestions_deadline to past
await fetch(`${BASE}/api/admin/events/${voteEvent.id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ suggestions_deadline: '2026-01-01T00:00:00Z' }) });

// ── Happy path: multi-vote (A and B), toggle off B ──
const v1 = await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H, body: JSON.stringify({ suggestion_id: candB.suggestion_id }) }).then(j);
check('Paola votes B', v1.success === true && v1.voted === true, JSON.stringify(v1));
const v2 = await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H, body: JSON.stringify({ suggestion_id: candA.suggestion_id }) }).then(j);
check('Paola also votes A (multi-vote)', v2.success === true && v2.voted === true, JSON.stringify(v2));
const poll2 = await fetch(`${BASE}/api/events/${voteEvent.id}/votes`, { headers: H }).then(j);
const poll2A = poll2.candidates.find(c => c.suggestion_id === candA.suggestion_id);
check('multi-vote: total 3, A=2', poll2.total_votes === 3 && poll2A.votes === 2, `got total ${poll2.total_votes}, A ${poll2A?.votes}`);
check('my_votes includes both A and B', poll2.my_votes?.includes(candA.suggestion_id) && poll2.my_votes?.includes(candB.suggestion_id), JSON.stringify(poll2.my_votes));

const v3 = await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H, body: JSON.stringify({ suggestion_id: candB.suggestion_id }) }).then(j);
check('Paola un-votes B (toggle off)', v3.success === true && v3.voted === false, JSON.stringify(v3));
const poll2b = await fetch(`${BASE}/api/events/${voteEvent.id}/votes`, { headers: H }).then(j);
const poll2bB = poll2b.candidates.find(c => c.suggestion_id === candB.suggestion_id);
check('toggle off: total back to 2, B=0', poll2b.total_votes === 2 && poll2bB.votes === 0, `total ${poll2b.total_votes}, B ${poll2bB?.votes}`);

// ── Suggestion lock: suggestions_deadline passed ──
const lockedSug = await fetch(`${BASE}/api/events/${voteEvent.id}/suggestion`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Propuesta tardía' }) });
check('suggestion locked after suggestions_deadline → 400', lockedSug.status === 400);

// ── Deadline blocks members (not admin) ──
await fetch(`${BASE}/api/admin/events/${voteEvent.id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ vote_deadline: '2026-01-01T00:00:00Z' }) });
const lateVote = await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H2, body: JSON.stringify({ suggestion_id: candB.suggestion_id }) });
check('vote after deadline → 400', lateVote.status === 400);
await fetch(`${BASE}/api/admin/events/${voteEvent.id}`, { method: 'PATCH', headers: ADMIN, body: JSON.stringify({ vote_deadline: '2027-01-01T00:00:00Z' }) });

// ── Engineer a 2–2 tie → runoff ──
await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H2, body: JSON.stringify({ suggestion_id: candB.suggestion_id }) });
await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H3, body: JSON.stringify({ suggestion_id: candB.suggestion_id }) });
const close1 = await fetch(`${BASE}/api/admin/events/${voteEvent.id}/close-vote`, { method: 'POST', headers: ADMIN }).then(j);
check('tie opens runoff round 2', close1.runoff === true && close1.round === 2 && close1.candidates?.length === 2, JSON.stringify(close1));

const poll3 = await fetch(`${BASE}/api/events/${voteEvent.id}/votes`, { headers: H }).then(j);
check('runoff poll: 2 candidates, fresh count', poll3.round === 2 && poll3.candidates.length === 2 && poll3.total_votes === 0);
const outsider = await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H, body: JSON.stringify({ suggestion_id: candC.suggestion_id }) });
check('runoff rejects non-finalist → 400', outsider.status === 400);

// ── Round 2 majority → winner ──
await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H, body: JSON.stringify({ suggestion_id: candA.suggestion_id }) });
await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H2, body: JSON.stringify({ suggestion_id: candA.suggestion_id }) });
const close2 = await fetch(`${BASE}/api/admin/events/${voteEvent.id}/close-vote`, { method: 'POST', headers: ADMIN }).then(j);
check('round 2 close → winner is A', close2.success === true && close2.winner?.book?.title === candA.book.title, JSON.stringify(close2.winner));
const close3 = await fetch(`${BASE}/api/admin/events/${voteEvent.id}/close-vote`, { method: 'POST', headers: ADMIN }).then(j);
check('second close idempotent', close3.already_closed === true && close3.winner?.book?.title === candA.book.title);

// ── Post-decision state ──
const postVote = await fetch(`${BASE}/api/events/${voteEvent.id}/vote`, { method: 'PUT', headers: H3, body: JSON.stringify({ suggestion_id: candA.suggestion_id }) });
check('vote after decision → 400', postVote.status === 400);
const poll4 = await fetch(`${BASE}/api/events/${voteEvent.id}/votes`, { headers: H }).then(j);
check('poll decided with winner', poll4.state === 'decided' && poll4.winner?.book?.title === candA.book.title);
const adminEvents = await fetch(`${BASE}/api/admin/events`, { headers: ADMIN }).then(j);
const votedEvent = adminEvents.find(e => e.id === voteEvent.id);
const adminBooks = await fetch(`${BASE}/api/admin/books`, { headers: ADMIN }).then(j);
const pickedBook = adminBooks.find(b => b.id === votedEvent.winning_book_id);
check('event raffled + book picked', votedEvent.status === 'raffled' && pickedBook?.status === 'picked');
const adminSugs = await fetch(`${BASE}/api/admin/events/${voteEvent.id}/suggestions`, { headers: ADMIN }).then(j);
check('admin suggestions include vote tally', adminSugs.some(s => s.votes === 2), JSON.stringify(adminSugs.map(s => s.votes)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
