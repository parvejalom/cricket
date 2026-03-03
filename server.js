const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MATCH_URL =
  process.env.CRICKET_MATCH_URL ||
  'https://crex.com/scoreboard/1057/2EJ/15th-Match/64/TI/fata-vs-hydr-15th-match-national-t20-qualifiers-2026/live';
const CRICBUZZ_LIVE_LIST_URL = 'https://www.cricbuzz.com/cricket-match/live-scores';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 1200);
const RUNNING_CACHE_TTL_MS = Number(process.env.RUNNING_CACHE_TTL_MS || 2500);
const RUNNING_MATCH_LIMIT = Number(process.env.RUNNING_MATCH_LIMIT || 16);
const UPCOMING_DETAILS_LIMIT = Number(process.env.UPCOMING_DETAILS_LIMIT || 12);

let cache = {
  ts: 0,
  sourceUrl: '',
  payload: null,
};
let runningMatchesCache = {
  ts: 0,
  payload: null,
};
const trendStore = new Map();

const limiter = rateLimit({
  windowMs: 15 * 1000,
  limit: Number(process.env.API_RATE_LIMIT || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a few seconds.' },
});

// Allow cross-origin frontend calls (shared hosting frontend -> Render backend).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use('/api', limiter);
app.use(express.static(path.join(__dirname, 'public')));

function cleanText(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, ' ').trim();
}

function parseScoreBits(scoreText) {
  const normalized = cleanText(scoreText);
  const scoreMatch = normalized.match(/(\d+\/?\d*)/);
  const oversMatch = normalized.match(/\((\d+(?:\.\d+)?)\s*ov\)/i);
  return {
    score: scoreMatch ? scoreMatch[1].replace('/', '-') : 'N/A',
    overs: oversMatch ? oversMatch[1] : 'N/A',
  };
}

function toDisplay(value, fallback = 'N/A') {
  if (value === null || value === undefined || value === '' || value === '$undefined') {
    return fallback;
  }
  return String(value);
}

function parseOversToBalls(oversValue) {
  const overs = Number(oversValue);
  if (!Number.isFinite(overs) || overs < 0) return 'N/A';
  const whole = Math.floor(overs);
  const partial = Math.round((overs - whole) * 10);
  return String((whole * 6) + partial);
}

function parseRunsFromScore(scoreText) {
  const match = String(scoreText || '').match(/^(\d+)(?:-|\/)(\d+)$/);
  return {
    runs: match ? Number(match[1]) : 0,
    wickets: match ? Number(match[2]) : 0,
  };
}

function parseOverParts(oversValue) {
  const ov = Number(oversValue);
  if (!Number.isFinite(ov) || ov < 0) {
    return { completedOvers: 0, ballsInCurrentOver: 0, totalBalls: 0 };
  }
  const completedOvers = Math.floor(ov);
  const ballsInCurrentOver = Math.max(0, Math.min(5, Math.round((ov - completedOvers) * 10)));
  return {
    completedOvers,
    ballsInCurrentOver,
    totalBalls: (completedOvers * 6) + ballsInCurrentOver,
  };
}

function inferPhase(oversValue) {
  const ov = Number(String(oversValue || '').replace(/[()]/g, ''));
  if (!Number.isFinite(ov) || ov < 0) return 'LIVE';
  if (ov < 6) return 'POWERPLAY';
  if (ov < 15) return 'MIDDLE OVERS';
  return 'DEATH OVERS';
}

function pushTrendPoint(sourceKey, pct) {
  const key = sourceKey || 'default';
  const safePct = Number.isFinite(Number(pct)) ? Math.max(0, Math.min(100, Number(pct))) : 50;
  const current = trendStore.get(key) || [];
  current.push(safePct);
  while (current.length > 24) current.shift();
  trendStore.set(key, current);
  return current;
}

function augmentLiveFields(base, sourceUrl) {
  const recentBalls = cleanText(base.recent_overs || '').split(/\s+/).filter(Boolean);
  const lastOverBalls = recentBalls.slice(-6);
  const lowerBalls = lastOverBalls.map((b) => b.toLowerCase());
  const overParts = parseOverParts(base.overs);
  const scoreBits = parseRunsFromScore(base.score);
  const crr = Number(base.crr);
  const rrr = Number(base.rrr);
  const target = Number(base.target);
  const runsToWin = Number(base.runs_to_win);

  const formatOvers = 20;
  const projectedScore = Number.isFinite(crr) ? Math.round(crr * formatOvers) : null;
  const powerplayScore = overParts.totalBalls <= 36 ? base.score : (base.powerplay_score || 'N/A');

  const hasNoBall = lowerBalls.some((b) => b.includes('nb'));
  const hasWide = lowerBalls.some((b) => b.includes('wd'));
  const freeHitLikely = hasNoBall;
  const dlsDetected = /dls|duckworth|rain|weather/i.test(cleanText(base.status || ''));

  const teamAWin = Number(base.win_probability?.team_a);
  const teamBWin = Number(base.win_probability?.team_b);
  const resolvedTeamAWin = Number.isFinite(teamAWin) ? teamAWin : 50;
  const resolvedTeamBWin = Number.isFinite(teamBWin) ? teamBWin : 50;
  const trendPoints = pushTrendPoint(sourceUrl, resolvedTeamAWin);
  const boundaryRuns = (safeNum(base?.batsman?.[0]?.fours) * 4) + (safeNum(base?.batsman?.[0]?.sixes) * 6)
    + (safeNum(base?.batsman?.[1]?.fours) * 4) + (safeNum(base?.batsman?.[1]?.sixes) * 6);
  const pshipRunsRaw = safeNum(base?.partnership?.runs, 0);
  const boundaryPct = pshipRunsRaw > 0 ? Math.round((boundaryRuns / pshipRunsRaw) * 100) : 0;
  const bowlSpell = `${safeNum(base?.bowler?.wickets, 0)}-${safeNum(base?.bowler?.runs, 0)} (${toDisplay(base?.bowler?.overs, '0.0')})`;
  const bowlPhase = `Economy ${Number(safeNum(base?.bowler?.economy, 0)).toFixed(2)}`;

  return {
    ...base,
    team_logos: {
      team_a: cleanText(base?.team_logos?.team_a || ''),
      team_b: cleanText(base?.team_logos?.team_b || ''),
    },
    player_images: {
      batsman1: cleanText(base?.player_images?.batsman1 || ''),
      batsman2: cleanText(base?.player_images?.batsman2 || ''),
      bowler: cleanText(base?.player_images?.bowler || ''),
    },
    live_stats: {
      last_over_summary: lastOverBalls.length ? lastOverBalls.join(' ') : 'N/A',
      ball_by_ball: lastOverBalls,
      powerplay_score: powerplayScore,
      run_comparison: {
        current_rr: Number.isFinite(crr) ? crr : null,
        required_rr: Number.isFinite(rrr) ? rrr : null,
        projected_score: projectedScore,
      },
      wagon_wheel: {
        available: false,
        note: 'Optional - add external tracking feed for true wagon wheel',
      },
    },
    match_flow: {
      over_progress: {
        balls_in_over: overParts.ballsInCurrentOver,
        balls_per_over: 6,
        progress_pct: Math.round((overParts.ballsInCurrentOver / 6) * 100),
      },
      indicators: {
        free_hit: freeHitLikely,
        no_ball: hasNoBall,
        wide: hasWide,
      },
    },
    prediction: {
      win_probability: {
        team_a: resolvedTeamAWin,
        team_b: resolvedTeamBWin,
      },
      dls_status: dlsDetected ? cleanText(base.status || 'DLS in effect') : 'No DLS',
      chase: {
        target: Number.isFinite(target) ? target : null,
        runs_to_win: Number.isFinite(runsToWin) ? runsToWin : null,
        current_runs: scoreBits.runs,
      },
    },
    premium: {
      phase: inferPhase(base.overs),
      trend_points: trendPoints,
      bowler_spell: bowlSpell,
      bowler_phase: bowlPhase,
      partnership: {
        runs: pshipRunsRaw,
        balls: safeNum(base?.partnership?.balls, 0),
        boundary_pct: boundaryPct,
      },
      ticker: {
        last_wicket: cleanText(base?.last_wicket || base?.status || 'N/A') || 'N/A',
        next_batsman: cleanText(base?.next_batsman || 'TBA') || 'TBA',
        required_equation: Number.isFinite(runsToWin) && Number.isFinite(Number(base.balls_remaining))
          ? `${runsToWin} off ${base.balls_remaining}`
          : cleanText(base?.status || 'Live'),
      },
    },
  };
}

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseCrexState(html) {
  const match = html.match(/<script id="app-root-state" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return null;

  const decoded = match[1]
    .replace(/&q;/g, '"')
    .replace(/&a;/g, '&')
    .replace(/&s;/g, "'")
    .replace(/\r?\n/g, '');

  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function parseCrexWinProb(raw, battingKey) {
  const parts = String(raw || '').split(',');
  if (parts.length < 3) return { team_a: 50, team_b: 50 };
  const teamKey = parts[0];
  const aVal = safeNum(parts[1], 0);
  const bVal = safeNum(parts[2], 0);
  const total = aVal + bVal;
  if (total <= 0) return { team_a: 50, team_b: 50 };

  const teamAFirst = teamKey === battingKey;
  const firstPct = Math.round((aVal / total) * 100);
  const secondPct = 100 - firstPct;
  return teamAFirst
    ? { team_a: firstPct, team_b: secondPct }
    : { team_a: secondPct, team_b: firstPct };
}

function parseFromCrex($, html) {
  const state = parseCrexState(html);
  if (!state || typeof state !== 'object') return null;

  const liveKey = Object.keys(state).find((k) => k.includes('/w/sV3.php'));
  const mapKey = Object.keys(state).find((k) => k.includes('getHomeMapDataliveparsing'));
  const feedKey = Object.keys(state).find((k) => k.includes('commentary/getBallFeeds'));
  if (!liveKey) return null;

  const live = state[liveKey] || {};
  const mapping = state[mapKey] || {};
  const feeds = Array.isArray(state[feedKey]) ? state[feedKey] : [];
  const teams = Array.isArray(mapping.t) ? mapping.t : [];
  const players = Array.isArray(mapping.p) ? mapping.p : [];

  const team1Key = String(live.a || live.team1_fkey || '').replace('^', '');
  const team2Key = String((live.a || '').split('.')[1] || live.team2_fkey || '');
  const team1Map = teams.find((t) => t.f_key === team1Key) || {};
  const team2Map = teams.find((t) => t.f_key === team2Key) || {};

  const team1Name = cleanText(live.team1_f_n || team1Map.n || live.team1 || 'Team A');
  const team2Name = cleanText(live.team2_f_n || team2Map.n || live.team2 || 'Team B');
  const inningNo = safeNum(live.inning, 1);
  const battingTeam = inningNo === 2 ? team2Name : team1Name;

  const b1Name = cleanText(live.player_full_name1 || live.pname1 || 'N/A');
  const b2Name = cleanText(live.player_full_name2 || live.pname2 || 'N/A');
  const bowlerName = cleanText(live.bowler_full_name || live.bname || 'N/A');

  const bwrText = String(live.bwr || '0-0');
  const bwrMatch = bwrText.match(/(\d+)-(\d+)/);
  const bWk = bwrMatch ? safeNum(bwrMatch[1]) : 0;
  const bRuns = bwrMatch ? safeNum(bwrMatch[2]) : 0;

  const overBlocks = Array.isArray(live.rb) ? live.rb : [];
  const powerplayBlock = overBlocks.find((o) => safeNum(o.o) === 6);
  const powerplayScore = cleanText(powerplayBlock?.ts || '');
  const lastOvers = Array.isArray(live.lastovers) ? live.lastovers : [];
  const latestOver = lastOvers[lastOvers.length - 1] || {};
  const latestOverInfo = Array.isArray(latestOver.overinfo) ? latestOver.overinfo.map((x) => String(x)) : [];

  const ballFeeds = feeds
    .filter((f) => f && (f.type === 'b' || (f.commentary && f.commentary.type === 'b')))
    .map((f) => f.commentary || f)
    .slice(0, 6);
  const ballByBall = ballFeeds.map((b) => String(b.b || b.u || '.'));

  const hasWagon = ballFeeds.some((b) => b.wagon_w && b.wagon_w !== 'NA');
  const hasWide = ballByBall.some((x) => /wd/i.test(x));
  const hasNoBall = ballByBall.some((x) => /nb/i.test(x));

  return {
    match: `${team1Name} vs ${team2Name}`,
    batting_team: battingTeam,
    score: cleanText(live.score1 || 'N/A'),
    overs: cleanText(live.over1 || 'N/A'),
    crr: cleanText(live.crr || 'N/A'),
    rrr: cleanText(live.rrr || 'N/A'),
    target: cleanText(live.rT || 'N/A') === '0' ? 'N/A' : cleanText(live.rT || 'N/A'),
    balls_remaining: 'N/A',
    runs_to_win: cleanText(live.rT || 'N/A') === '0' ? 'N/A' : cleanText(live.rT || 'N/A'),
    partnership: {
      runs: safeNum(live.partnerruns),
      balls: safeNum(live.partnerballs),
    },
    batsman: [
      {
        name: b1Name,
        runs: safeNum(live.run1),
        balls: safeNum(String(live.ball1 || '').replace(/[()]/g, '')),
        sr: safeNum(live.sr1),
        fours: safeNum(live.four1 || live.f1),
        sixes: safeNum(live.six1 || live.s1),
      },
      {
        name: b2Name,
        runs: safeNum(live.run2),
        balls: safeNum(String(live.ball2 || '').replace(/[()]/g, '')),
        sr: safeNum(live.sr2),
        fours: safeNum(live.four2 || live.f2),
        sixes: safeNum(live.six2 || live.s2),
      },
    ],
    bowler: {
      name: bowlerName,
      overs: cleanText(live.bover || 'N/A'),
      runs: bRuns,
      economy: safeNum(live.beco),
      wickets: bWk,
    },
    team_logos: {
      team_a: cleanText(live.team1flag || ''),
      team_b: cleanText(live.team2flag || ''),
    },
    player_images: {
      batsman1: cleanText(live.b1image || ''),
      batsman2: cleanText(live.b2image || ''),
      bowler: cleanText(live.b3image || ''),
    },
    recent_overs: cleanText(String(live.d || '').replace(/\./g, ' ')),
    status: cleanText(live.comment1 || ''),
    last_wicket: cleanText(live.lastWicket || live.lastwicket || live.wkt || ''),
    next_batsman: cleanText(live.pname3 || live.nextBatsman || ''),
    match_format: cleanText(live.mt || live.fo || 'T20'),
    win_probability: parseCrexWinProb(live.wp, live.rtKey || team1Key),
    live_stats: {
      last_over_summary: latestOverInfo.join(' ') || 'N/A',
      ball_by_ball: ballByBall,
      powerplay_score: powerplayScore || (safeNum(live.over1) <= 6 ? cleanText(live.score1 || 'N/A') : 'N/A'),
      run_comparison: {
        current_rr: Number.isFinite(Number(live.crr)) ? Number(live.crr) : null,
        required_rr: Number.isFinite(Number(live.rrr)) ? Number(live.rrr) : null,
        projected_score: null,
      },
      wagon_wheel: {
        available: hasWagon,
        note: hasWagon ? 'Wagon wheel events detected' : 'Optional - not in current feed',
      },
    },
    match_flow: {
      over_progress: {
        balls_in_over: parseOverParts(cleanText(live.over1 || '0')).ballsInCurrentOver,
        balls_per_over: 6,
        progress_pct: Math.round((parseOverParts(cleanText(live.over1 || '0')).ballsInCurrentOver / 6) * 100),
      },
      indicators: {
        free_hit: hasNoBall,
        no_ball: hasNoBall,
        wide: hasWide,
      },
    },
    prediction: {
      win_probability: parseCrexWinProb(live.wp, live.rtKey || team1Key),
      dls_status: /rain|dls/i.test(cleanText(live.comment1 || '')) ? cleanText(live.comment1) : 'No DLS',
      chase: {
        target: Number.isFinite(Number(live.rT)) && Number(live.rT) > 0 ? Number(live.rT) : null,
        runs_to_win: Number.isFinite(Number(live.rT)) && Number(live.rT) > 0 ? Number(live.rT) : null,
        current_runs: safeNum(String(live.score1 || '0-0').split('-')[0]),
      },
    },
    parse_vendor: 'crex',
  };
}

function extractEscapedJsonObject(html, key) {
  const marker = `\\\\\"${key}\\\\\":{`;
  let offset = 0;

  while (offset < html.length) {
    const start = html.indexOf(marker, offset);
    if (start < 0) return null;

    const objectStart = start + marker.length - 1;
    let depth = 0;

    for (let i = objectStart; i < html.length; i += 1) {
      const ch = html[i];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const raw = html.slice(objectStart, i + 1);
          const unescaped = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          try {
            return JSON.parse(unescaped);
          } catch {
            break;
          }
        }
      }
    }

    offset = start + marker.length;
  }

  return null;
}

function parseFromEmbeddedMiniscore($, html) {
  const miniscore = extractEscapedJsonObject(html, 'miniscore');
  if (!miniscore || typeof miniscore !== 'object') return null;

  const match = cleanText($('h1').first().text()) || 'Live Match';
  const teams = match.split(/\bvs\b/i).map((t) => cleanText(t)).filter(Boolean);
  const innings = miniscore.matchScoreDetails?.inningsScoreList?.[0] || {};
  const batTeamFromHeader = teams[0] || 'N/A';
  const battingTeam = batTeamFromHeader;

  const runs = Number(miniscore.batTeam?.teamScore ?? innings.score ?? 0);
  const wkts = Number(miniscore.batTeam?.teamWkts ?? innings.wickets ?? 0);
  const overs = toDisplay(miniscore.overs ?? innings.overs, 'N/A');
  const targetValue = miniscore.target;
  const remRuns = miniscore.remRunsToWin;
  const oversRem = miniscore.oversRem;
  const ballsRemaining = Number.isFinite(Number(oversRem)) ? parseOversToBalls(oversRem) : 'N/A';

  const striker = miniscore.batsmanStriker || {};
  const nonStriker = miniscore.batsmanNonStriker || {};
  const bowler = miniscore.bowlerStriker || miniscore.bowlerNonStriker || {};
  const partnerShip = miniscore.partnerShip || {};

  return {
    match,
    batting_team: battingTeam,
    score: `${runs}-${wkts}`,
    overs,
    crr: toDisplay(miniscore.currentRunRate, 'N/A'),
    rrr: toDisplay(miniscore.requiredRunRate, 'N/A'),
    target: targetValue === null || targetValue === undefined ? 'N/A' : String(targetValue),
    balls_remaining: ballsRemaining,
    runs_to_win: Number.isFinite(Number(remRuns)) ? String(remRuns) : 'N/A',
    partnership: {
      runs: Number(partnerShip.runs || 0),
      balls: Number(partnerShip.balls || 0),
    },
    batsman: [
      {
        name: cleanText(striker.name || 'N/A'),
        runs: Number(striker.runs || 0),
        balls: Number(striker.balls || 0),
        sr: Number(striker.strikeRate || 0),
        fours: Number(striker.fours || striker['4s'] || 0),
        sixes: Number(striker.sixes || striker['6s'] || 0),
      },
      {
        name: cleanText(nonStriker.name || 'N/A'),
        runs: Number(nonStriker.runs || 0),
        balls: Number(nonStriker.balls || 0),
        sr: Number(nonStriker.strikeRate || 0),
        fours: Number(nonStriker.fours || nonStriker['4s'] || 0),
        sixes: Number(nonStriker.sixes || nonStriker['6s'] || 0),
      },
    ],
    bowler: {
      name: cleanText(bowler.name || 'N/A'),
      overs: toDisplay(bowler.overs, 'N/A'),
      runs: Number(bowler.runs || 0),
      economy: Number(bowler.economy || 0),
      wickets: Number(bowler.wickets || 0),
    },
    recent_overs: cleanText(miniscore.recentOvsStats || ''),
    status: cleanText(miniscore.matchScoreDetails?.customStatus || miniscore.status || ''),
    last_wicket: cleanText(miniscore.recentWicket || miniscore.lastWicket || ''),
    next_batsman: cleanText(miniscore.nextBatsman || ''),
    match_format: cleanText(miniscore.matchScoreDetails?.matchFormat || 'T20'),
    win_probability: { team_a: 50, team_b: 50 },
  };
}

function parseFromMetaFallback($) {
  const description = cleanText($('meta[name="description"]').attr('content') || '');
  const matchTitle = cleanText($('h1').first().text()) || cleanText($('title').first().text()) || 'Live Match';

  const scoreRegex = /Follow\s+([A-Z]{2,8})\s+(\d+)\/(\d+)\s*\((\d+(?:\.\d+)?)\)/i;
  const scoreMatch = description.match(scoreRegex);
  const batterRegex = /([A-Za-z.' -]+)\s+(\d+)\((\d+)\)/g;
  const batterMatches = [...description.matchAll(batterRegex)].slice(0, 2);

  const batsman = batterMatches.map((m) => ({
    name: cleanText(m[1]),
    runs: Number(m[2]),
    balls: Number(m[3]),
    sr: Number(m[3]) > 0 ? Number(((Number(m[2]) / Number(m[3])) * 100).toFixed(2)) : 0,
    fours: 0,
    sixes: 0,
  }));

  return {
    match: matchTitle,
    batting_team: cleanText(matchTitle.split('vs')[0] || 'N/A'),
    score: scoreMatch ? `${scoreMatch[2]}-${scoreMatch[3]}` : 'N/A',
    overs: scoreMatch ? scoreMatch[4] : 'N/A',
    crr: 'N/A',
    rrr: 'N/A',
    target: 'N/A',
    balls_remaining: 'N/A',
    runs_to_win: 'N/A',
    partnership: { runs: 0, balls: 0 },
    batsman: batsman.length ? batsman : [
      { name: 'N/A', runs: 0, balls: 0, sr: 0, fours: 0, sixes: 0 },
      { name: 'N/A', runs: 0, balls: 0, sr: 0, fours: 0, sixes: 0 },
    ],
    bowler: { name: 'N/A', overs: 'N/A', runs: 0, economy: 0, wickets: 0 },
    recent_overs: '',
    status: '',
    last_wicket: '',
    next_batsman: '',
    match_format: 'T20',
    win_probability: { team_a: 50, team_b: 50 },
  };
}

function parseFromHtmlFallback($) {
  const title = cleanText($('title').first().text()) || 'Live Match';

  const scoreLine = cleanText(
    $('[class*=score], [class*=runs], [class*=bat]').first().text() ||
    $('body').text().match(/\d+\/\d+\s*\(\d+(?:\.\d+)?\s*ov\)/i)?.[0] ||
    ''
  );

  const { score, overs } = parseScoreBits(scoreLine);

  const matchTitle = cleanText(
    $('h1').first().text() ||
    title.replace('- Cricbuzz', '').replace('| Cricbuzz.com', '')
  );

  return {
    match: matchTitle || 'Live Match',
    batting_team: cleanText(matchTitle.split('vs')[0] || 'N/A'),
    score,
    overs,
    crr: 'N/A',
    rrr: 'N/A',
    target: 'N/A',
    balls_remaining: 'N/A',
    batsman: [
      { name: 'N/A', runs: 0, balls: 0, sr: 0, fours: 0, sixes: 0 },
      { name: 'N/A', runs: 0, balls: 0, sr: 0, fours: 0, sixes: 0 },
    ],
    bowler: { name: 'N/A', overs: 'N/A', runs: 0, economy: 0 },
    recent_overs: '',
    status: '',
    last_wicket: '',
    next_batsman: '',
    match_format: 'T20',
    win_probability: { team_a: 50, team_b: 50 },
  };
}

function parseMatchMetaFromCricbuzzHtml($, html) {
  const rawHtml = String(html || '');
  const meta = {
    venue: '',
    toss: '',
    umpires: [],
    match_referee: '',
  };

  $('script[type="application/ld+json"]').each((_, node) => {
    const raw = cleanText($(node).html() || '');
    if (!raw || !raw.includes('"@type":"SportsEvent"')) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed['@type'] === 'SportsEvent') {
        meta.venue = cleanText(parsed?.location?.name || meta.venue);
      }
    } catch {
      // ignore malformed json-ld
    }
  });

  const tossPatterns = [
    /Toss[:\s-]+([^<\n\r.]+)/i,
    /"tossResults?"\s*:\s*"([^"]+)"/i,
    /"toss"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of tossPatterns) {
    const m = rawHtml.match(pattern);
    if (m && cleanText(m[1])) {
      meta.toss = cleanText(m[1]);
      break;
    }
  }

  const umpirePatterns = [
    /Umpires?[:\s-]+([^<\n\r.]+)/i,
    /"umpire1"\s*:\s*"([^"]+)"/i,
    /"umpire2"\s*:\s*"([^"]+)"/i,
    /"umpires?"\s*:\s*"([^"]+)"/i,
  ];
  const umpires = [];
  for (const pattern of umpirePatterns) {
    const m = rawHtml.match(pattern);
    if (m && cleanText(m[1])) umpires.push(cleanText(m[1]));
  }
  meta.umpires = [...new Set(umpires)].slice(0, 3);

  const refereeMatch = rawHtml.match(/Match Referee[:\s-]+([^<\n\r.]+)/i) || rawHtml.match(/"referee"\s*:\s*"([^"]+)"/i);
  if (refereeMatch && cleanText(refereeMatch[1])) {
    meta.match_referee = cleanText(refereeMatch[1]);
  }

  return meta;
}

async function fetchAndParseScore(sourceUrl) {
  if (/crex\.com/i.test(sourceUrl)) {
    const response = await axios.get(sourceUrl, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://crex.com/',
        Connection: 'keep-alive',
      },
    });
    const html = response.data;
    const $ = cheerio.load(html);
    const crex = parseFromCrex($, html);
    if (crex) return crex;
  }

  const requestOptions = {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.cricbuzz.com/',
      Connection: 'keep-alive',
    },
  };

  const response = await axios.get(sourceUrl, requestOptions);
  const html = response.data;
  const $ = cheerio.load(html);
  const meta = parseMatchMetaFromCricbuzzHtml($, html);
  const primaryParsed = parseFromEmbeddedMiniscore($, html);
  if (primaryParsed) {
    return {
      ...primaryParsed,
      venue: cleanText(primaryParsed.venue || meta.venue || 'N/A'),
      toss: cleanText(primaryParsed.toss || meta.toss || 'N/A'),
      umpires: Array.isArray(primaryParsed.umpires) && primaryParsed.umpires.length
        ? primaryParsed.umpires
        : meta.umpires,
      match_referee: cleanText(primaryParsed.match_referee || meta.match_referee || 'N/A'),
    };
  }

  const scorecardUrl = sourceUrl.replace('/live-cricket-scores/', '/live-cricket-scorecard/');
  if (scorecardUrl !== sourceUrl) {
    try {
      const scorecardRes = await axios.get(scorecardUrl, requestOptions);
      const scorecardHtml = scorecardRes.data;
      const scorecard$ = cheerio.load(scorecardHtml);
      const scorecardMeta = parseMatchMetaFromCricbuzzHtml(scorecard$, scorecardHtml);
      const scorecardParsed = parseFromEmbeddedMiniscore(scorecard$, scorecardHtml);
      if (scorecardParsed) {
        return {
          ...scorecardParsed,
          venue: cleanText(scorecardParsed.venue || scorecardMeta.venue || meta.venue || 'N/A'),
          toss: cleanText(scorecardParsed.toss || scorecardMeta.toss || meta.toss || 'N/A'),
          umpires: Array.isArray(scorecardParsed.umpires) && scorecardParsed.umpires.length
            ? scorecardParsed.umpires
            : (scorecardMeta.umpires.length ? scorecardMeta.umpires : meta.umpires),
          match_referee: cleanText(scorecardParsed.match_referee || scorecardMeta.match_referee || meta.match_referee || 'N/A'),
        };
      }
    } catch {
      // Keep fallback behavior when scorecard page is unavailable.
    }
  }

  const fallback = parseFromMetaFallback($) || parseFromHtmlFallback($);
  return {
    ...fallback,
    venue: cleanText(fallback.venue || meta.venue || 'N/A'),
    toss: cleanText(fallback.toss || meta.toss || 'N/A'),
    umpires: Array.isArray(fallback.umpires) && fallback.umpires.length ? fallback.umpires : meta.umpires,
    match_referee: cleanText(fallback.match_referee || meta.match_referee || 'N/A'),
  };
}

async function resolveCrexSourceUrl(inputUrl) {
  const source = String(inputUrl || '').trim();
  if (!source) return source;
  if (!/crex\.com/i.test(source) || !/\/series\//i.test(source)) return source;

  try {
    const response = await axios.get(source, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://crex.com/',
        Connection: 'keep-alive',
      },
    });

    const html = String(response.data || '');
    const plain = [...html.matchAll(/\/scoreboard\/[^"'\s<]+/g)].map((m) => m[0]);
    const escaped = [...html.matchAll(/\\\/scoreboard\\\/[^"'\s<]+/g)]
      .map((m) => m[0].replace(/\\\//g, '/'));
    const merged = [...plain, ...escaped]
      .map((u) => (u.startsWith('http') ? u : `https://crex.com${u}`));
    const unique = [...new Set(merged)];
    if (!unique.length) return source;

    const live = unique.find((u) => /\/live$/i.test(u));
    if (live) return live;

    const normalized = unique[0].replace(/\/(info|scorecard)$/i, '/live');
    return normalized;
  } catch {
    return source;
  }
}

function toAbsoluteCricbuzzUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `https://www.cricbuzz.com${raw}`;
  return `https://www.cricbuzz.com/${raw.replace(/^\/+/, '')}`;
}

function isNonRunningStatus(statusText) {
  const value = cleanText(statusText || '').toLowerCase();
  if (!value) return false;
  return /(upcoming|preview|won|complete|result|abandon|cancel|no result|stumps|match drawn|match tied)/i.test(value);
}

function classifyMatchStatus(statusText) {
  const value = cleanText(statusText || '').toLowerCase();
  if (!value) return 'running';
  if (/(delay|delayed|rain|wet outfield|bad weather|abandon|abandoned|cancel|cancelled|no result)/i.test(value)) {
    return 'disrupted';
  }
  if (/(upcoming|preview)/i.test(value)) return 'upcoming';
  if (/(won|complete|result|abandon|cancel|no result|stumps|match drawn|match tied)/i.test(value)) return 'completed';
  return 'running';
}

function detectAlertType(statusText, descriptionText = '') {
  const combined = `${cleanText(statusText || '')} ${cleanText(descriptionText || '')}`.toLowerCase();
  if (/(cancel|cancelled|abandon|abandoned|no result)/i.test(combined)) return 'CANCELLED';
  if (/(delay|delayed|late start|start delayed)/i.test(combined)) return 'DELAYED';
  if (/(rain|wet outfield|weather)/i.test(combined)) return 'RAIN';
  return 'ALERT';
}

function getCricbuzzStatusFromTitle(title) {
  const cleanTitle = cleanText(title || '');
  const bits = cleanTitle.split(' - ').map((x) => cleanText(x)).filter(Boolean);
  if (bits.length < 2) return '';
  return bits[bits.length - 1];
}

function extractRunningMatchCandidatesFromListHtml(html) {
  const $ = cheerio.load(html);
  const byKey = new Map();

  $('a[href*="/live-cricket-scores/"]').each((_, node) => {
    const anchor = $(node);
    const href = cleanText(anchor.attr('href') || '');
    if (!href) return;

    const url = toAbsoluteCricbuzzUrl(href);
    if (!url) return;

    const titleText = cleanText(anchor.attr('title') || '');
    const status = getCricbuzzStatusFromTitle(titleText);
    const rawLabel = cleanText(anchor.find('div.text-white').first().text() || anchor.text() || '');
    const subLabel = cleanText(anchor.find('div.text-xs').first().text() || '');
    const name = cleanText(rawLabel.split(' - ')[0] || rawLabel || titleText);

    if (!name) return;
    const nearestSeries = cleanText(
      anchor.parent().prevAll('a[href*="/cricket-series/"]').first().text() ||
      anchor.closest('div').prevAll('a[href*="/cricket-series/"]').first().text() ||
      '',
    );
    const resolvedStatus = cleanText(status || subLabel || 'LIVE');
    const state = classifyMatchStatus(resolvedStatus || `${titleText} ${rawLabel} ${subLabel}`);

    const idMatch = url.match(/\/live-cricket-scores\/(\d+)\//i);
    const uniqueKey = idMatch ? `match-${idMatch[1]}` : url;

    if (!byKey.has(uniqueKey)) {
      byKey.set(uniqueKey, {
        url,
        title: titleText || name,
        name,
        status: resolvedStatus,
        state,
        series: nearestSeries,
        match_info: subLabel,
      });
    }
  });

  return [...byKey.values()];
}

async function fetchUpcomingMatchDetails(sourceUrl) {
  try {
    const response = await axios.get(sourceUrl, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.cricbuzz.com/',
        Connection: 'keep-alive',
      },
    });

    const $ = cheerio.load(String(response.data || ''));
    const html = String(response.data || '');
    const h1 = cleanText($('h1').first().text() || '');
    const meta = cleanText($('meta[name="description"]').attr('content') || '');
    const scheduleMatch = meta.match(/,\s*(Today|Tomorrow|[A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4}[^,]*)\s*,/);
    let startTimeUtc = '';
    let venue = '';

    $('script[type="application/ld+json"]').each((_, node) => {
      if (startTimeUtc) return;
      const raw = cleanText($(node).html() || '');
      if (!raw || !raw.includes('"@type":"SportsEvent"')) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed['@type'] === 'SportsEvent') {
          startTimeUtc = cleanText(parsed.startDate || '');
          venue = cleanText(parsed?.location?.name || '');
        }
      } catch {
        // ignore malformed json-ld blocks
      }
    });

    if (!startTimeUtc) {
      const fallbackMatch = html.match(/"startDate":"([^"]+)"/i);
      startTimeUtc = fallbackMatch ? cleanText(fallbackMatch[1]) : '';
    }

    return {
      headline: h1 || cleanText($('title').first().text() || ''),
      description: meta || '',
      schedule: scheduleMatch ? cleanText(scheduleMatch[1]) : 'TBA',
      start_time_utc: startTimeUtc,
      venue,
    };
  } catch {
    return { headline: '', description: '', schedule: 'TBA', start_time_utc: '', venue: '' };
  }
}

async function fetchLiveAndUpcomingMatchesFromCricbuzz(limit = RUNNING_MATCH_LIMIT) {
  const response = await axios.get(CRICBUZZ_LIVE_LIST_URL, {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.cricbuzz.com/',
      Connection: 'keep-alive',
    },
  });

  const candidates = extractRunningMatchCandidatesFromListHtml(String(response.data || ''))
    .slice(0, Math.max(1, Number(limit) || RUNNING_MATCH_LIMIT));

  if (!candidates.length) {
    return { running_matches: [], upcoming_matches: [], disrupted_matches: [] };
  }

  const runningCandidates = candidates.filter((c) => c.state === 'running');
  const upcomingCandidates = candidates.filter((c) => c.state === 'upcoming');
  const disruptedCandidates = candidates.filter((c) => c.state === 'disrupted');

  const runningSettled = await Promise.allSettled(
    runningCandidates.map(async (candidate) => {
      const base = await fetchAndParseScore(candidate.url);
      const live = augmentLiveFields(base, candidate.url);
      const status = cleanText(live.status || candidate.status || 'LIVE');
      if (isNonRunningStatus(status)) return null;
      return {
        match: cleanText(live.match || candidate.name),
        status,
        batting_team: cleanText(live.batting_team || 'N/A'),
        score: cleanText(live.score || 'N/A'),
        overs: cleanText(live.overs || 'N/A'),
        crr: cleanText(live.crr || 'N/A'),
        rrr: cleanText(live.rrr || 'N/A'),
        target: cleanText(live.target || 'N/A'),
        balls_remaining: cleanText(live.balls_remaining || 'N/A'),
        runs_to_win: cleanText(live.runs_to_win || 'N/A'),
        recent_overs: cleanText(live.recent_overs || ''),
        venue: cleanText(live.venue || 'N/A'),
        toss: cleanText(live.toss || 'N/A'),
        umpires: Array.isArray(live.umpires) ? live.umpires : [],
        series: cleanText(candidate.series || 'N/A'),
        match_info: cleanText(candidate.match_info || 'N/A'),
        team_logos: live.team_logos || {},
        batsman: Array.isArray(live.batsman) ? live.batsman.slice(0, 2) : [],
        bowler: live.bowler || {},
        win_probability: live.win_probability || { team_a: 50, team_b: 50 },
        source: candidate.url,
      };
    }),
  );

  const running_matches = runningSettled
    .filter((entry) => entry.status === 'fulfilled' && entry.value)
    .map((entry) => entry.value);

  const upcomingSettled = await Promise.allSettled(
    upcomingCandidates.slice(0, Math.max(1, UPCOMING_DETAILS_LIMIT)).map(async (candidate) => {
      const details = await fetchUpcomingMatchDetails(candidate.url);
      return {
        match: cleanText(details.headline || candidate.title || candidate.name || 'Upcoming Match'),
        status: cleanText(candidate.status || 'Upcoming Match'),
        schedule: cleanText(details.schedule || 'TBA'),
        start_time_utc: cleanText(details.start_time_utc || ''),
        venue: cleanText(details.venue || 'N/A'),
        match_info: cleanText(candidate.match_info || 'N/A'),
        series: cleanText(candidate.series || 'N/A'),
        description: cleanText(details.description || ''),
        source: candidate.url,
      };
    }),
  );

  const upcoming_matches = upcomingSettled
    .filter((entry) => entry.status === 'fulfilled' && entry.value)
    .map((entry) => entry.value);

  const disruptedSettled = await Promise.allSettled(
    disruptedCandidates.slice(0, Math.max(1, UPCOMING_DETAILS_LIMIT)).map(async (candidate) => {
      const details = await fetchUpcomingMatchDetails(candidate.url);
      return {
        match: cleanText(details.headline || candidate.title || candidate.name || 'Match Alert'),
        status: cleanText(candidate.status || 'Match Alert'),
        alert_type: detectAlertType(candidate.status, details.description),
        schedule: cleanText(details.schedule || 'TBA'),
        start_time_utc: cleanText(details.start_time_utc || ''),
        venue: cleanText(details.venue || 'N/A'),
        match_info: cleanText(candidate.match_info || 'N/A'),
        series: cleanText(candidate.series || 'N/A'),
        description: cleanText(details.description || ''),
        source: candidate.url,
      };
    }),
  );

  const disrupted_matches = disruptedSettled
    .filter((entry) => entry.status === 'fulfilled' && entry.value)
    .map((entry) => entry.value);

  return { running_matches, upcoming_matches, disrupted_matches };
}

app.get('/api/live-score', async (req, res) => {
  const requestedUrl = req.query.url || DEFAULT_MATCH_URL;
  const sourceUrl = await resolveCrexSourceUrl(requestedUrl);
  const fallbackUrl = await resolveCrexSourceUrl(DEFAULT_MATCH_URL);
  const now = Date.now();

  if (
    cache.payload &&
    cache.sourceUrl === sourceUrl &&
    now - cache.ts <= CACHE_TTL_MS
  ) {
    return res.json({ ...cache.payload, cached: true });
  }

  try {
    const data = await fetchAndParseScore(sourceUrl);
    const payload = {
      ...augmentLiveFields(data, sourceUrl),
      updated_at: new Date().toISOString(),
      source: sourceUrl,
      requested_source: requestedUrl,
      cached: false,
    };

    cache = { ts: now, sourceUrl, payload };
    return res.json(payload);
  } catch (error) {
    if (sourceUrl !== fallbackUrl) {
      try {
        const data = await fetchAndParseScore(fallbackUrl);
        const payload = {
          ...augmentLiveFields(data, fallbackUrl),
          updated_at: new Date().toISOString(),
          source: fallbackUrl,
          requested_source: requestedUrl,
          failover_from: sourceUrl,
          cached: false,
        };
        cache = { ts: now, sourceUrl: fallbackUrl, payload };
        return res.json(payload);
      } catch {
        // continue to stale/error response
      }
    }

    if (cache.payload) {
      return res.json({
        ...cache.payload,
        stale: true,
        stale_reason: 'upstream_unavailable',
        requested_source: requestedUrl,
      });
    }

    return res.status(502).json({
      error: 'Unable to fetch live score from upstream source',
      details: cleanText(error.message || 'Unknown error'),
      source: sourceUrl,
      fallback_source: fallbackUrl,
    });
  }
});

app.get('/api/running-matches', async (req, res) => {
  const now = Date.now();
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), 40)
    : RUNNING_MATCH_LIMIT;

  if (runningMatchesCache.payload && now - runningMatchesCache.ts <= RUNNING_CACHE_TTL_MS) {
    return res.json({ ...runningMatchesCache.payload, cached: true });
  }

  try {
    const liveBoard = await fetchLiveAndUpcomingMatchesFromCricbuzz(limit);
    const running_matches = liveBoard.running_matches || [];
    const upcoming_matches = liveBoard.upcoming_matches || [];
    const disrupted_matches = liveBoard.disrupted_matches || [];
    const payload = {
      source: CRICBUZZ_LIVE_LIST_URL,
      updated_at: new Date().toISOString(),
      total: running_matches.length + upcoming_matches.length + disrupted_matches.length,
      running_total: running_matches.length,
      upcoming_total: upcoming_matches.length,
      disrupted_total: disrupted_matches.length,
      matches: running_matches,
      running_matches,
      upcoming_matches,
      disrupted_matches,
      cached: false,
    };
    runningMatchesCache = { ts: now, payload };
    return res.json(payload);
  } catch (error) {
    if (runningMatchesCache.payload) {
      return res.json({
        ...runningMatchesCache.payload,
        stale: true,
        stale_reason: 'upstream_unavailable',
      });
    }
    return res.status(502).json({
      error: 'Unable to fetch running matches from Cricbuzz',
      details: cleanText(error.message || 'Unknown error'),
      source: CRICBUZZ_LIVE_LIST_URL,
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'obs-cricket-live-score-overlay' });
});

app.get('/control', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

app.get('/running', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'running.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
