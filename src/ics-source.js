import ical from 'node-ical';

function extractText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'val' in value) return String(value.val);
  return String(value);
}

// node-ical marks all-day (VALUE=DATE) properties with a non-enumerable `dateOnly` flag
function toGoogleStyleDate(date) {
  if (date.dateOnly) {
    return { date: date.toISOString().split('T')[0] };
  }
  return { dateTime: date.toISOString() };
}

// Fetch and parse an external ICS feed (e.g. RVezy/RVshare/Outdoorsy booking export) into
// the same shape used for Google Calendar events elsewhere in this app. Recurring events
// are not expanded — booking calendars only ever emit one VEVENT per reservation.
export async function getEventsFromIcsUrl(url) {
  const data = await ical.async.fromURL(url, {
    headers: { 'User-Agent': 'calendar-sync/1.0' }
  });

  const events = [];
  for (const component of Object.values(data)) {
    if (component.type !== 'VEVENT' || !component.start) continue;

    const start = toGoogleStyleDate(component.start);
    const end = component.end ? toGoogleStyleDate(component.end) : start;

    events.push({
      id: component.uid,
      summary: extractText(component.summary) || 'Booking',
      description: extractText(component.description),
      location: extractText(component.location),
      status: (component.status || 'CONFIRMED').toLowerCase(),
      start,
      end
    });
  }

  return events;
}
