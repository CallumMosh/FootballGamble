// api/highlights.js
// Builds the "Today's best angles" dashboard from league STANDINGS.
// One standings call per competition returns every team's goals for/against and
// form — far cheaper than scanning each team (which would blow the 10-req/min cap).
//
// AUTO IN-SEASON DETECTION: each competition is only included while its season is
// actually running. We read the season's start/end dates from the standings
// response and skip anything finished (off-season tables are last season's — stale)
// or not yet started. So leagues switch themselves on when they kick off and off
// when they end — the big 5 included — with no manual edits needed.
const COMPETITIONS = {
  2021: 'Premier League',
  2014: 'La Liga',
  2019: 'Serie A',
  2002: 'Bundesliga',
  2015: 'Ligue 1',
  2000: 'World Cup',
  2013: 'Brasileirão',
};

let cache = { at: 0, data: null };
const CACHE_MINUTES = 120; // standings move slowly; cache hard to spare the rate limit

const per = (n, games) => games > 0 ? +(n / games).toFixed(2) : 0;
const winsInForm = f => (String(f || '').match(/W/g) || []).length;

// is "now" inside this season's window? (lenient if a date is missing)
function inSeason(season) {
  if (!season) return true;
  const now = Date.now();
  if (season.endDate   && new Date(season.endDate).getTime()   < now) return false; // finished
  if (season.startDate && new Date(season.startDate).getTime() > now) return false; // not started
  return true;
}

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });

  if (cache.data && Date.now() - cache.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(cache.data);
  }

  try {
    const ids = Object.keys(COMPETITIONS);
    const settled = await Promise.allSettled(ids.map(id =>
      fetch(`https://api.football-data.org/v4/competitions/${id}/standings`, {
        headers: { 'X-Auth-Token': key },
      }).then(r => r.ok ? r.json() : null)
    ));

    const teams = [];
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled' || !s.value) return;
      if (!inSeason(s.value.season)) return;          // skip off-season / not-started leagues
      const league = COMPETITIONS[ids[i]];
      (s.value.standings || []).forEach(block => {
        if (block.type !== 'TOTAL') return;            // ignore HOME/AWAY duplicates
        (block.table || []).forEach(row => {
          if ((row.playedGames || 0) < 3) return;      // need a meaningful sample
          teams.push({
            name: row.team?.shortName || row.team?.name || 'Team',
            league,
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
