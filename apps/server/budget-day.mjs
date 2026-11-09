// The budget day follows the team's time zone (R14, local PR L24s). A team in Los Angeles has its day reset at local
// midnight, not at 4 pm; a daylight-saving day is 23 or 25 hours long. Days are calendar dates ('YYYY-MM-DD') in the
// team's IANA zone (budgets.time_zone, default UTC); instants stay UTC everywhere else.

const formats = new Map();
function format(tz) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formats.size > 500) formats.clear();
    formats.set(tz, f);
  }
  return f;
}

/** An IANA time zone this runtime knows ("Europe/Berlin", "UTC"), or null. */
export function timeZoneOf(v) {
  if (typeof v !== 'string' || v.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v)) return null;
  try { return Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone; } catch { return null; }
}

function parts(at, tz) {
  const o = {};
  for (const p of format(tz).formatToParts(at)) o[p.type] = p.value;
  return o;
}

/** The calendar day of instant `at` in `tz`. */
export function localDay(at, tz = 'UTC') {
  const p = parts(at instanceof Date ? at : new Date(at), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The calendar day after `day`. */
export function nextDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** How far `tz` is ahead of UTC at instant `ms`, in ms. */
function offset(ms, tz) {
  const p = parts(new Date(ms), tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant `day` starts in `tz`: its first moment at or after local midnight (a skipped midnight starts later). */
export function dayStart(day, tz = 'UTC') {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offset(wall, tz);
  t = wall - offset(t, tz);
  // A zone whose midnight is skipped by a clock change: the day starts at the first instant whose date is `day`.
  if (localDay(new Date(t), tz) !== day) t += 3_600_000;
  if (localDay(new Date(t - 1), tz) === day) t -= 3_600_000;
  return new Date(t);
}

/** [start, end) of `day` in `tz`, and its length in hours (23, 24 or 25 around daylight saving). */
export function dayBounds(day, tz = 'UTC') {
  const start = dayStart(day, tz), end = dayStart(nextDay(day), tz);
  return { start, end, hours: (end - start) / 3_600_000 };
}

/** The team's budget time zone (UTC when it has no budget yet). */
export async function teamZone(q, team) {
  const [b] = await q('select time_zone from budgets where team = $1', [team]);
  return b?.time_zone ?? 'UTC';
}
