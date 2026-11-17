// All "what day is it?" decisions use the Asia/Dubai timezone, wherever the server runs.

const TIME_ZONE = 'Asia/Dubai';

const dubaiParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

// Returns today's date in Dubai as "YYYY-MM-DD".
function todayInDubai(now = new Date()) {
  const parts = Object.fromEntries(dubaiParts.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// True only for real calendar dates written as "YYYY-MM-DD" (so 2026-02-30 is rejected).
function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Adds (or subtracts) whole days from a "YYYY-MM-DD" string.
function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

module.exports = { TIME_ZONE, todayInDubai, isValidDateString, addDays };
