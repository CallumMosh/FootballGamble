// api/insights.js
// ONE endpoint for both the dashboard ("best angles") and the track record.
// Both need league standings, so we fetch each standings table once and reuse it,
// then backtest a few of those teams. Calls are capped and made sequentially so a
// cold page load stays well under the 10-requests-per-minute free-tier cap.
// (Replaces api/highlights.js and api/backtest.js — those can be left dormant.)

const PRIORITY = [
  [2000, 'World Cup'],                                   // takes priority while it's actually running
  [2021, 'Premier League'], [2016, 'Championship'], [2014, 'La Liga'],
  [2013, 'Brasileirão'],
  [2001, 'Champions League'], [2019, 'Serie A'], [2002, 'Bundesliga'], [2015, 'Ligue 1'],
  [2003, 'Eredivisie'], [2017, 'Primeira Liga'],
];
const WINDOW = 6;
const MAX_STANDINGS = 3;   // how many IN-SEASON competitions to actually use
const MAX_ATTEMPTS = 6;    // how many entries to check before giving up — protects the rate limit
                            // while still letting the loop skip past dead slots (e.g. an
                            // ended World Cup) to reach a genuinely in-season league further down
const MAX_TEAMS = 2;     // how many teams to backtest
const REQUEST_GAP_MS = 400; // pause between each sequential standings check, so this
                             // burst alone doesn't eat the whole rate-limit budget
let cache = { at: 0, data: null, ttl: 0 };
const FULL_MIN = 360, EMPTY_MIN = 8;

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

let anyFail = false; // set true if a fetch ultimately failed (e.g. rate limited) this build
async function getJson(url, key, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'X-Auth-Token': key } });
    if (r.status === 429 && i < tries - 1) { await new Promise(s => setTimeout(s, 3000)); continue; }
    if (r.ok) return r.json();
    if (r.status === 429) anyFail = true; // still limited after the retry
    return null;
  }
}
function toRows(id, matches) {
  return (matches || [])
    .filter(m => m.homeTeam?.id === Number(id) || m.awayTeam?.id === Number(id))
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

  // diagnostic mode — visit /api/insights?debug=1&key=YOUR_DEBUG_KEY to see exactly
  // what each competition's season data looks like and whether inSeason() accepted
  // or rejected it, without needing to expose the football-data key or touch the
  // real cached response. Gated behind a separate secret (DEBUG_KEY, set in the
  // Vercel dashboard) so a stranger who finds this URL can't trigger it — each call
  // makes up to 10 sequential requests to football-data.org, which would otherwise
  // let anyone burn through the whole site's shared 10-req/min budget just by
  // hitting this one endpoint repeatedly.
  // Wrong or missing key just falls through to the normal response below, rather
  // than returning a distinct "wrong key" error — so there's nothing that confirms
  // to an outsider that this mode even exists.
  if (req.query.debug === '1' && process.env.DEBUG_KEY && req.query.key === process.env.DEBUG_KEY) {
    const report = [];
    for (const [id, name] of PRIORITY) {
      if (report.length > 0) await new Promise(s => setTimeout(s, REQUEST_GAP_MS));
      const j = await getJson(`https://api.football-data.org/v4/competitions/${id}/standings`, key);
      report.push({
        competition: name, id,
        fetchSucceeded: !!j,
        season: j?.season || null,
        inSeasonResult: j ? inSeason(j.season) : null,
        now: new Date().toISOString(),
      });
    }
    return res.status(200).json(report);
  }

  if (cache.data && Date.now() - cache.at < cache.ttl) return res.status(200).json(cache.data);
  anyFail = false; // fresh build

  try {
    const teams = [];            // for the dashboard
    const teamIds = [];          // {id, name} — every team in the chosen league, checked later
    let league = null, leagueId = null;
    let found = 0; // in-season competitions actually used — capped at MAX_STANDINGS
    // sequential standings — tries up to MAX_ATTEMPTS entries (skipping dead/out-of-season
    // ones for free) but only ever USES the first MAX_STANDINGS that are genuinely live,
    // so an ended tournament's empty slot can't starve out a league further down the list.
    // A small gap between each request means this burst alone is less likely to exhaust
    // the shared 10-req/min budget, especially when it lands close to other site activity
    // (a fixtures fetch, another visitor, or repeated manual testing).
    for (let i = 0; i < PRIORITY.length && i < MAX_ATTEMPTS && found < MAX_STANDINGS; i++) {
      if (i > 0) await new Promise(s => setTimeout(s, REQUEST_GAP_MS));
      const [id, name] = PRIORITY[i];
      const j = await getJson(`https://api.football-data.org/v4/competitions/${id}/standings`, key);
      if (!j || !inSeason(j.season)) continue;
      found++;
      const tbl = (j.standings || []).find(b => b.type === 'TOTAL');
      (tbl?.table || []).forEach(row => {
        if ((row.playedGames || 0) >= 3) {
          teams.push({ name: row.team?.shortName || row.team?.name, league: name,
            gfPer: per(row.goalsFor, row.playedGames), gaPer: per(row.goalsAgainst, row.playedGames),
            formWins: winsInForm(row.form), hasForm: !!row.form });
        }
        // don't gate on standings' playedGames here — for a World Cup group table that
        // caps at 3 regardless of how far a team goes, so it can never reach a useful
        // threshold. Just collect the team list; real eligibility is checked below
        // against actual finished matches.
        if (!league && row.team?.id) teamIds.push({ id: row.team.id, name: row.team.shortName || row.team.name });
      });
      if (!league && teamIds.length) { league = name; leagueId = id; }
    }

    // dashboard
    const top = (arr, k, dir = 'desc') => [...arr].sort((a, b) => dir === 'desc' ? b[k] - a[k] : a[k] - b[k]).slice(0, 3);
    const dashboard = {
      attacks:  top(teams, 'gfPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gfPer} goals/game` })),
      defences: top(teams, 'gaPer').map(t => ({ name: t.name, league: t.league, stat: `${t.gaPer} conceded/game` })),
      form: teams.some(t => t.hasForm) ? top(teams.filter(t => t.hasForm), 'formWins')
              .map(t => ({ name: t.name, league: t.league, stat: `${t.formWins} wins in last 5` })) : [],
    };

    // track record — derive each candidate's history from the COMPETITION's own
    // finished-matches feed (one shared fetch), not the per-team endpoint, which the
    // free tier doesn't serve for national teams — same fix compteams.js already
    // uses for the live reads, now applied here too.
    const records = []; let matchesAnalysed = 0;
    const picks = [];
    if (leagueId) {
      const mj = await getJson(`https://api.football-data.org/v4/competitions/${leagueId}/matches?status=FINISHED`, key);
      const matches = mj?.matches || [];
      for (const t of teamIds) {
        if (picks.length >= MAX_TEAMS) break;
        const rows = toRows(t.id, matches);
        if (rows.length > WINDOW) {
          picks.push(t.name);
          matchesAnalysed += rows.length - WINDOW;
          backtestTeam(t.name, rows, records);
        }
      }
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
      partial: anyFail,           // a fetch was rate-limited — result may be incomplete
    };
    const isEmpty = data.dashEmpty && data.trackEmpty;
    // don't lock in an incomplete build; rebuild on the next load instead
    const ttl = anyFail ? 0 : (isEmpty ? EMPTY_MIN : FULL_MIN) * 60 * 1000;
    cache = { at: Date.now(), data, ttl };
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Could not load insights.' });
  }
}
