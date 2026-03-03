# OBS Cricket Live Score Overlay

Live cricket scoreboard overlay for OBS Studio using a Node.js backend proxy for Cricbuzz pages and a transparent Browser Source frontend.

## Features

- Express backend proxy to avoid CORS issues
- Cricbuzz page fetch with browser-like headers
- HTML parsing via Cheerio with structured-data + fallback extraction
- `/api/live-score` JSON response for frontend polling
- In-memory caching + API rate limiting
- Transparent lower-third overlay for OBS Browser Source
- Animated score change highlight
- Team logo support (`public/assets/teams/<team-slug>.png`)
- Win probability bar
- Fallback message when data is unavailable

## 1. Install

```bash
npm install
```

## 2. Run

```bash
npm start
```

Server starts on:

- `http://localhost:3000`
- Overlay: `http://localhost:3000/overlay.html`
- Running matches board: `http://localhost:3000/running`
- Health: `http://localhost:3000/health`

## 3. Configure Cricbuzz match source (optional)

By default, backend uses:

- `https://www.cricbuzz.com/cricket-match/live-scores`

Set a direct match URL via env var:

```bash
set CRICKET_MATCH_URL=https://www.cricbuzz.com/live-cricket-scores/<match-id>/<slug>
npm start
```

Or pass it at runtime from overlay URL:

- `http://localhost:3000/overlay.html?matchUrl=<encoded-cricbuzz-url>`

## API

Endpoint:

- `GET /api/live-score`
- `GET /api/live-score?url=<encoded-cricbuzz-url>`

Sample shape:

```json
{
  "match": "Sharjah vs Abu Dhabi",
  "batting_team": "Sharjah",
  "score": "7-0",
  "overs": "1.5",
  "crr": "3.82",
  "rrr": "7.05",
  "target": "128",
  "balls_remaining": "110",
  "batsman": [
    {
      "name": "Johnson Charles",
      "runs": 1,
      "balls": 5,
      "sr": 20
    },
    {
      "name": "Monank Patel",
      "runs": 5,
      "balls": 6,
      "sr": 83.33
    }
  ],
  "bowler": {
    "name": "Jason Holder",
    "overs": "0.5",
    "runs": 5,
    "economy": 6
  },
  "win_probability": {
    "team_a": 50,
    "team_b": 50
  },
  "updated_at": "2026-02-14T10:20:30.000Z",
  "source": "https://www.cricbuzz.com/...",
  "cached": false
}
```

## OBS Setup

1. Open OBS Studio.
2. Add `Browser Source`.
3. URL: `http://localhost:3000/overlay.html`
4. Width/Height: `1920x1080` (or custom).
5. Enable `Refresh browser when scene becomes active`.

## Team logos (optional)

Place files in:

- `public/assets/teams/`

Filename format:

- lowercase slug from batting team name
- example: `India` -> `india.png`, `Abu Dhabi` -> `abu-dhabi.png`

## Notes

- Cricbuzz has no official public API; selectors/structures can change.
- This implementation includes fallback parsing but may need updates over time.
- For production workloads, use a licensed cricket data API.
