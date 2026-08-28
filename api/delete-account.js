// api/delete-account.js
// Permanently deletes the signed-in user's account, called from the "Delete my
// account" button in Settings on the Account tab.
//
// Two steps, using Supabase's REST API directly (fetch, no SDK dependency —
// matches every other file in this folder):
//   1. Verify the access token the browser sent actually belongs to a real,
//      currently-signed-in user (GET /auth/v1/user). Never trust a user id
//      handed to us by the client alone — otherwise anyone could delete anyone
//      else's account just by knowing their id.
//   2. Use the SERVICE ROLE key (server-only — never sent to the browser, and
//      must never be pasted into index.html) to delete exactly that verified
//      user via Supabase's admin endpoint.
//
// Deleting the auth.users row cascades automatically to `profiles` and `bets`
// — both reference auth.users with "on delete cascade" in schema.sql — so
// nothing else needs deleting by hand.
//
// Requires a new env var in the Vercel dashboard: SUPABASE_SERVICE_ROLE_KEY
// (Supabase dashboard → Project Settings → API → "service_role" secret key —
// NOT the same as the publishable key already used in index.html).

const SUPABASE_URL = 'https://oiksyumokpzypxmuydka.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3uFfc5UhwF6a5Ig3S7J_gw_KdQkJBBW';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return res.status(500).json({ error: 'Server not configured for account deletion.' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Not signed in.' });

  try {
    // step 1 — resolve the token to a real user id, using the public anon key
    // (this call just asks "who is this token for", it can't delete anything)
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!whoRes.ok) return res.status(401).json({ error: 'Session is invalid or expired — please log in again.' });
    const who = await whoRes.json();
    if (!who?.id) return res.status(401).json({ error: 'Could not verify your account.' });

    // step 2 — delete exactly that verified user, using the service role key
    const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${who.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    });
    if (!delRes.ok) {
      const detail = await delRes.text().catch(() => '');
      return res.status(500).json({ error: `Deletion failed on the server. ${detail}`.trim() });
    }

    res.status(200).json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach the account service.' });
  }
}
