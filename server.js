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

// Returns last N completed business days before refDate, newest first
function getLastNBusinessDays(n, refDate) {
  const days = [];
  let d = new Date(refDate);
  while (days.length < n) {
    d = new Date(d);
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(toDateStr(d));
  }
  return days;
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

  // Log every rep fetched so we can verify all are present
  console.log(`[Reps] ${Object.keys(outboundReps).length} Outbound Direct reps fetched: ${Object.keys(outboundReps).join(', ')}`);

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
      // Need createdDate to compute days-out bucket for all metrics
      if (!m.createdDate) continue;

      const daysOut = daysBetween(m.scheduledDate, m.createdDate);
      const capped = Math.max(1, Math.min(10, daysOut));

      // Total meetings & proposals: Call Scheduled Date within window (past only)
      if (m.scheduledDate < today && m.scheduledDate >= cutoff) {
        buckets[capped].total++;
        if (m.dealStatus === PROPOSAL_STATUS) {
          buckets[capped].proposals++;
        }
      }

      // Closes: Date Deal Closed falls within the window (not scheduled date)
      // Denominator will be proposals in the same bucket (close rate = closes / proposals)
      if (m.dateDealClosed) {
        const closeDate = new Date(m.dateDealClosed);
        if (closeDate >= cutoff && closeDate < today) {
          buckets[capped].closes++;
        }
      }
    }

    return Object.values(buckets).map(b => ({
      ...b,
      hitRate:   b.total     > 0 ? Math.round((b.proposals / b.total)     * 100) : 0,
      closeRate: b.proposals > 0 ? Math.round((b.closes    / b.proposals) * 100) : 0,
    }));
  }

  const hitRate30 = buildHitRateTable(30);
  const hitRate90 = buildHitRateTable(90);

  // ── Close Rate Sanity Check ───────────────────────────────────────────────
  const sanity30 = hitRate30.reduce((acc, b) => {
    acc.proposals += b.proposals;
    acc.closes    += b.closes;
    return acc;
  }, { proposals: 0, closes: 0 });
  const sanityBlended = sanity30.proposals > 0
    ? ((sanity30.closes / sanity30.proposals) * 100).toFixed(1)
    : '0.0';
  console.log('=== Close Rate Sanity Check (Last 30 days) ===');
  console.log(`  Total proposals across all buckets : ${sanity30.proposals}`);
  console.log(`  Total closes across all buckets    : ${sanity30.closes}`);
  console.log(`  Blended close rate                 : ${sanityBlended}%`);
  console.log(`  Expected from Airtable             : ~114 proposals, ~13 closes, ~11.4%`);
  console.log('==============================================');

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

  // Best hit rate row — 90d data, minimum 3d out (never show 1d or 2d as best)
  let bestHitRateRow = hitRate90.find(b => b.daysOut >= 3 && b.total > 0) || hitRate90[2];
  for (const b of hitRate90) {
    if (b.daysOut >= 3 && b.total > 0 && b.hitRate > bestHitRateRow.hitRate) bestHitRateRow = b;
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
  // RUNWAY & ABSENCE DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  // Group meetings by booking date (Airtable record creation time = when call was booked)
  const bookingsByDateRep = {}; // dateStr -> repName -> count
  const bookingsByDate    = {}; // dateStr -> total count

  for (const m of meetings) {
    if (!m.createdDate) continue;
    const bDate = toDateStr(m.createdDate);
    bookingsByDate[bDate] = (bookingsByDate[bDate] || 0) + 1;
    if (!bookingsByDateRep[bDate]) bookingsByDateRep[bDate] = {};
    bookingsByDateRep[bDate][m.rep] = (bookingsByDateRep[bDate][m.rep] || 0) + 1;
  }

  const last5BizDays = getLastNBusinessDays(5, today);

  // Absence rule: look ONLY at the last 5 completed business days (never today).
  // If a rep has 0 bookings on 2+ of those days where team total > 0 → ABSENT.
  // 1 absent day → NO-CALL DAY. 0 absent days → ACTIVE.
  // If rep books anything today, they are immediately restored to active.
  const absenceCheckDays = [...last5BizDays];

  // Per-rep absence flags
  const repAbsentDays   = {}; // repName -> Set<dateStr>
  const repStatus       = {}; // repName -> 'active' | 'absent' | 'nocall'
  const repNoCallWkday  = {}; // repName -> dayName e.g. 'Monday'

  // Debug: log per-rep per-day breakdown to confirm rule is firing correctly
  console.log('=== Absence check window ===');
  console.log(`  today=${todayStr}  checking last 5 completed biz days: [${absenceCheckDays.join(',')}]`);
  for (const repName of outboundRepNames) {
    const perDay = absenceCheckDays.map(d => {
      const teamTot = bookingsByDate[d] || 0;
      const repTot  = (bookingsByDateRep[d] || {})[repName] || 0;
      return `${d}:rep=${repTot},team=${teamTot}`;
    });
    console.log(`  ${repName}: ${perDay.join(' | ')}`);
  }
  console.log('============================');

  for (const repName of outboundRepNames) {
    const absent = new Set();
    for (const date of absenceCheckDays) {
      const teamTotal = bookingsByDate[date] || 0;
      const repTotal  = (bookingsByDateRep[date] || {})[repName] || 0;
      if (teamTotal > 0 && repTotal === 0) absent.add(date);
    }
    repAbsentDays[repName] = absent;

    // If rep booked anything today, they are active regardless of prior pattern
    const todayRepBookings = (bookingsByDateRep[todayStr] || {})[repName] || 0;
    if (todayRepBookings > 0) {
      repStatus[repName] = 'active';
    } else if (absent.size >= 2) {
      // 2+ absent days out of last 5 completed days: ABSENT
      repStatus[repName] = 'absent';
    } else if (absent.size === 1) {
      // Exactly one isolated absent day: NO-CALL DAY (e.g. scheduled off every Monday)
      repStatus[repName] = 'nocall';
      const absentDateStr = [...absent][0];
      const dTmp = new Date(absentDateStr + 'T12:00:00');
      repNoCallWkday[repName] = dayNames[dTmp.getDay()];
    } else {
      repStatus[repName] = 'active';
    }
  }

  // teamAvgPerDay: bookings by booking date across last 3 completed biz days
  const last3BizDays = last5BizDays.slice(0, 3);
  const totalBookingsLast3 = last3BizDays.reduce((s, d) => s + (bookingsByDate[d] || 0), 0);
  const teamAvgPerDay = Math.round((totalBookingsLast3 / 3) * 10) / 10;

  // Next 10 bookable business days — start from day+2 (today and tomorrow are never bookable)
  const next10BizDays = [];
  for (let i = 2; next10BizDays.length < 10; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    if (d.getDay() !== 0 && d.getDay() !== 6) next10BizDays.push(toDateStr(d));
  }

  function repAvailableOnDate(repName, dateStr) {
    if (repStatus[repName] === 'absent') return false;
    if (repStatus[repName] === 'nocall') {
      const noCallDay = repNoCallWkday[repName];
      if (noCallDay) {
        const d = new Date(dateStr + 'T12:00:00');
        if (dayNames[d.getDay()] === noCallDay) return false;
      }
    }
    return true;
  }

  // Per-day slot breakdown (logged for debugging)
  const perDaySlots = []; // { dateStr, calDays, rawOpen, adjOpen, repDetail }
  for (let i = 2; perDaySlots.length < 10; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const dateStr = toDateStr(d);
    let rawOpen = 0, adjOpen = 0;
    const repDetail = [];
    for (const repName of outboundRepNames) {
      const rep       = outboundReps[repName];
      const repBooked = meetings.filter(m => m.rep === repName && m.scheduledStr === dateStr).length;
      const open      = Math.max(0, rep.maxPerDay - repBooked);
      const avail     = repAvailableOnDate(repName, dateStr);
      rawOpen += open;
      if (avail) adjOpen += open;
      repDetail.push(`${repName}:${repBooked}/${rep.maxPerDay}(${repStatus[repName]||'active'})`);
    }
    perDaySlots.push({ dateStr, calDays: i, rawOpen, adjOpen, repDetail });
  }

  console.log('=== Runway slot breakdown ===');
  console.log(`  teamAvgPerDay=${teamAvgPerDay}  last3BizDays=${last3BizDays.join(',')}`);
  console.log(`  absences: ${Object.entries(repStatus).filter(([,s])=>s!=='active').map(([n,s])=>`${n}=${s}`).join(', ')||'none'}`);
  perDaySlots.forEach(d => {
    console.log(`  ${d.dateStr} (calDays=${d.calDays}): rawOpen=${d.rawOpen} adjOpen=${d.adjOpen} | ${d.repDetail.join(' ')}`);
  });

  let rawOpenSlots = 0;
  let absenceAdjustedSlots = 0;
  for (const { rawOpen, adjOpen } of perDaySlots) {
    rawOpenSlots        += rawOpen;
    absenceAdjustedSlots += adjOpen;
  }
  console.log(`  totals: rawOpenSlots=${rawOpenSlots} absenceAdjustedSlots=${absenceAdjustedSlots}`);

  // daysBookedOut: simulate today's booking budget (teamAvgPerDay) filling slots
  // from the first bookable day forward. Stop when the daily budget is exhausted.
  // Result = calendar-day distance from today to the furthest date the team fills today.
  let daysBookedOut = 0;
  if (teamAvgPerDay <= 0) {
    daysBookedOut = absenceAdjustedSlots > 0 ? 99 : 0;
  } else {
    let budget = teamAvgPerDay; // today's booking capacity
    for (const day of perDaySlots) {
      if (day.adjOpen <= 0) continue; // skip fully-booked days
      const fill = Math.min(day.adjOpen, budget);
      budget -= fill;
      daysBookedOut = day.calDays; // horizon = furthest date reached
      if (budget <= 0) break;     // budget spent — stop here
    }
    // If budget still has capacity after all 10 days, horizon = last non-empty day's calDays
    // (daysBookedOut already set to the furthest non-zero day from the loop above)
  }
  console.log(`  daysBookedOut=${daysBookedOut}`);
  console.log('=== End runway ===');

  // Peak runway metrics — for header runway pill
  const peakDaysOut = bestHitRateRow ? bestHitRateRow.daysOut : 0;
  const peakTrueRate = (bestHitRateRow && bestHitRateRow.proposals > 0)
    ? parseFloat(((bestHitRateRow.hitRate / 100) * (bestHitRateRow.closeRate / 100) * 100).toFixed(1)) : 0;
  const clampedDbo = Math.max(1, Math.min(10, daysBookedOut || 1));
  const currentRow90 = hitRate90.find(b => b.daysOut === clampedDbo) || hitRate90[0];
  const currentTrueRate = (currentRow90 && currentRow90.proposals > 0)
    ? parseFloat(((currentRow90.hitRate / 100) * (currentRow90.closeRate / 100) * 100).toFixed(1)) : 0;
  const meetingsToReachPeak = (daysBookedOut >= peakDaysOut || !peakDaysOut) ? 0
    : perDaySlots
        .filter(d => d.calDays > daysBookedOut && d.calDays <= peakDaysOut)
        .reduce((s, d) => s + d.adjOpen, 0);

  // Book Today count: meetings to book today to stay in green zone (≤6 days runway)
  const next6BizDays = next10BizDays.slice(0, 6);
  const bookedInNext6 = next6BizDays.reduce(
    (s, dateStr) => s + meetings.filter(m => m.scheduledStr === dateStr).length,
    0
  );
  const bookTodayCount = Math.max(0, Math.round(6 * teamAvgPerDay) - bookedInNext6);

  const absentRepNames = [];
  const perRepStatus = Object.values(outboundReps).map(rep => {
    const status  = repStatus[rep.name] || 'active';
    const last3Bk = last3BizDays.reduce((s, d) => s + ((bookingsByDateRep[d] || {})[rep.name] || 0), 0);
    if (status === 'absent') absentRepNames.push(rep.name);
    return {
      name: rep.name,
      status,
      avgPerDay: Math.round((last3Bk / 3) * 10) / 10,
      noCallWeekday: repNoCallWkday[rep.name] || null,
    };
  });

  const runway = {
    teamAvgPerDay,
    absenceAdjustedSlots,
    rawOpenSlots,
    daysBookedOut,
    peakDaysOut,
    peakTrueRate,
    currentTrueRate,
    meetingsToReachPeak,
    activeReps:  perRepStatus.filter(r => r.status === 'active').length,
    totalReps:   Object.keys(outboundReps).length,
    absentReps:  absentRepNames,
    perRepStatus,
    bookTodayCount,
    bookedInNext6,
  };

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

  // Show Rate Today — meetings scheduled today with any Deal Status set
  const showRateTotal    = meetings.filter(m => m.scheduledStr === todayStr).length;
  const showRateHappened = meetings.filter(m => m.scheduledStr === todayStr && m.dealStatus).length;

  return {
    generatedAt: new Date().toISOString(),
    todayStr,
    totalDailyCapacity,
    outboundRepCount: Object.keys(outboundReps).length,
    thisWeek,
    module1: { days: days10 },
    module2: { reps: repBreakdown },
    module3: { hitRate30, hitRate90, bookingRec, sanity30: { ...sanity30, blendedCloseRate: parseFloat(sanityBlended) } },
    runway,
    showRateTotal,
    showRateHappened,
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

// Serve the Sales Command Center dashboard directly from the project root
// so edits to sales_command_center.html are live without any copy step.
app.get('/sales_command_center.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'sales_command_center.html'));
});

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

app.get('/api/runway', (req, res) => {
  if (cache.error && !cache.data) {
    return res.status(500).json({ error: cache.error });
  }
  if (!cache.data || !cache.data.runway) {
    return res.status(503).json({ error: 'Runway data not yet available' });
  }
  res.json({
    ...cache.data.runway,
    generatedAt: cache.data.generatedAt,
    cacheAge: cache.lastFetched ? Math.round((Date.now() - cache.lastFetched) / 1000) : null,
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
  console.log('================================');
  console.log('TV URL: https://outbound-dashboard-production-52f3.up.railway.app/?tv=1');
  console.log('================================\n');
});
