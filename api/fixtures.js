// api/fixtures.js
// Runs on Vercel's servers (NOT in the browser), so your secret key stays hidden.
// It returns the upcoming fixtures for the big 5 leagues as a simple list.
//
// You never need to edit this file. The only thing it relies on is the
// environment variable FOOTBALL_DATA_KEY, which you set in the Vercel dashboard.

const LEAGUE_IDS = {
  2021: 'Premier League',
  2014: 'La Liga',
  2019: 'Serie A',
  2002: 'Bundesliga',
  2015: 'Ligue 1',
};

// --- a tiny cache so we don't burn through the 10-requests-per-minute limit ---
let cache = { at: 0, data: null };
const CACHE_MINUTES = 30;

function ymd(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) {
    return res.status(500).json({ error: 'No API key set. Add FOOTBALL_DATA_KEY in Vercel settings.' });
  }

  // serve from cache if it's fresh
  if (cache.data && Date.now() - cache.at < CACHE_MINUTES * 60 * 1000) {
    return res.status(200).json(cache.data);
  }

  try {
    const today = new Date();
    const tenDays = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000);
    const ids = Object.keys(LEAGUE_IDS).join(',');

    // ONE request gets fixtures across all five leagues
    const url = `https://api.football-data.org/v4/matches?competitions=${ids}` +
                `&dateFrom=${ymd(today)}&dateTo=${ymd(tenDays)}&status=SCHEDULED`;

    const r = await fetch(url, { headers: { 'X-Auth-Token': key } });
    if (!r.ok) {
      const detail = r.status === 429 ? 'Rate limit hit — wait a minute and refresh.' : `API returned ${r.status}.`;
      return res.status(r.status).json({ error: detail });
    }

    const json = await r.json();
    const fixtures = (json.matches || []).map(m => ({
      id: String(m.id),
      league: m.competition?.name || LEAGUE_IDS[m.competition?.id] || 'Football',
      date: m.utcDate,
      home: m.homeTeam?.shortName || m.homeTeam?.name || 'Home',
      away: m.awayTeam?.shortName || m.awayTeam?.name || 'Away',
      homeId: m.homeTeam?.id,
      awayId: m.awayTeam?.id,
    })).filter(f => f.homeId && f.awayId);

    cache = { at: Date.now(), data: fixtures };
    res.status(200).json(fixtures);
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the football data service.' });
  }
}
