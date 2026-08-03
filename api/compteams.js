// api/compteams.js
// Returns two teams' recent form derived from a COMPETITION's finished matches,
// e.g. /api/compteams?competition=2000&home=764&away=773
// Why: the free tier won't serve national teams' own match history, but it does
// serve the competition's matches — so we pull both sides' games from there.
// One cached call per competition powers every fixture in it (rate-limit friendly).
//
// The fetch window reaches back ~13 months, not just the current season — early
// in a new season, a team may not have played enough games yet to fill a proper
// read, so we let the window reach into last season's closing games to fill the
// gap rather than show nothing. When that happens we flag it (spansPriorSeason)
// so the frontend can say so honestly, rather than quietly blend the two.

const cache = {}; // { competitionId: { at, matches } }
const CACHE_MINUTES = 90;
const WINDOW = 6;
const PRIOR_SEASON_GAP_DAYS = 75; // a normal 6-game run rarely spans this long —
                                   // a bigger gap means the close season is in there
const ymd = d => d.toISOString().slice(0, 10);

function simplify(m, teamId) {
  const isHome = m.homeTeam?.id === Number(teamId);
  const ft = m.score?.fullTime || {}, ht = m.score?.halfTime || {};
  return {
    gf: (isHome ? ft.home : ft.away) ?? 0,
    ga: (isHome ? ft.away : ft.home) ?? 0,
    htGf: ht.home == null ? null : (isHome ? ht.home : ht.away),
    htGa: ht.home == null ? null : (isHome ? ht.away : ht.home),
    venue: isHome ? 'H' : 'A',
    opponent: isHome ? (m.awayTeam?.shortName || m.awayTeam?.name) : (m.homeTeam?.shortName || m.homeTeam?.name),
    date: m.utcDate,
  };
}

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });

  const { competition, home, away } = req.query;
  if (!competition || !home || !away) return res.status(400).json({ error: 'Missing parameters.' });

  try {
    let entry = cache[competition];
    if (!entry || Date.now() - entry.at > CACHE_MINUTES * 60 * 1000) {
      const farBack = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // ~13 months
      const r = await fetch(
        `https://api.football-data.org/v4/competitions/${competition}/matches?status=FINISHED&dateFrom=${ymd(farBack)}&dateTo=${ymd(new Date())}`,
        { headers: { 'X-Auth-Token': key } });
      if (!r.ok) {
        const detail = r.status === 429 ? 'Rate limit hit — wait a minute.' : `API returned ${r.status}.`;
        return res.status(r.status).json({ error: detail });
      }
      const json = await r.json();
      entry = { at: Date.now(), matches: json.matches || [] };
      cache[competition] = entry;
    }

    const recent = teamId => {
      const games = entry.matches
        .filter(m => m.homeTeam?.id === Number(teamId) || m.awayTeam?.id === Number(teamId))
        .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
        .slice(0, WINDOW);
      let spansPriorSeason = false;
      if (games.length >= 2) {
        const gapDays = (new Date(games[0].utcDate) - new Date(games[games.length - 1].utcDate)) / 86400000;
        spansPriorSeason = gapDays > PRIOR_SEASON_GAP_DAYS;
      }
      return { games: games.map(m => simplify(m, teamId)), spansPriorSeason };
    };

    const h = recent(home), a = recent(away);
    res.status(200).json({ home: h.games, away: a.games, homeSpansPriorSeason: h.spansPriorSeason, awaySpansPriorSeason: a.spansPriorSeason });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the football data service.' });
  }
}
