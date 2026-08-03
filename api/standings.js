// api/standings.js
// Returns each team's league position (used by the "Who wins?" read) AND the
// full table rows (used by the League Tables section), for one competition:
// /api/standings?competition=2021
// Competitions with multiple groups (e.g. a World Cup group stage) come back
// as separate groups rather than merged into one misleading combined table.
// Cached per competition (tables move slowly) to spare the rate limit.

const cache = {}; // { competitionId: { at, data } }
const CACHE_MINUTES = 240;

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
    if (!r.ok) { return res.status(200).json({ positions: {}, total: 0, groups: [] }); } // graceful: no table

    const j = await r.json();
    const positions = {};
    const positionsByName = {};
    let total = 0;
    const groups = [];

    (j.standings || []).forEach(block => {
      if (block.type !== 'TOTAL') return;
      const table = block.table || [];
      total = Math.max(total, table.length); // largest single table = league size
      const rows = table.map(row => {
        const name = row.team?.shortName || row.team?.name || 'Team';
        if (row.team?.id) positions[row.team.id] = row.position;
        positionsByName[name] = row.position;
        return {
          position: row.position,
          team: name,
          crest: row.team?.crest || '',
          played: row.playedGames || 0,
          won: row.won || 0,
          draw: row.draw || 0,
          lost: row.lost || 0,
          gf: row.goalsFor || 0,
          ga: row.goalsAgainst || 0,
          gd: row.goalDifference ?? ((row.goalsFor || 0) - (row.goalsAgainst || 0)),
          points: row.points || 0,
        };
      });
      groups.push({ name: block.group || null, rows }); // group stages get separate tables
    });

    const data = { positions, positionsByName, total, groups };
    cache[id] = { at: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(200).json({ positions: {}, total: 0, groups: [] });
  }
}
