// api/insights.js
// ONE endpoint for both the dashboard ("best angles") and the track record.
// Both need league standings, so we fetch each standings table once and reuse it,
// then backtest a few of those teams. Calls are capped and made sequentially so a
// cold page load stays well under the 10-requests-per-minute free-tier cap.
// (Replaces api/highlights.js and api/backtest.js — those can be left dormant.)

const PRIORITY = [
  [2013, 'Brasileirão'], [2000, 'World Cup'],
  [2021, 'Premier League'], [2014, 'La Liga'], [2019, 'Serie A'],
  [2002, 'Bundesliga'], [2015, 'Ligue 1'],
];
const WINDOW = 6;
const MAX_STANDINGS = 4; // how many competitions to check per refresh
const MAX_TEAMS = 3;     // how many teams to backtest
let cache = { at: 0, data: null, ttl: 0 };
const FULL_MIN = 180, EMPTY_MIN = 8;

const per = (n, g) => g > 0 ? +(n / g).toFixed(2) : 0;
const winsInForm = f => (String(f || '').match(/W/g) || []).length;
const band = r => r >= 65 ? 'leansYes' : r >= 45 ? 'coinflip' : 'avoid';
const inSeason = s => {
  if (!s) return true;
  const now = Date.now();
  if (s.endDate && new Date(s.endDate).getTime() < now) return false;
  if (s.startDate && new Date(s.startDate).getTime() > now) return false;
  return true;
};
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
function toRows(id, matches) {
  return (matches || [])
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .map(m => {
      const home = m.homeTeam?.id === Number(id);
      const ft = m.score?.fullTime || {}, ht = m.score?.halfTime || {};
      return {
        gf: (home ? ft.home : ft.away) ?? 0, ga: (home ? ft.away : ft.home) ?? 0,
        htGf: ht.home == null ? null : (home ? ht.home : ht.away),
        htGa: ht.home == null ? null : (home ? ht.away : ht.home),
        opp: home ? (m.awayTeam?.shortName || m.awayTeam?.name) : (m.homeTeam?.shortName || m.homeTeam?.name),
      };
    });
}
function backtestTeam(team, rows, out) {
  for (let k = WINDOW; k < rows.length; k++) {
    const cur = rows[k];
    for (const key in MARKETS) {
      const { test } = MARKETS[key];
      let win = rows.slice(k - WINDOW, k);
      if (key === 'htlead') { win = win.filter(m => m.htGf != null); if (win.length < 3 || cur.htGf == null) continue; }
      const rate = Math.round(win.filter(test).length / win.length * 100);
      out.push({ team, opp: cur.opp, market: key, band: band(rate), rate, actual: test(cur) });
    }
  }
}

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set.' });
  if (cache.data && Date.now() - cache.at < cache.ttl) return res.status(200).json(cache.data);

  try {
    const teams = [];            // for the dashboard
    const candidates = [];       // {id, name} to backtest
    let league = null;
    // sequential standings, capped — naturally throttled and rate-limit safe
    for (let i = 0; i < PRIORITY.length && i < MAX_STANDINGS; i++) {
      const [id, name] = PRIORITY[i];
      const j = await getJson(`https://api.football-data.org/v4/competitions/${id}/standings`, key);
      if (!j || !inSeason(j.season)) continue;
      const tbl = (j.standings || []).find(b => b.type === 'TOTAL');
      (tbl?.table || []).forEach(row => {
        if ((row.playedGames || 0) >= 3) {
          teams.push({ name: row.team?.shortName || row.team?.name, league: name,
            gfPer: per(row.goalsFor, row.playedGames), gaPer: per(row.goalsAgainst, row.playedGames),
            formWins: winsInForm(row.form), hasForm: !!row.form });
        }
        if ((row.playedGames || 0) >= 8 && row.team?.id) {
          candidates.push({ id: row.team.id, name: row.team.shortName || row.team.name, league: name });
        }
      });
      if (!league && candidates.length) league = name;
    }

    // dashboard
    const top = (arr, k, dir = 'desc') => [...arr].sort((a, b) => dir === 'desc' ? b[k] - a[k] : a[k] - b[k]).slice(0, 3);
    const dashboard = {
      attacks:  top(teams, 'gfPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gfPer} goals/game` })),
      defences: top(teams, 'gaPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gaPer} conceded/game` })),
      form: teams.some(t => t.hasForm) ? top(teams.filter(t => t.hasForm), 'formWins')
              .map(t => ({ name: t.name, league: t.league, stat: `${t.formWins} wins in last 5` })) : [],
    };

    // track record — backtest up to MAX_TEAMS candidates (sequential)
    const records = []; let matchesAnalysed = 0;
    const picks = candidates.slice(0, MAX_TEAMS);
    for (const p of picks) {
      const j = await getJson(`https://api.football-data.org/v4/teams/${p.id}/matches?status=FINISHED&limit=30`, key);
      const rows = toRows(p.id, j?.matches);
      if (rows.length > WINDOW) { matchesAnalysed += rows.length - WINDOW; backtestTeam(p.name, rows, records); }
    }
    const tally = recs => { const landed = recs.filter(r => r.actual).length;
      return { n: recs.length, landed, rate: recs.length ? Math.round(landed / recs.length * 100) : 0 }; };
    const track = records.length ? {
      league, teamsUsed: picks.length, matchesAnalysed,
      bands: { leansYes: tally(records.filter(r => r.band === 'leansYes')),
               coinflip: tally(records.filter(r => r.band === 'coinflip')),
               avoid:    tally(records.filter(r => r.band === 'avoid')) },
      markets: Object.keys(MARKETS).map(k => ({ label: MARKETS[k].label, ...tally(records.filter(r => r.market === k && r.band === 'leansYes')) })).filter(m => m.n > 0),
      examples: records.filter(r => r.band === 'leansYes').slice(-8).reverse().map(r => ({ team: r.team, opp: r.opp, label: MARKETS[r.market].label, rate: r.rate, hit: r.actual })),
    } : null;

    const data = {
      updated: new Date().toISOString(),
      dashboard, dashEmpty: teams.length === 0,
      track,     trackEmpty: !track,
    };
    const isEmpty = data.dashEmpty && data.trackEmpty;
    cache = { at: Date.now(), data, ttl: (isEmpty ? EMPTY_MIN : FULL_MIN) * 60 * 1000 };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not load insights.' });
  }
}
