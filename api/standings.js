// api/standings.js
// Returns each team's league position for one competition, e.g. /api/standings?competition=2021
// Used by the "Who wins?" read to weigh long-term quality (the table) alongside
// recent form. Cached per competition (tables move slowly) to spare the rate limit.

const cache = {}; // { competitionId: { at, data } }
const CACHE_MINUTES = 120;

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });

  const id = req.query.competition;
  if (!id) return res.status(400).json({ error: 'Missing competition.' });

  const c = cache[id];
  if (c && Date.now() - c.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(c.data);
  }

  try {
    const r = await fetch(`https://api.football-data.org/v4/competitions/${id}/standings`, {
      headers: { 'X-Auth-Token': key },
    });
    if (!r.ok) { return res.status(200).json({ positions: {}, total: 0 }); } // graceful: no table
    const j = await r.json();

    const positions = {};
    let total = 0;
    (j.standings || []).forEach(block => {
      if (block.type !== 'TOTAL') return;
      const table = block.table || [];
      total = Math.max(total, table.length);          // largest table = league size
      table.forEach(row => { if (row.team?.id) positions[row.team.id] = row.position; });
    });

    const data = { positions, total };
    cache[id] = { at: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(200).json({ positions: {}, total: 0 });
  }
}
