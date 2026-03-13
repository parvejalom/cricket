const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MATCH_URL = String(process.env.CRICKET_MATCH_URL || '').trim();
const CRICBUZZ_LIVE_LIST_URL = 'https://www.cricbuzz.com/cricket-match/live-scores';
const LEGACY_BOARD_URL = String(process.env.CRICKET_LEGACY_BOARD_URL || 'https://cricket-l117.onrender.com/api/running-matches').trim();
const EXTRA_SOURCE_URLS = [
  ...(DEFAULT_MATCH_URL ? [DEFAULT_MATCH_URL] : []),
  ...String(process.env.CRICKET_EXTRA_SOURCE_URLS || '')
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean),
];
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 2000);
const RUNNING_CACHE_TTL_MS = Number(process.env.RUNNING_CACHE_TTL_MS || 2000);
const RUNNING_MATCH_LIMIT = Number(process.env.RUNNING_MATCH_LIMIT || 50);
const UPCOMING_DETAILS_LIMIT = Number(process.env.UPCOMING_DETAILS_LIMIT || 12);
const UPSTREAM_CALL_TIMEOUT_MS = Number(process.env.UPSTREAM_CALL_TIMEOUT_MS || 6500);
const MATCH_PARSE_TIMEOUT_MS = Math.max(UPSTREAM_CALL_TIMEOUT_MS, 12000);
const SOURCE_PAYLOAD_CACHE_TTL_MS = Number(process.env.SOURCE_PAYLOAD_CACHE_TTL_MS || Math.max(CACHE_TTL_MS, 4000));

let cache = {
  ts: 0,
  sourceUrl: '',
  payload: null,
};
let runningMatchesCache = {
  ts: 0,
  payload: null,
};
const sourcePayloadCache = new Map();
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

function cleanRichText(input) {
  if (typeof input !== 'string') return '';

  return cleanText(
    input
      .replace(/&l;/g, '<')
      .replace(/&g;/g, '>')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/<[^>]*>/g, ' ')
  );
}

function normalizeOversText(input) {
  const raw = cleanText(String(input || ''));
  if (!raw || /^N\/A$/i.test(raw) || raw === '--') return 'N/A';

  const cleaned = cleanText(
    raw
      .replace(/\bov(?:ers?)?\.?\b/gi, ' ')
      .replace(/[()]/g, ' ')
  );
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  return match ? match[1] : raw;
}

async function withTimeout(task, timeoutMs, fallbackValue = null) {
  let timer;
  try {
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
    });
    return await Promise.race([task(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const overs = Number(normalizeOversText(oversValue));
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
  const ov = Number(normalizeOversText(oversValue));
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
  const ov = Number(normalizeOversText(oversValue));
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
  const overs = normalizeOversText(toDisplay(miniscore.overs ?? innings.overs, 'N/A'));
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
    overs: normalizeOversText(scoreMatch ? scoreMatch[4] : 'N/A'),
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
    overs: normalizeOversText(overs),
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

function splitPlayers(raw) {
  return String(raw || '')
    .split(',')
    .map((p) => cleanText(p))
    .filter(Boolean)
    .slice(0, 30);
}

function parseTeamListsFromText(rawHtml, label) {
  const text = cleanText(
    String(rawHtml || '')
      .replace(/\\u0027/g, "'")
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
  );

  const map = {};
  const pattern = new RegExp(
    `([A-Z][A-Za-z .&'-]{1,50})\\s*\\(${label}\\)\\s*:\\s*(.+?)(?=\\s+[A-Z][A-Za-z .&'-]{1,50}\\s*\\((?:Playing XI|Squad)\\)\\s*:|\\s+Squads?:|$)`,
    'gi',
  );

  for (const match of text.matchAll(pattern)) {
    const team = cleanText(match[1]);
    const players = splitPlayers(match[2]);
    if (team && players.length) map[team] = players;
  }

  return map;
}

function mergeTeamMaps(primary = {}, fallback = {}) {
  const merged = { ...(fallback || {}), ...(primary || {}) };
  return Object.fromEntries(
    Object.entries(merged).map(([team, players]) => [team, Array.isArray(players) ? players : []]),
  );
}

function parseMatchMetaFromCricbuzzHtml($, html) {
  const rawHtml = String(html || '');
  const meta = {
    venue: '',
    toss: '',
    umpires: [],
    match_referee: '',
    playing_xi_by_team: {},
    squads_by_team: {},
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

  const tossLong =
    rawHtml.match(/([A-Za-z .&'-]+)\s+have won the toss and have opted to\s+([A-Za-z ]+)/i) ||
    rawHtml.match(/([A-Za-z .&'-]+)\s+won the toss and elected to\s+([A-Za-z ]+)/i);
  if (!meta.toss && tossLong) {
    meta.toss = `${cleanText(tossLong[1])} (${cleanText(tossLong[2])})`;
  }

  meta.playing_xi_by_team = parseTeamListsFromText(rawHtml, 'Playing XI');
  meta.squads_by_team = parseTeamListsFromText(rawHtml, 'Squad');

  return meta;
}

async function fetchAndParseScore(sourceUrl) {
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
      playing_xi_by_team: mergeTeamMaps(primaryParsed.playing_xi_by_team, meta.playing_xi_by_team),
      squads_by_team: mergeTeamMaps(primaryParsed.squads_by_team, meta.squads_by_team),
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
          playing_xi_by_team: mergeTeamMaps(
            scorecardParsed.playing_xi_by_team,
            mergeTeamMaps(scorecardMeta.playing_xi_by_team, meta.playing_xi_by_team),
          ),
          squads_by_team: mergeTeamMaps(
            scorecardParsed.squads_by_team,
            mergeTeamMaps(scorecardMeta.squads_by_team, meta.squads_by_team),
          ),
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
    playing_xi_by_team: mergeTeamMaps(fallback.playing_xi_by_team, meta.playing_xi_by_team),
    squads_by_team: mergeTeamMaps(fallback.squads_by_team, meta.squads_by_team),
  };
}

function isCricbuzzUrl(inputUrl) {
  return /(^https?:\/\/)?(www\.)?cricbuzz\.com\//i.test(String(inputUrl || '').trim());
}

async function resolveSourceUrl(inputUrl) {
  const source = String(inputUrl || '').trim();
  if (!source) return source;
  return isCricbuzzUrl(source) ? source : '';
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

function dedupeMatchesBySource(items = []) {
  const byKey = new Map();

  for (const item of items) {
    const source = cleanText(item?.source || '');
    const match = cleanText(item?.match || '');
    const key = source || match;
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }

  return [...byKey.values()];
}

function dedupeCandidatesByUrl(items = []) {
  const byKey = new Map();

  for (const item of items) {
    const key = cleanText(item?.url || '');
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }

  return [...byKey.values()];
}

function isPlaceholderLiveMatch(match = {}) {
  const score = cleanText(match?.score || '').toUpperCase();
  const overs = cleanText(match?.overs || '');
  const status = cleanText(match?.status || '').toUpperCase();
  const battingTeam = cleanText(match?.batting_team || '');
  const recentOvers = cleanText(match?.recent_overs || '');
  const target = cleanText(match?.target || '').toUpperCase();

  const hasRealStatus = /(need|needs|won|trail|lead|elected|require|target|day|session|stumps|rain|delay)/i.test(status);
  const hasRecentAction = recentOvers !== '';
  const hasNamedBatsman = Array.isArray(match?.batsman)
    && match.batsman.some((item) => cleanText(item?.name || '').toUpperCase() !== 'N/A');
  const hasScoringProgress = !['', 'N/A', '0-0', '0/0'].includes(score)
    || !['', 'N/A', '0', '0.0'].includes(overs)
    || !['', 'N/A', '0'].includes(target);

  if (!battingTeam || battingTeam.toUpperCase() === 'N/A') return true;
  if (hasRealStatus || hasRecentAction || hasNamedBatsman || hasScoringProgress) return false;
  return true;
}

function filterPlaceholderLiveMatches(items = []) {
  return items.filter((item) => !isPlaceholderLiveMatch(item));
}

function cleanMatchHeadline(value, fallback = 'Match') {
  const title = cleanRichText(String(value || ''))
    .replace(/\s*-\s*(commentary|live commentary|scorecard)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return title || fallback;
}

function normalizePublicStatus(statusText, state = 'running') {
  const status = cleanRichText(String(statusText || ''));
  if (!status) {
    if (state === 'upcoming') return 'Upcoming';
    if (state === 'disrupted') return 'Alert';
    return 'LIVE';
  }

  if (/^preview$/i.test(status) || /^upcoming match$/i.test(status)) return 'Upcoming';
  if (/^live$/i.test(status)) return 'LIVE';
  if (/delay|delayed/i.test(status)) return 'Delayed';
  if (/rain|wet outfield|weather/i.test(status)) return 'Rain Delay';
  return status;
}

function parseUtcMillis(value) {
  const raw = cleanText(value || '');
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
}

function sortRunningMatches(items = []) {
  return [...items].sort((a, b) => {
    const aLive = /^live$/i.test(cleanText(a?.status || ''));
    const bLive = /^live$/i.test(cleanText(b?.status || ''));
    if (aLive !== bLive) return aLive ? -1 : 1;
    return cleanText(a?.match || '').localeCompare(cleanText(b?.match || ''));
  });
}

function sortUpcomingMatches(items = []) {
  return [...items].sort((a, b) => {
    const timeDiff = parseUtcMillis(a?.start_time_utc) - parseUtcMillis(b?.start_time_utc);
    if (timeDiff !== 0) return timeDiff;
    return cleanText(a?.match || '').localeCompare(cleanText(b?.match || ''));
  });
}

async function fetchConfiguredSourceCandidates() {
  const manualExpanded = await Promise.all(
    [...new Set(EXTRA_SOURCE_URLS)].map(async (rawUrl) => {
      const source = cleanText(rawUrl);
      if (!source) return [];
      const resolved = await resolveSourceUrl(source);
      return resolved ? [cleanText(resolved)] : [];
    }),
  );
  const manualCandidates = [...new Set(manualExpanded.flat().filter(Boolean))].map((url) => ({
    url,
    title: '',
    name: '',
    status: '',
    state: 'running',
    series: 'Direct Source',
    match_info: 'Manual source',
  }));

  return dedupeCandidatesByUrl(manualCandidates);
}

async function buildCandidatePayload(candidate) {
  const cacheKey = cleanText(candidate?.url || '');
  const cached = cacheKey ? sourcePayloadCache.get(cacheKey) : null;
  if (cached && (Date.now() - cached.ts) <= SOURCE_PAYLOAD_CACHE_TTL_MS) {
    return cached.payload;
  }

  const base = await withTimeout(
    () => fetchAndParseScore(candidate.url),
    MATCH_PARSE_TIMEOUT_MS,
    null,
  );
  if (!base) return null;

  const live = augmentLiveFields(base, candidate.url);
  const status = cleanText(live.status || candidate.status || 'LIVE');
  const derivedState = classifyMatchStatus(status);
  const matchName = cleanMatchHeadline(live.match || candidate.name || candidate.title || 'Match', 'Match');
  const publicStatus = normalizePublicStatus(status, derivedState);

  const payload = {
    state: derivedState,
    running: {
      match: matchName,
      status: publicStatus,
      batting_team: cleanText(live.batting_team || 'N/A'),
      score: cleanText(live.score || 'N/A'),
      overs: normalizeOversText(live.overs || 'N/A'),
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
    },
    upcoming: {
      match: matchName,
      status: publicStatus,
      schedule: 'TBA',
      start_time_utc: '',
      venue: cleanText(live.venue || 'N/A'),
      match_info: cleanText(candidate.match_info || 'N/A'),
      series: cleanText(candidate.series || 'N/A'),
      description: cleanText(live.status || ''),
      source: candidate.url,
    },
    disrupted: {
      match: matchName,
      status: publicStatus,
      alert_type: detectAlertType(status, live.status),
      schedule: 'TBA',
      start_time_utc: '',
      venue: cleanText(live.venue || 'N/A'),
      match_info: cleanText(candidate.match_info || 'N/A'),
      series: cleanText(candidate.series || 'N/A'),
      description: cleanText(live.status || ''),
      source: candidate.url,
    },
  };

  if (cacheKey) {
    sourcePayloadCache.set(cacheKey, { ts: Date.now(), payload });
  }

  return payload;
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
  const extraCandidates = await fetchConfiguredSourceCandidates();
  const mergedCandidates = dedupeCandidatesByUrl([
    ...candidates,
    ...extraCandidates,
  ]);

  if (!mergedCandidates.length) {
    return { running_matches: [], upcoming_matches: [], disrupted_matches: [] };
  }

  const runningCandidates = mergedCandidates.filter((c) => c.state === 'running');
  const upcomingCandidates = mergedCandidates.filter((c) => c.state === 'upcoming');
  const disruptedCandidates = mergedCandidates.filter((c) => c.state === 'disrupted');

  const runningSettled = await Promise.allSettled(
    runningCandidates.map(async (candidate) => {
      const payload = await buildCandidatePayload(candidate);
      if (!payload) return null;
      if (payload.state !== 'running' || isNonRunningStatus(payload.running.status)) return null;
      return payload.running;
    }),
  );

  let running_matches = runningSettled
    .filter((entry) => entry.status === 'fulfilled' && entry.value)
    .map((entry) => entry.value);

  const upcomingSettled = await Promise.allSettled(
    upcomingCandidates.slice(0, Math.max(1, UPCOMING_DETAILS_LIMIT)).map(async (candidate) => {
      const details = await withTimeout(
        () => fetchUpcomingMatchDetails(candidate.url),
        UPSTREAM_CALL_TIMEOUT_MS,
        { headline: '', description: '', schedule: 'TBA', start_time_utc: '', venue: '' },
      );
      return {
        match: cleanMatchHeadline(details.headline || candidate.title || candidate.name || 'Upcoming Match', 'Upcoming Match'),
        status: normalizePublicStatus(candidate.status || 'Upcoming Match', 'upcoming'),
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

  let upcoming_matches = upcomingSettled
    .filter((entry) => entry.status === 'fulfilled' && entry.value)
    .map((entry) => entry.value);

  const disruptedSettled = await Promise.allSettled(
    disruptedCandidates.slice(0, Math.max(1, UPCOMING_DETAILS_LIMIT)).map(async (candidate) => {
      const details = await withTimeout(
        () => fetchUpcomingMatchDetails(candidate.url),
        UPSTREAM_CALL_TIMEOUT_MS,
        { headline: '', description: '', schedule: 'TBA', start_time_utc: '', venue: '' },
      );
      return {
        match: cleanMatchHeadline(details.headline || candidate.title || candidate.name || 'Match Alert', 'Match Alert'),
        status: normalizePublicStatus(candidate.status || 'Match Alert', 'disrupted'),
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

  let disrupted_matches = disruptedSettled
    .filter((entry) => entry.status === 'fulfilled' && entry.value)
    .map((entry) => entry.value);

  running_matches = dedupeMatchesBySource(running_matches);
  running_matches = filterPlaceholderLiveMatches(running_matches);
  upcoming_matches = dedupeMatchesBySource(upcoming_matches);
  disrupted_matches = dedupeMatchesBySource(disrupted_matches);

  return {
    running_matches: sortRunningMatches(running_matches),
    upcoming_matches: sortUpcomingMatches(upcoming_matches),
    disrupted_matches,
  };
}

async function buildFallbackBoardFromDirectSources() {
  const directCandidates = await fetchConfiguredSourceCandidates();
  const settled = await Promise.allSettled(
    directCandidates.map(async (candidate) => buildCandidatePayload(candidate)),
  );

  const running_matches = [];
  const upcoming_matches = [];
  const disrupted_matches = [];

  for (const entry of settled) {
    if (entry.status !== 'fulfilled' || !entry.value) continue;
    if (entry.value.state === 'running') {
      running_matches.push(entry.value.running);
    } else if (entry.value.state === 'upcoming') {
      upcoming_matches.push(entry.value.upcoming);
    } else if (entry.value.state === 'disrupted') {
      disrupted_matches.push(entry.value.disrupted);
    }
  }

  return {
    running_matches: filterPlaceholderLiveMatches(dedupeMatchesBySource(running_matches)),
    upcoming_matches: sortUpcomingMatches(dedupeMatchesBySource(upcoming_matches)),
    disrupted_matches: dedupeMatchesBySource(disrupted_matches),
  };
}

async function fetchLegacyBoard() {
  if (!LEGACY_BOARD_URL) {
    return { running_matches: [], upcoming_matches: [], disrupted_matches: [] };
  }

  try {
    const response = await axios.get(LEGACY_BOARD_URL, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
      },
    });

    const payload = response.data && typeof response.data === 'object' ? response.data : {};
    return {
      running_matches: Array.isArray(payload.running_matches) ? payload.running_matches : [],
      upcoming_matches: Array.isArray(payload.upcoming_matches) ? payload.upcoming_matches : [],
      disrupted_matches: Array.isArray(payload.disrupted_matches) ? payload.disrupted_matches : [],
    };
  } catch {
    return { running_matches: [], upcoming_matches: [], disrupted_matches: [] };
  }
}

app.get('/api/live-score', async (req, res) => {
  const requestedUrl = cleanText(String(req.query.url || DEFAULT_MATCH_URL || ''));
  if (!requestedUrl) {
    return res.status(400).json({
      error: 'No live score source configured',
      details: 'Provide ?url=... or set CRICKET_MATCH_URL',
    });
  }
  const sourceUrl = await resolveSourceUrl(requestedUrl);
  const fallbackUrl = await resolveSourceUrl(DEFAULT_MATCH_URL);
  if (!sourceUrl) {
    return res.status(400).json({
      error: 'Only Cricbuzz URLs are supported',
      details: 'Provide a cricbuzz.com live match URL or set CRICKET_MATCH_URL to a Cricbuzz URL',
    });
  }
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

    cache = { ts: Date.now(), sourceUrl, payload };
    return res.json(payload);
  } catch (error) {
    if (fallbackUrl && sourceUrl !== fallbackUrl) {
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
        cache = { ts: Date.now(), sourceUrl: fallbackUrl, payload };
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
    ? Math.min(Math.floor(requestedLimit), 100)
    : RUNNING_MATCH_LIMIT;

  if (runningMatchesCache.payload && now - runningMatchesCache.ts <= RUNNING_CACHE_TTL_MS) {
    return res.json({ ...runningMatchesCache.payload, cached: true });
  }

  try {
    let liveBoard = await fetchLiveAndUpcomingMatchesFromCricbuzz(limit);
    let running_matches = liveBoard.running_matches || [];
    let upcoming_matches = liveBoard.upcoming_matches || [];
    let disrupted_matches = liveBoard.disrupted_matches || [];
    let directSourceBoard = { running_matches: [], upcoming_matches: [], disrupted_matches: [] };

    if (!running_matches.length && !upcoming_matches.length && !disrupted_matches.length) {
      directSourceBoard = await buildFallbackBoardFromDirectSources();
      liveBoard = directSourceBoard;
      running_matches = liveBoard.running_matches || [];
      upcoming_matches = liveBoard.upcoming_matches || [];
      disrupted_matches = liveBoard.disrupted_matches || [];
    }

    running_matches = filterPlaceholderLiveMatches(dedupeMatchesBySource(running_matches));
    upcoming_matches = dedupeMatchesBySource(upcoming_matches);
    disrupted_matches = dedupeMatchesBySource(disrupted_matches);

    const legacyBoard = await fetchLegacyBoard();
    running_matches = dedupeMatchesBySource([
      ...legacyBoard.running_matches,
      ...running_matches,
    ]);
    running_matches = filterPlaceholderLiveMatches(running_matches);
    upcoming_matches = dedupeMatchesBySource([
      ...legacyBoard.upcoming_matches,
      ...upcoming_matches,
    ]);
    disrupted_matches = dedupeMatchesBySource([
      ...legacyBoard.disrupted_matches,
      ...disrupted_matches,
    ]);

    running_matches = sortRunningMatches(running_matches);
    upcoming_matches = sortUpcomingMatches(upcoming_matches);

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
    if (payload.total > 0) {
      runningMatchesCache = { ts: Date.now(), payload };
    }
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
