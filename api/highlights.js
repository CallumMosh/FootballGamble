// api/highlights.js
// "Today's best angles" from league STANDINGS (one cheap call per competition).
// Only in-season competitions are used — off-season tables are last season's
// (stale) and are skipped automatically via the season dates in the response.
// Visit /api/highlights?debug=1 to see, per competition, why it's in or out.
const COMPETITIONS = {
  2021: 'Premier League', 2014: 'La Liga', 2019: 'Serie A',
  2002: 'Bundesliga', 2015: 'Ligue 1', 2000: 'World Cup', 2013: 'Brasileirão',
};

let cache = { at: 0, data: null, ttl: 0 };
const CACHE_MINUTES = 120;
const EMPTY_MINUTES = 5;   // don't lock in a transient "no data" result
const per = (n, g) => g > 0 ? +(n / g).toFixed(2) : 0;
const winsInForm = f => (String(f || '').match(/W/g) || []).length;

function inSeason(season) {
  if (!season) return true;
  const now = Date.now();
  if (season.endDate   && new Date(season.endDate).getTime()   < now) return false;
  if (season.startDate && new Date(season.startDate).getTime() > now) return false;
  return true;
}

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });
  const debug = req.query && req.query.debug !== undefined;

  if (!debug && cache.data && Date.now() - cache.at < cache.ttl) {
    return res.status(200).json(cache.data);
  }

  try {
    const ids = Object.keys(COMPETITIONS);
    const dbg = [];
    const teams = [];

    // fetch each competition's standings, capturing diagnostics as we go
    await Promise.all(ids.map(async id => {
      const name = COMPETITIONS[id];
      let info = { id, name, httpStatus: null, season: null, inSeason: null, rows: 0, qualifying: 0 };
      try {
        const r = await fetch(`https://api.football-data.org/v4/competitions/${id}/standings`,
          { headers: { 'X-Auth-Token': key } });
        info.httpStatus = r.status;
        if (!r.ok) { dbg.push(info); return; }
        const j = await r.json();
        info.season = j.season ? { start: j.season.startDate, end: j.season.endDate } : null;
        info.inSeason = inSeason(j.season);
        if (!info.inSeason) { dbg.push(info); return; }
        (j.standings || []).forEach(block => {
          if (block.type !== 'TOTAL') return;
          (block.table || []).forEach(row => {
            info.rows++;
            if ((row.playedGames || 0) < 3) return;
            info.qualifying++;
            teams.push({
              name: row.team?.shortName || row.team?.name || 'Team', league: name,
              gfPer: per(row.goalsFor, row.playedGames), gaPer: per(row.goalsAgainst, row.playedGames),
              formWins: winsInForm(row.form), hasForm: !!row.form,
            });
          });
        });
      } catch (e) { info.error = String(e.message || e); }
      dbg.push(info);
    }));

    const top = (arr, k, dir = 'desc') =>
      [...arr].sort((a, b) => dir === 'desc' ? b[k] - a[k] : a[k] - b[k]).slice(0, 3);
    const data = {
      updated: new Date().toISOString(),
      attacks:  top(teams, 'gfPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gfPer} goals/game` })),
      defences: top(teams, 'gaPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gaPer} conceded/game` })),
      form: teams.some(t => t.hasForm)
        ? top(teams.filter(t => t.hasForm), 'formWins').map(t => ({ name: t.name, league: t.league, stat: `${t.formWins} wins in last 5` }))
        : [],
      empty: teams.length === 0,
    };

    if (debug) return res.status(200).json({ ...data, debug: dbg });
    cache = { at: Date.now(), data, ttl: (data.empty ? EMPTY_MINUTES : CACHE_MINUTES) * 60 * 1000 };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not load standings.' });
  }
}
