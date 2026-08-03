// api/h2h.js
// Head-to-head history for a fixture: /api/h2h?match=<fixtureId>
// football-data.org exposes this tied to a specific match id (v4/matches/{id}/head2head),
// covering past meetings across ANY competition, not just the 12 free ones — a nice bonus.
// Cached hard per fixture since head-to-head history barely changes day to day.

const cache = {}; // { matchId: { at, data } }
const CACHE_MINUTES = 1440; // 24h

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });

  const matchId = req.query.match;
  if (!matchId) return res.status(400).json({ error: 'Missing match id.' });

  const c = cache[matchId];
  if (c && Date.now() - c.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(c.data);
  }

  try {
    const r = await fetch(`https://api.football-data.org/v4/matches/${matchId}/head2head?limit=10`, {
      headers: { 'X-Auth-Token': key },
    });
    if (!r.ok) {
      const detail = r.status === 429 ? 'Rate limit hit.' : `API returned ${r.status}.`;
      return res.status(r.status).json({ error: detail });
    }
    const j = await r.json();
    const matches = (j.matches || [])
      .filter(m => m.score?.fullTime?.home != null)
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .map(m => ({
        date: m.utcDate,
        home: m.homeTeam?.shortName || m.homeTeam?.name || 'Home',
        away: m.awayTeam?.shortName || m.awayTeam?.name || 'Away',
        hg: m.score.fullTime.home,
        ag: m.score.fullTime.away,
        competition: m.competition?.name || '',
      }));

    // Tally the record ourselves from the match list — the API's own aggregate
    // field names weren't reliable, and this way the numbers are guaranteed to
    // match the games listed right below them. Keyed by team name (a team can be
    // home in one past meeting and away in another).
    const record = {};
    let draws = 0;
    matches.forEach(m => {
      record[m.home] = record[m.home] || 0;
      record[m.away] = record[m.away] || 0;
      if (m.hg > m.ag) record[m.home]++;
      else if (m.ag > m.hg) record[m.away]++;
      else draws++;
    });

    const data = {
      total: matches.length,
      record, // { 'Team name': wins }
      draws,
      matches,
      empty: matches.length === 0,
    };
    cache[matchId] = { at: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the football data service.' });
  }
}
