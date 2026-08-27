// api/settle.js
// Given a small list of football-data match ids (?ids=123,456), returns each
// match's status and score — nothing else. Grading a bet against that score
// happens client-side (see MARKET_TESTS in index.html), so this endpoint stays
// simple and reusable rather than knowing anything about bets or markets.
//
// Only ever called with a handful of specific fixture ids a user has pending
// bets on — never a bulk scan — and only when they open their Account tab, so
// this naturally stays well inside the free tier's 10 req/min cap. Still capped
// and spaced defensively below in case someone ends up with a lot of pending bets.

const REQUEST_GAP_MS = 400; // same spacing used in insights.js to avoid 429s
const MAX_IDS = 10;         // hard ceiling per call, regardless of what's asked for
const cache = {};           // { matchId: { at, data } } — a finished match never changes
const CACHE_MINUTES = 1440; // 24h; a still-in-progress match is never cached (see below)

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });

  const raw = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const ids = [...new Set(raw)].slice(0, MAX_IDS);
  if (!ids.length) return res.status(400).json({ error: 'Missing ids.' });

  const out = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const c = cache[id];
    if (c && Date.now() - c.at < CACHE_MINUTES * 60 * 1000) { out[id] = c.data; continue; }

    if (i > 0) await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
    try {
      const r = await fetch(`https://api.football-data.org/v4/matches/${id}`, {
        headers: { 'X-Auth-Token': key },
      });
      if (!r.ok) { out[id] = { status: 'ERROR' }; continue; }
      const j = await r.json();
      const status = j.status || 'UNKNOWN';
      const entry = {
        status,
        hg: j.score?.fullTime?.home ?? null,
        ag: j.score?.fullTime?.away ?? null,
        htHg: j.score?.halfTime?.home ?? null,
        htAg: j.score?.halfTime?.away ?? null,
      };
      out[id] = entry;
      // only cache genuinely settled outcomes — an in-play or scheduled match's
      // status will change, so caching it would freeze a stale answer
      if (['FINISHED', 'AWARDED', 'POSTPONED', 'CANCELLED', 'SUSPENDED'].includes(status)) {
        cache[id] = { at: Date.now(), data: entry };
      }
    } catch (e) {
      out[id] = { status: 'ERROR' };
    }
  }

  res.status(200).json(out);
}
