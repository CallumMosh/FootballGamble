# Punterly — how to put this online (no coding needed)

You don't edit any code to get this live. There are three short stages:
get a free data key, put these files on GitHub, then deploy on Vercel.
Take it slowly — every step is just clicking and pasting.

---

## Stage 1 — Get your free football-data key (≈2 min)

1. Go to **https://www.football-data.org/client/register**
2. Sign up with your email. You'll get an email with an **API token**
   (a long string of letters and numbers).
3. Copy that token and keep it somewhere safe. You'll paste it in once, later.

> The free plan covers the Premier League, La Liga, Serie A, Bundesliga and
> Ligue 1, with a limit of 10 requests per minute. The app is built to stay
> well under that, so you don't need to worry about it.

---

## Stage 2 — Put the files on GitHub (≈5 min, no install)

1. Make a free account at **https://github.com** if you don't have one.
2. Click the **+** (top right) → **New repository**. Name it `punterly`,
   leave it Public, click **Create repository**.
3. On the next page click **"uploading an existing file"** (it's a link in the
   middle of the page).
4. Drag in **all** the files and folders from this project, keeping the structure:
   ```
   punterly/
   ├── public/
   │   └── index.html
   ├── api/
   │   ├── fixtures.js
   │   └── team.js
   └── package.json
   ```
5. Scroll down, click **Commit changes**. Done — your code now lives on GitHub.

---

## Stage 3 — Deploy on Vercel and get your link (≈3 min)

1. Go to **https://vercel.com** and click **Sign Up** → **Continue with GitHub**.
2. Click **Add New… → Project**, find your `punterly` repo, click **Import**.
3. **Before** you press Deploy, open the **Environment Variables** section and add:
   - **Name:** `FOOTBALL_DATA_KEY`
   - **Value:** *(paste the token from Stage 1)*
   - Click **Add**.
4. Click **Deploy** and wait about a minute.
5. Vercel gives you a link like **https://punterly.vercel.app** — that's your
   live site. Share it with anyone.

---

## Good to know

- **Data is slightly delayed** on the free plan. Perfectly fine for previewing
  upcoming fixtures and recent form; it's not live in-play scores.
- **What it shows right now:** upcoming big-5 fixtures, last-5 form, and reads on
  and a plain-English read on Over 2.5 Goals and Both Teams To Score —
  the markets you can build honestly from free data.
- **What's NOT here yet** (needs a paid tier): player props like "Kane to score",
  plus corners and cards. That's the natural "phase two" once it's worth paying.
- **Want to change the wording or thresholds?** Open `public/index.html` and find
  the `verdict()` function near the top of the script. That's the brain of the
  whole thing — tweak it and re-upload to GitHub; Vercel redeploys automatically.

You're not really coding here — you're running something that's already built.
