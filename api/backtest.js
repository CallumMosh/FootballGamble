// api/backtest.js
// HONEST TRACK RECORD. For every past game we replay the read using ONLY the six
// games before it, then check the actual result. No game sees its own future;
// losses are counted. This mirrors the live site exactly (same 6-game window,
// same 65/45 verdict bands), so the track record reflects what users actually see.
//
// Cheap + rate-limit safe: 1 standings call to discover in-season teams, then 1
// match-history call per team, cached for 12h.

const PRIORITY = [
  [2013, 'Brasileirão'], [2000, 'World Cup'],
  [2021, 'Premier League'], [2014, 'La Liga'], [2019, 'Serie A'],
  [2002, 'Bundesliga'], [2015, 'Ligue 1'],
];
const WINDOW = 6;
const MAX_TEAMS = 8;
let cache = { at: 0, data: null };
const CACHE_MINUTES = 720; // 12h

const inSeason = s => {
  if (!s) return true;
  const now = Date.now();
  if (s.endDate && new Date(s.endDate).getTime() < now) return false;
  if (s.startDate && new Date(s.startDate).getTime() > now) return false;
  return true;
};
const band = r => r >= 65 ? 'leansYes' : r >= 45 ? 'coinflip' : 'avoid';
const MARKETS = {
  score:  { label: 'To score',          test: m => m.gf > 0 },
  clean:  { label: 'Clean sheet',        test: m => m.ga === 0 },
  over25: { label: 'Over 2.5 goals',     test: m => m.gf + m.ga > 2.5 },
  htlead: { label: 'Ahead at half-time', test: m => m.htGf != null && m.htGf > m.htGa },
};

async function getJson(url, key) {
  const r = await fetch(url, { headers: { 'X-Auth-Token': key } });
  return r.ok ? r.json() : null;
}

// turn a team's API matches into chronological (oldest-first) team-perspective rows
function toRows(id, matches) {
  return (matches || [])
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .map(m => {
      const home = m.homeTeam?.id === Number(id);
      const ft = m.score?.fullTime || {}, ht = m.score?.halfTime || {};
      return {
        gf: (home ? ft.home : ft.away) ?? 0,
        ga: (home ? ft.away : ft.home) ?? 0,
        htGf: ht.home == null ? null : (home ? ht.home : ht.away),
        htGa: ht.home == null ? null : (home ? ht.away : ht.home),
        opp: home ? (m.awayTeam?.shortName || m.awayTeam?.name) : (m.homeTeam?.shortName || m.homeTeam?.name),
      };
    });
}

// walk forward; each call uses only the prior WINDOW games
function backtestTeam(team, rows, out) {
  for (let k = WINDOW; k < rows.length; k++) {
    const cur = rows[k];
    for (const key in MARKETS) {
      const { test } = MARKETS[key];
      let win = rows.slice(k - WINDOW, k);
      if (key === 'htlead') {
        win = win.filter(m => m.htGf != null);
        if (win.length < 3 || cur.htGf == null) continue;
      }
      const rate = Math.round(win.filter(test).length / win.length * 100);
      out.push({ team, opp: cur.opp, market: key, band: band(rate), rate, actual: test(cur) });
    }
  }
}

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });
  if (cache.data && Date.now() - cache.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(cache.data);
  }

  try {
    // 1) find an in-season competition and its teams
    let chosen = null;
    for (const [id, league] of PRIORITY) {
      const j = await getJson(`https://api.football-data.org/v4/competitions/${id}/standings`, key);
      if (!j || !inSeason(j.season)) continue;
      const tbl = (j.standings || []).find(b => b.type === 'TOTAL');
      const rows = (tbl?.table || []).filter(r => (r.playedGames || 0) >= 8);
      if (rows.length >= 4) {
        chosen = { league, ids: rows.slice(0, MAX_TEAMS).map(r => r.team?.id).filter(Boolean),
                   names: Object.fromEntries(rows.map(r => [r.team?.id, r.team?.shortName || r.team?.name])) };
        break;
      }
    }
    if (!chosen) {
      const empty = { empty: true, note: 'No in-season league with enough games yet — the track record fills in once matches are played.' };
      cache = { at: Date.now(), data: empty };
      return res.status(200).json(empty);
    }

    // 2) backtest each team from its match history (1 call each)
    const records = [];
    let matchesAnalysed = 0;
    for (const id of chosen.ids) {
      const j = await getJson(`https://api.football-data.org/v4/teams/${id}/matches?status=FINISHED&limit=30`, key);
      const rows = toRows(id, j?.matches);
      if (rows.length > WINDOW) { matchesAnalysed += rows.length - WINDOW; backtestTeam(chosen.names[id] || 'Team', rows, records); }
    }

    // 3) aggregate honestly
    const tally = recs => {
      const landed = recs.filter(r => r.actual).length;
      return { n: recs.length, landed, rate: recs.length ? Math.round(landed / recs.length * 100) : 0 };
    };
    const bands = {
      leansYes: tally(records.filter(r => r.band === 'leansYes')),
      coinflip: tally(records.filter(r => r.band === 'coinflip')),
      avoid:    tally(records.filter(r => r.band === 'avoid')),
    };
    const markets = Object.keys(MARKETS).map(key => {
      const t = tally(records.filter(r => r.market === key && r.band === 'leansYes'));
      return { label: MARKETS[key].label, ...t };
    }).filter(m => m.n > 0);
    const examples = records.filter(r => r.band === 'leansYes').slice(-8).reverse().map(r => ({
      team: r.team, opp: r.opp, label: MARKETS[r.market].label, rate: r.rate, hit: r.actual,
    }));

    const data = {
      empty: records.length === 0,
      league: chosen.league,
      teamsUsed: chosen.ids.length,
      matchesAnalysed,
      bands, markets, examples,
      updated: new Date().toISOString(),
    };
    cache = { at: Date.now(), data };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not build the track record.' });
  }
}
