'use strict';

// Old clients may submit a preferred local time without a zone. Keep those
// records readable, but never infer a zone from the server or operator device.
function demoRequestTime(input) {
  const preferredTime = String(input.preferredTime || '').trim();
  const preferredTimeZone = String(input.preferredTimeZone || '').trim();
  const preferredTimeUtc = String(input.preferredTimeUtc || '').trim();
  if (!preferredTimeZone && !preferredTimeUtc) return { fields: {} };
  const error = 'Choose a valid preferred meeting time and time zone';
  if (!preferredTime || !preferredTimeZone || !preferredTimeUtc || preferredTimeZone.length > 80) return { error };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(preferredTime)) return { error };
  const instant = new Date(preferredTimeUtc);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== preferredTimeUtc) return { error };
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: preferredTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(instant);
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const local = `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
    if (local !== preferredTime || instant.getUTCSeconds() || instant.getUTCMilliseconds()) return { error };
  } catch { return { error }; }
  return { fields: { preferredTimeZone, preferredTimeUtc } };
}

module.exports = { demoRequestTime };
