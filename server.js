require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Support both naming conventions
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE_CALLS;
// Reps live in the same base as meetings (override with REPS_BASE_ID if different)
const REPS_BASE_ID = process.env.REPS_BASE_ID || AIRTABLE_BASE_ID;
const MEETINGS_TABLE_NAME = process.env.MEETINGS_TABLE || 'All Booked Calls';
const REPS_TABLE_NAME = process.env.REPS_TABLE || 'Sales Team';

// ─── Startup check ────────────────────────────────────────────────────────────
if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('\n╔══════════════════════════════════════════════════════╗');
  console.error('║         MISSING ENVIRONMENT VARIABLES                ║');
  console.error('╠══════════════════════════════════════════════════════╣');
  console.error('║  Add to your .env file:                              ║');
  console.error('║                                                      ║');
  console.error('║  AIRTABLE_TOKEN=your_personal_access_token           ║');
  console.error('║  AIRTABLE_BASE_CALLS=appXXXXXX  (meetings base)      ║');
  console.error('║  AIRTABLE_BASE_DOMAIN=appXXXXXX (reps base)          ║');
  console.error('║                                                      ║');
  console.error('║  Then run: node server.js                            ║');
  console.error('╚══════════════════════════════════════════════════════╝\n');
  process.exit(1);
}

// ─── Airtable helpers ─────────────────────────────────────────────────────────

async function fetchAllRecords(tableName, baseId = AIRTABLE_BASE_ID) {
  const encodedTable = encodeURIComponent(tableName);
  let records = [];
  let offset = null;

  do {
    let url = `https://api.airtable.com/v0/${baseId}/${encodedTable}?pageSize=100`;
    if (offset) url += `&offset=${encodeURIComponent(offset)}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Airtable error for table "${tableName}" in base "${baseId}" (${res.status}): ${errBody}`);
    }

    const json = await res.json();
    records = records.concat(json.records || []);
    offset = json.offset || null;
  } while (offset);

  return records;
}

// ─── Data processing ──────────────────────────────────────────────────────────

function toDateStr(date) {
  // Returns YYYY-MM-DD in local time
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(dateA, dateB) {
  // Returns whole days between two dates (floor)
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((dateA - dateB) / msPerDay);
}

async function buildDashboardData() {
  // Fetch both tables in parallel (reps may be in a different base)
  const [meetingRecords, repRecords] = await Promise.all([
    fetchAllRecords(MEETINGS_TABLE_NAME, AIRTABLE_BASE_ID),
    fetchAllRecords(REPS_TABLE_NAME, REPS_BASE_ID)
  ]);

  // ── Build outbound reps map ────────────────────────────────────────────────
  const outboundReps = {}; // name -> { name, maxPerDay }
  for (const rec of repRecords) {
    const f = rec.fields || {};
    const type = (f['Type'] || '').trim();
    const status = (f['Status'] || '').trim();
    if (type === 'Outbound Direct' && status === 'Active') {
      const name = (f['Name'] || '').trim();
      const maxPerDay = Number(f['Max meetings per day']) || 0;
      if (name) {
        outboundReps[name] = { name, maxPerDay };
      }
    }
  }

  const outboundRepNames = new Set(Object.keys(outboundReps));
  const totalDailyCapacity = Object.values(outboundReps).reduce((s, r) => s + r.maxPerDay, 0);

  // ── Filter meetings to outbound reps only ─────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = toDateStr(today);

  const meetings = meetingRecords
    .map(rec => {
      const f = rec.fields || {};
      const rep = (f['Sales Rep'] || '').trim();
      const scheduledRaw = f['Call Scheduled Date'];
      const createdRaw = rec.createdTime || f['Created time'];
      const dealStatus = (f['Deal Status'] || '').trim();
      const dateDealClosed = f['Date Deal Closed'] || null;

      if (!scheduledRaw || !outboundRepNames.has(rep)) return null;

      const scheduledDate = new Date(scheduledRaw);
      const createdDate = createdRaw ? new Date(createdRaw) : null;
      const scheduledStr = toDateStr(scheduledDate);

      return { rep, scheduledDate, scheduledStr, createdDate, dealStatus, dateDealClosed };
    })
    .filter(Boolean);

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE 1 — Daily Meeting Count (next 10 days)
  // ═══════════════════════════════════════════════════════════════════════════

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const days10 = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dateStr = toDateStr(d);
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    days10.push({
      date: dateStr,
      dayOfWeek: dayNames[dow],
      isWeekend,
      booked: 0,
      capacity: isWeekend ? 0 : totalDailyCapacity,
      fillPct: 0
    });
  }

  const days10Map = {};
  days10.forEach(d => { days10Map[d.date] = d; });

  for (const m of meetings) {
    if (days10Map[m.scheduledStr]) {
      days10Map[m.scheduledStr].booked++;
    }
  }

  days10.forEach(d => {
    d.fillPct = d.capacity > 0 ? Math.round((d.booked / d.capacity) * 100) : 0;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE 2 — Rep Capacity Heat Map (next 10 days)
  // ═══════════════════════════════════════════════════════════════════════════

  const repBreakdown = Object.values(outboundReps)
    .map(rep => {
      // Count booked per day across the 10-day window
      const repDays = days10.map(d => {
        if (d.isWeekend) return { booked: 0, fillPct: 0, isWeekend: true };
        const booked = meetings.filter(m => m.rep === rep.name && m.scheduledStr === d.date).length;
        const fillPct = rep.maxPerDay > 0 ? Math.round((booked / rep.maxPerDay) * 100) : 0;
        return { booked, fillPct, isWeekend: false };
      });

      // Total fill % across weekdays only (for sort order)
      const weekdayDays = repDays.filter(d => !d.isWeekend);
      const totalBooked = weekdayDays.reduce((s, d) => s + d.booked, 0);
      const totalCap = weekdayDays.length * rep.maxPerDay;
      const totalFillPct = totalCap > 0 ? Math.round((totalBooked / totalCap) * 100) : 0;

      return { name: rep.name, maxPerDay: rep.maxPerDay, days: repDays, totalFillPct };
    })
    // Sort ascending by total fill % — emptiest reps at the top
    .sort((a, b) => a.totalFillPct - b.totalFillPct);

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE 3 — Proposal Hit Rate by Days-Out (30-day & 90-day)
  // ═══════════════════════════════════════════════════════════════════════════

  const PROPOSAL_STATUS = 'Call happened | Proposal Sent & I Updated Pipedrive';

  function buildHitRateTable(windowDays) {
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() - windowDays);

    const buckets = {};
    for (let i = 1; i <= 10; i++) {
      buckets[i] = { daysOut: i, total: 0, proposals: 0, closes: 0, hitRate: 0, closeRate: 0 };
    }

    for (const m of meetings) {
      // Only past meetings
      if (m.scheduledDate >= today) continue;
      // Within window
      if (m.scheduledDate < cutoff) continue;
      // Need createdDate to compute days-out
      if (!m.createdDate) continue;

      const daysOut = daysBetween(m.scheduledDate, m.createdDate);
      const capped = Math.max(1, Math.min(10, daysOut));

      buckets[capped].total++;
      if (m.dealStatus === PROPOSAL_STATUS) {
        buckets[capped].proposals++;
      }
      if (m.dateDealClosed) {
        buckets[capped].closes++;
      }
    }

    return Object.values(buckets).map(b => ({
      ...b,
      hitRate:   b.total > 0 ? Math.round((b.proposals / b.total) * 100) : 0,
      closeRate: b.total > 0 ? Math.round((b.closes    / b.total) * 100) : 0
    }));
  }

  const hitRate30 = buildHitRateTable(30);
  const hitRate90 = buildHitRateTable(90);

  // ── Booking Recommendation (powers M3 banner) ──────────────────────────────
  // Optimal cutoff: last day BEFORE a SUSTAINED drop below 15%.
  // A single dip doesn't count — the drop must hold for 2+ consecutive days.
  // Uses 30-day hit rate data only.

  // Step 1: find the first index where hitRate30[i] < 15 AND hitRate30[i+1] < 15
  let sustainedDropIdx = -1;
  for (let i = 0; i < hitRate30.length - 1; i++) {
    if (hitRate30[i].hitRate < 15 && hitRate30[i + 1].hitRate < 15) {
      sustainedDropIdx = i;
      break;
    }
  }

  // Step 2: cutoff = day before the drop, or last day if no drop found, or 0 if drop starts at day 1
  let optimalCutoff;
  if (sustainedDropIdx < 0) {
    // No sustained drop found — use the last day
    optimalCutoff = hitRate30[hitRate30.length - 1].daysOut;
  } else if (sustainedDropIdx === 0) {
    // Drop starts immediately at day 1 — no usable window
    optimalCutoff = 0;
  } else {
    optimalCutoff = hitRate30[sustainedDropIdx - 1].daysOut;
  }

  // Best hit rate row (for banner callout) — from 30d data only
  let bestHitRateRow = hitRate30[0];
  for (const b of hitRate30) {
    if (b.hitRate > bestHitRateRow.hitRate) bestHitRateRow = b;
  }

  // Capacity and bookings from day 2 through cutoff (today+1 skipped as unbookable)
  let recCap = 0, recBooked = 0;
  for (let i = 2; i <= Math.max(optimalCutoff, 2); i++) {
    if (i > optimalCutoff) break;
    const d = new Date(today); d.setDate(today.getDate() + i);
    const dStr = toDateStr(d);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    if (!isWeekend) recCap += totalDailyCapacity;
    recBooked += meetings.filter(m => m.scheduledStr === dStr).length;
  }

  const recOpenSlots = Math.max(0, recCap - recBooked);
  const recFirstD = new Date(today); recFirstD.setDate(today.getDate() + 2);
  const recLastD  = new Date(today); recLastD.setDate(today.getDate() + (optimalCutoff || 2));
  const MONTHS_B = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const recWindowStr = optimalCutoff >= 2
    ? `${MONTHS_B[recFirstD.getMonth()]} ${recFirstD.getDate()} → ${MONTHS_B[recLastD.getMonth()]} ${recLastD.getDate()}`
    : 'N/A';

  const bookingRec = {
    optimalCutoff,
    meetingsToBook: recOpenSlots,
    windowStr: recWindowStr,
    bestDaysOut:   bestHitRateRow ? bestHitRateRow.daysOut   : 0,
    bestHitRate:   bestHitRateRow ? bestHitRateRow.hitRate   : 0,
    bestCloseRate: bestHitRateRow ? bestHitRateRow.closeRate : 0,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE 4 — Meetings Needed Today to Fill Future Capacity
  // ═══════════════════════════════════════════════════════════════════════════

  // For each horizon N (2..10), look at days: today+1 through today+(N-1)
  // Wait — re-reading: "for the next 2 days" likely means tomorrow + day after
  // "next N days" = the N days starting from tomorrow
  const meetingsNeeded = [];

  const shortDayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  for (let n = 2; n <= 10; n++) {
    let totalCapacity = 0;
    let totalBooked = 0;
    let hasWeekend = false;
    const dayLog = [];

    // Start from day 2 — today (0) and tomorrow (1) are excluded as too close to book
    for (let i = 2; i <= n; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dow = d.getDay();
      const dStr = toDateStr(d);
      const isWeekend = dow === 0 || dow === 6;
      if (isWeekend) hasWeekend = true;
      const dayBooked = meetings.filter(m => m.scheduledStr === dStr).length;
      const dayCapacity = isWeekend ? 0 : totalDailyCapacity;
      totalCapacity += dayCapacity;
      totalBooked += dayBooked;
      dayLog.push(`  day${i}: ${dStr} (${shortDayNames[dow]}) cap=${dayCapacity} booked=${dayBooked}`);
    }

    console.log(`[M4 n=${n}] dates: ${dayLog.map(l => l.trim()).join(' | ')} => cap=${totalCapacity} booked=${totalBooked} open=${totalCapacity - totalBooked}`);

    // First day is day 2 (day after tomorrow), last is day n
    const firstD = new Date(today); firstD.setDate(today.getDate() + 2);
    const lastD  = new Date(today); lastD.setDate(today.getDate() + n);
    const firstDayName = shortDayNames[firstD.getDay()];
    const lastDayName  = shortDayNames[lastD.getDay()];

    const openSlots = totalCapacity - totalBooked;
    meetingsNeeded.push({ horizon: n, totalCapacity, totalBooked, openSlots, hasWeekend, firstDayName, lastDayName });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE 5 — This Week at a Glance (Mon–Fri of current week)
  // ═══════════════════════════════════════════════════════════════════════════

  const dow0 = today.getDay(); // 0=Sun
  const daysToMon = dow0 === 0 ? -6 : 1 - dow0;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMon);

  const weekDateStrs = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    weekDateStrs.push(toDateStr(d));
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const weekLabel = `${MONTHS[monday.getMonth()]} ${monday.getDate()} – ${MONTHS[friday.getMonth()]} ${friday.getDate()}`;

  const weekRepStats = Object.values(outboundReps).map(rep => {
    const booked = meetings.filter(m => m.rep === rep.name && weekDateStrs.includes(m.scheduledStr)).length;
    const capacity = weekDateStrs.length * rep.maxPerDay;
    const fillPct = capacity > 0 ? Math.round((booked / capacity) * 100) : 0;
    return { name: rep.name, booked, capacity, fillPct };
  });

  const totalWeekBooked = weekRepStats.reduce((s, r) => s + r.booked, 0);
  const totalWeekCap = weekRepStats.reduce((s, r) => s + r.capacity, 0);
  const sortedByFill = [...weekRepStats].sort((a, b) => a.fillPct - b.fillPct);

  const thisWeek = {
    weekLabel,
    teamFillPct: totalWeekCap > 0 ? Math.round((totalWeekBooked / totalWeekCap) * 100) : 0,
    openSlots: totalWeekCap - totalWeekBooked,
    totalBooked: totalWeekBooked,
    totalCapacity: totalWeekCap,
    emptiestRep: sortedByFill[0] ? { name: sortedByFill[0].name, fillPct: sortedByFill[0].fillPct } : null,
    fullestRep: sortedByFill[sortedByFill.length - 1] ? { name: sortedByFill[sortedByFill.length - 1].name, fillPct: sortedByFill[sortedByFill.length - 1].fillPct } : null
  };

  return {
    generatedAt: new Date().toISOString(),
    todayStr,
    totalDailyCapacity,
    outboundRepCount: Object.keys(outboundReps).length,
    thisWeek,
    module1: { days: days10 },
    module2: { reps: repBreakdown },
    module3: { hitRate30, hitRate90, bookingRec },
    module4: { meetingsNeeded }
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let cache = { data: null, lastFetched: null, error: null };
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function refreshCache() {
  try {
    console.log(`[${new Date().toISOString()}] Refreshing Airtable data...`);
    const data = await buildDashboardData();
    cache = { data, lastFetched: Date.now(), error: null };
    console.log(`[${new Date().toISOString()}] Data refreshed. ${data.outboundRepCount} outbound reps found.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Refresh failed:`, err.message);
    cache.error = err.message;
  }
}

// Initial load then schedule
refreshCache();
setInterval(refreshCache, CACHE_TTL_MS);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  if (req.query.refresh === '1') {
    await refreshCache();
  }

  if (cache.error && !cache.data) {
    return res.status(500).json({ error: cache.error });
  }

  res.json({
    ...cache.data,
    cacheAge: cache.lastFetched ? Math.round((Date.now() - cache.lastFetched) / 1000) : null,
    error: cache.error || null
  });
});

// Health check — used by Railway and uptime monitors
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Keep the old path working too
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), lastFetched: cache.lastFetched });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║       Outbound Dashboard — Server Running            ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Open: http://localhost:${PORT}                         ║`);
  console.log('║  Data refreshes automatically every 60 seconds       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
});
