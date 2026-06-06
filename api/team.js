// api/team.js
// Returns one team's last 10 finished matches, simplified to the shape the
// front-end understands: { gf, ga, venue, htGf, htGa, opponent }.
// Called as /api/team?id=57.  You never need to edit this file.

const cache = {}; // { teamId: { at, data } }
const CACHE_MINUTES = 30;

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing team id.' });

  const c = cache[id];
  if (c && Date.now() - c.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(c.data);
  }

  try {
    // last 10 finished games gives steadier rates and a home/away split
    const url = `https://api.football-data.org/v4/teams/${id}/matches?status=FINISHED&limit=10`;
    const r = await fetch(url, { headers: { 'X-Auth-Token': key } });
    if (!r.ok) {
      const detail = r.status === 429 ? 'Rate limit hit — wait a minute.' : `API returned ${r.status}.`;
      return res.status(r.status).json({ error: detail });
    }

    const json = await r.json();
    const matches = (json.matches || [])
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, 10)
      .map(m => {
        const isHome = m.homeTeam?.id === Number(id);
        const ft = m.score?.fullTime || {};
        const ht = m.score?.halfTime || {};
        return {
          gf: (isHome ? ft.home : ft.away) ?? 0,
          ga: (isHome ? ft.away : ft.home) ?? 0,
          htGf: ht.home == null ? null : (isHome ? ht.home : ht.away),
          htGa: ht.home == null ? null : (isHome ? ht.away : ht.home),
          venue: isHome ? 'H' : 'A',
          opponent: isHome ? (m.awayTeam?.shortName || m.awayTeam?.name) : (m.homeTeam?.shortName || m.homeTeam?.name),
        };
      });

    const data = { results: matches };
    cache[id] = { at: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the football data service.' });
  }
}
