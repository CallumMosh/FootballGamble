// api/fixtures.js
// Runs on Vercel's servers (not the browser), so your secret key stays hidden.
// Returns upcoming fixtures across the competitions below as a simple list.
// You never need to edit this file (except the LEAGUE_IDS list if you ever
// want to add/remove competitions). It reads the FOOTBALL_DATA_KEY you set
// in the Vercel dashboard.

const LEAGUE_IDS = {
  2021: 'Premier League',
  2016: 'Championship',
  2001: 'Champions League',
  2014: 'La Liga',
  2019: 'Serie A',
  2002: 'Bundesliga',
  2015: 'Ligue 1',
  2003: 'Eredivisie',
  2017: 'Primeira Liga',
  2000: 'World Cup',     // free on football-data — live through summer 2026
  2013: 'Brasileirão',   // Brazil's league runs through our summer too
};

// only show matches that haven't been played yet
const UPCOMING = ['SCHEDULED', 'TIMED'];

let cache = { at: 0, data: null };
const CACHE_MINUTES = 60;
const ymd = d => d.toISOString().slice(0, 10);

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) return res.status(500).json({ error: 'No API key set. Add FOOTBALL_DATA_KEY in Vercel settings.' });

  if (cache.data && Date.now() - cache.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(cache.data);
  }

  try {
    const today = new Date();
    const windowEnd = new Date(today.getTime() + 11 * 24 * 60 * 60 * 1000);
    // (11 days, not 10 — a one-day safety buffer in case the API treats dateTo as
    // exclusive rather than inclusive, which would otherwise clip off the last
    // day of the window right when something's actually kicking off)
    const ids = Object.keys(LEAGUE_IDS).join(',');

    // ONE request gets fixtures across all the competitions above.
    // We don't filter by status in the URL (it's unreliable) — we filter below.
    const url = `https://api.football-data.org/v4/matches?competitions=${ids}` +
                `&dateFrom=${ymd(today)}&dateTo=${ymd(windowEnd)}`;

    const r = await fetch(url, { headers: { 'X-Auth-Token': key } });
    if (!r.ok) {
      const detail = r.status === 429 ? 'Rate limit hit — wait a minute and refresh.' : `API returned ${r.status}.`;
      return res.status(r.status).json({ error: detail });
    }

    const json = await r.json();
    const fixtures = (json.matches || [])
      .filter(m => UPCOMING.includes(m.status))
      .map(m => ({
        id: String(m.id),
        league: m.competition?.name || LEAGUE_IDS[m.competition?.id] || 'Football',
        competitionId: m.competition?.id,
        date: m.utcDate,
        home: m.homeTeam?.shortName || m.homeTeam?.name || 'Home',
        away: m.awayTeam?.shortName || m.awayTeam?.name || 'Away',
        crest: m.homeTeam?.crest || '',
        awayCrest: m.awayTeam?.crest || '',
        homeId: m.homeTeam?.id,
        awayId: m.awayTeam?.id,
      }))
      .filter(f => f.homeId && f.awayId)
      .sort((a, b) => new Date(a.date) - new Date(b.date)); // soonest first

    cache = { at: Date.now(), data: fixtures };
    res.status(200).json(fixtures);
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the football data service.' });
  }
}
