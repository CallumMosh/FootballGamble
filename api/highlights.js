// api/highlights.js
// Builds the "Today's best angles" dashboard from league STANDINGS.
// Why standings? One call per competition returns every team's goals for/against
// and recent form — so we get league-wide extremes without scanning each team
// (which would blow the 10-requests-per-minute free-tier cap).
//
// Only in-season competitions are scanned. The big European leagues are on their
// summer break, so their tables would show last season's final standings — stale
// and misleading. Add their IDs back here when their seasons resume.
const COMPETITIONS = {
  2000: 'World Cup',
  2013: 'Brasileirão',
  // 2021: 'Premier League', 2014: 'La Liga', 2019: 'Serie A',
  // 2002: 'Bundesliga', 2015: 'Ligue 1',   // <- re-enable in season
};

let cache = { at: 0, data: null };
const CACHE_MINUTES = 120; // standings move slowly; cache hard to spare the rate limit

const per = (n, games) => games > 0 ? +(n / games).toFixed(2) : 0;
const winsInForm = f => (String(f || '').match(/W/g) || []).length;

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });

  if (cache.data && Date.now() - cache.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(cache.data);
  }

  try {
    const ids = Object.keys(COMPETITIONS);
    // fetch each competition's standings (skip any that error, e.g. not yet started)
    const settled = await Promise.allSettled(ids.map(id =>
      fetch(`https://api.football-data.org/v4/competitions/${id}/standings`, {
        headers: { 'X-Auth-Token': key },
      }).then(r => r.ok ? r.json() : null)
    ));

    const teams = [];
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled' || !s.value) return;
      const league = COMPETITIONS[ids[i]];
      (s.value.standings || []).forEach(block => {
        if (block.type !== 'TOTAL') return; // ignore HOME/AWAY duplicates
        (block.table || []).forEach(row => {
          if ((row.playedGames || 0) < 3) return; // need a meaningful sample
          teams.push({
            name: row.team?.shortName || row.team?.name || 'Team',
            league,
            played: row.playedGames,
            gfPer: per(row.goalsFor, row.playedGames),
            gaPer: per(row.goalsAgainst, row.playedGames),
            formWins: winsInForm(row.form),
            hasForm: !!row.form,
          });
        });
      });
    });

    const top = (arr, key, dir = 'desc') =>
      [...arr].sort((a, b) => dir === 'desc' ? b[key] - a[key] : a[key] - b[key]).slice(0, 3);

    const data = {
      updated: new Date().toISOString(),
      attacks:  top(teams, 'gfPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gfPer} goals/game` })),
      defences: top(teams, 'gaPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gaPer} conceded/game` })),
      form:     teams.some(t => t.hasForm)
        ? top(teams.filter(t => t.hasForm), 'formWins').map(t => ({ name: t.name, league: t.league, stat: `${t.formWins} wins in last 5` }))
        : [],
      empty: teams.length === 0,
    };

    cache = { at: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not load standings.' });
  }
}
