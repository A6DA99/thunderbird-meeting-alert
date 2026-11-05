/* Pure meeting detection logic: testable in Node and usable in Thunderbird. */
(function (root, factory) {
  const api = factory();
  root.MeetingParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function decodeEntities(s) {
    return String(s || "")
      .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'").replace(/&nbsp;/gi, " ")
      .replace(/&middot;/gi, "·").replace(/&ndash;/gi, "–")
      .replace(/&mdash;/gi, "—")
      .replace(/&#(\d+);/g, (_, n) => {
        const value = Number(n);
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
      });
  }

  function toText(html) {
    return decodeEntities(String(html || "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " "));
  }

  function validMeetingLink(raw) {
    try {
      const url = new URL(decodeEntities(raw).replace(/[),.;!?]+$/g, ""));
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const h = url.hostname.toLowerCase();
      const p = url.pathname.toLowerCase();
      const allowed =
        (h === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(p)) ||
        ((h === "zoom.us" || h.endsWith(".zoom.us")) && /^\/(j\/|my\/|wc\/join\/)/.test(p)) ||
        ((h === "teams.microsoft.com" || h === "teams.live.com") && /^\/(l\/meetup-join\/|meet\/)/.test(p)) ||
        ((h === "webex.com" || h.endsWith(".webex.com")) && /^\/(meet\/|join\/|webappng\/sites\/)/.test(p)) ||
        (h === "meet.goto.com" && p.length > 1) ||
        (h === "whereby.com" && p.length > 1);
      return allowed ? url.href : null;
    } catch { return null; }
  }

  function findMeetingLinks(input) {
    const out = new Set();
    const text = decodeEntities(input);
    // Also finds links inside HTML href attributes; only known meeting domains pass.
    const rx = /https:\/\/[^\s<>"'\]]+/gi;
    for (const match of text.matchAll(rx)) {
      const valid = validMeetingLink(match[0]);
      if (valid) out.add(valid);
    }
    return [...out];
  }

  // Pulls the human-readable passcode and meeting ID out of invitation text.
  // (Zoom's ?pwd= URL token is an encoded hash, not the passcode people type, so it is ignored.)
  function extractAccessDetails(input) {
    const text = toText(decodeEntities(input)).replace(/\s+/g, " ");
    const notPasscode = /^(?:is|are|will|required|not|none|n\/a|needed|optional|and|or|the|to|for|if|your|click|link|see|below|above)$/i;
    let passcode = null;
    const pass = /\b(?:passcode|pass\s*code|password|passkey)\s*(?:is\s*)?[:=\-–]\s*["'“]?([^\s"'”<>]{3,40})/gi;
    for (const m of text.matchAll(pass)) {
      const value = m[1].replace(/[),.;!?]+$/g, "");
      if (value.length >= 3 && !notPasscode.test(value)) { passcode = value; break; }
    }
    if (!passcode) {
      for (const m of text.matchAll(/\b(?:passcode|password)\s+is\s+["'“]?([^\s"'”<>]{3,40})/gi)) {
        const value = m[1].replace(/[),.;!?]+$/g, "");
        if (value.length >= 3 && !notPasscode.test(value)) { passcode = value; break; }
      }
    }
    let meetingId = null;
    const id = /\bmeeting\s*id\s*[:=\-–]?\s*(\d[\d ]{6,18}\d)/i.exec(text);
    if (id) meetingId = id[1].trim();
    return { passcode, meetingId };
  }

  function validParts(y, m, d, h, min) {
    const date = new Date(Date.UTC(y, m, d, h, min));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m &&
      date.getUTCDate() === d && date.getUTCHours() === h &&
      date.getUTCMinutes() === min;
  }

  function localISO(y, m, d, h, min) {
    if (!validParts(y, m, d, h, min)) return null;
    const date = new Date(y, m, d, h, min);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function ianaISO(y, m, d, h, min, tzid) {
    if (!validParts(y, m, d, h, min)) return null;
    try {
      const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: tzid, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      });
      const target = Date.UTC(y, m, d, h, min);
      let guess = target;
      for (let i = 0; i < 3; i++) {
        const fields = Object.fromEntries(formatter.formatToParts(new Date(guess))
          .filter(part => part.type !== "literal")
          .map(part => [part.type, Number(part.value)]));
        const observed = Date.UTC(fields.year, fields.month - 1, fields.day,
          fields.hour, fields.minute, fields.second);
        const delta = target - observed;
        guess += delta;
        if (delta === 0) break;
      }
      const fields = Object.fromEntries(formatter.formatToParts(new Date(guess))
        .filter(part => part.type !== "literal")
        .map(part => [part.type, Number(part.value)]));
      if (fields.year !== y || fields.month !== m + 1 || fields.day !== d ||
          fields.hour !== h || fields.minute !== min) return null;
      return new Date(guess).toISOString();
    } catch { return null; }
  }

  function parseICSDate(raw, tzid) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(raw || "");
    if (!match) return null; // All-day dates aren't scheduled as timed meetings.
    const [, yy, mm, dd, hh, mi, , z] = match;
    const y = +yy, m = +mm - 1, d = +dd, h = +hh, minute = +mi;
    if (!validParts(y, m, d, h, minute)) return null;
    if (z) return { iso: new Date(Date.UTC(y, m, d, h, minute)).toISOString(), review: false };
    if (tzid) {
      const iso = ianaISO(y, m, d, h, minute, tzid);
      return iso ? { iso, review: false } : { iso: localISO(y, m, d, h, minute), review: true };
    }
    return { iso: localISO(y, m, d, h, minute), review: true };
  }

  function unescapeICS(s) {
    return String(s || "").replace(/\\n/gi, "\n").replace(/\\,/g, ",")
      .replace(/\\;/g, ";").replace(/\\\\/g, "\\");
  }

  function property(lines, name) {
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const spec = line.slice(0, colon).split(";");
      if (spec[0].toUpperCase() !== name) continue;
      const tz = spec.find(s => /^TZID=/i.test(s));
      return { value: unescapeICS(line.slice(colon + 1)),
        tzid: tz ? tz.slice(5).replace(/^"|"$/g, "") : null };
    }
    return null;
  }

  function parseICS(content, otherLinks) {
    const text = String(content || "").replace(/\r?\n[ \t]/g, "");
    const output = [];
    for (const match of text.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/gi)) {
      const lines = match[1].split(/\r?\n/);
      const start = property(lines, "DTSTART");
      const date = start && parseICSDate(start.value, start.tzid);
      const uid = property(lines, "UID")?.value || null;
      const recurrence = property(lines, "RECURRENCE-ID")?.value || "";
      const title = property(lines, "SUMMARY")?.value || "Meeting";
      const status = property(lines, "STATUS")?.value?.toUpperCase() || "";
      const combined = [property(lines, "URL")?.value,
        property(lines, "LOCATION")?.value, property(lines, "DESCRIPTION")?.value].join("\n");
      const link = findMeetingLinks(combined)[0] || otherLinks[0];
      if (!link || (!date?.iso && status !== "CANCELLED")) continue;
      const access = extractAccessDetails(combined);
      output.push({ uid, recurrence, title, startIso: date?.iso || null,
        joinUrl: link, passcode: access.passcode, meetingId: access.meetingId,
        needsReview: date?.review || false,
        cancelled: status === "CANCELLED", source: "calendar invitation" });
    }
    return output;
  }

  function dateWithZone(y, month, day, hour, minute, context) {
    if (!validParts(y, month, day, hour, minute)) return null;
    const nearby = decodeEntities(context || "");
    const zoneByName = [
      [/\b(?:India Standard Time|Asia\/Kolkata|IST)\b/i, "Asia/Kolkata"],
      [/\b(?:Eastern Time|America\/New_York)\b/i, "America/New_York"],
      [/\b(?:Pacific Time|America\/Los_Angeles)\b/i, "America/Los_Angeles"],
      [/\b(?:Central Time|America\/Chicago)\b/i, "America/Chicago"],
      [/\b(?:British Summer Time|Europe\/London)\b/i, "Europe/London"]
    ];
    for (const [pattern, zone] of zoneByName) {
      if (pattern.test(nearby)) return ianaISO(y, month, day, hour, minute, zone);
    }
    const offset = /\b(?:GMT|UTC)\s*([+-])(\d{1,2}):?(\d{2})\b/i.exec(nearby);
    if (offset) {
      const mins = Number(offset[2]) * 60 + Number(offset[3]);
      if (mins > 14 * 60 || Number(offset[3]) >= 60) return null;
      const adjustment = (offset[1] === "+" ? 1 : -1) * mins;
      return new Date(Date.UTC(y, month, day, hour, minute) - adjustment * 60000).toISOString();
    }
    if (/\b(?:GMT|UTC|Z)\b/i.test(nearby))
      return new Date(Date.UTC(y, month, day, hour, minute)).toISOString();
    return localISO(y, month, day, hour, minute);
  }

  function parseStructuredDate(value) {
    const date = String(value || "").trim();
    if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/i.test(date)) return null;
    const millis = Date.parse(date);
    if (!Number.isFinite(millis)) return null;
    return { iso: new Date(millis).toISOString(),
      review: !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(date) };
  }

  function htmlDateCandidate(html) {
    const text = decodeEntities(html);
    // Google Calendar / schema.org email markup can contain a genuine event start.
    let genericTime = null;
    for (const tag of text.match(/<(?:meta|time)\b[^>]*>/gi) || []) {
      const isEvent = /(?:itemprop|property|data-field)\s*=\s*["'](?:startDate|eventStart|startTime)["']/i.test(tag);
      const attribute = /(?:datetime|content)\s*=\s*["']([^"']+)["']/i.exec(tag);
      const parsed = attribute && parseStructuredDate(attribute[1]);
      if (parsed && isEvent) return parsed;
      if (parsed && /^<time\b/i.test(tag) && !genericTime) genericTime = { ...parsed, review: true };
    }
    for (const match of text.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const nodes = JSON.parse(match[1]);
        const candidates = Array.isArray(nodes) ? nodes : [nodes];
        for (const candidate of candidates) {
          if (!/(^|\/)Event$/i.test(String(candidate["@type"] || ""))) continue;
          const parsed = parseStructuredDate(candidate.startDate);
          if (parsed) return parsed;
        }
      } catch { /* Ignore malformed embedded metadata. */ }
    }
    return genericTime;
  }

  function calendarLinkDateCandidate(content) {
    for (const match of String(content || "").matchAll(/https:\/\/calendar\.google\.com\/[^\s<>"']+/gi)) {
      try {
        const url = new URL(decodeEntities(match[0]));
        if (url.searchParams.get("action")?.toUpperCase() !== "TEMPLATE") continue;
        const start = url.searchParams.get("dates")?.split("/")[0];
        const timezone = url.searchParams.get("stz") || null;
        const date = start && parseICSDate(start, timezone);
        if (date?.iso) return date;
      } catch { /* Ignore malformed links. */ }
    }
    return null;
  }

  function extractStartTime(tail) {
    const cleaned = String(tail || "").replace(/^[\s,.:;·•|\-–—]+/, "")
      .replace(/^(?:at|from|time|starts?|start time)\s*:?\s*/i, "")
      .replace(/^[\s,.:;·•|\-–—]+/, "");
    const start = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\b/i.exec(cleaned);
    if (!start) return null;
    let hour = +start[1];
    const minute = +(start[2] || 0);
    let ampm = start[3] || null;
    const explicitlyTimed = Boolean(start[3]) || (Boolean(start[2]) && hour > 12);
    const rangeTail = cleaned.slice(start[0].length);
    const end = /^\s*(?:[-–—]|to)\s*(\d{1,2})(?::\d{2})?\s*(AM|PM)\b/i.exec(rangeTail);
    if (!ampm && end) {
      // "3:00 – 4:00pm" uses the end's meridiem for the start.
      ampm = end[2];
      if (end[2].toUpperCase() === "PM" &&
          ((+end[1] === 12 && +start[1] < 12) || +start[1] > +end[1]))
        ampm = "AM";
      if (end[2].toUpperCase() === "AM" && +start[1] > +end[1]) ampm = "PM";
    }
    if (!ampm && !start[2]) return null; // "Nov 5 3" isn't a trustworthy time.
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      hour = hour % 12 + (ampm.toUpperCase() === "PM" ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, explicitlyTimed };
  }

  function textDateCandidate(input, receivedAt = new Date()) {
    const text = toText(input).replace(/\s+/g, " ");
    const monthName = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
    const patterns = [
      { kind: "iso", rx: /\b(20\d{2})-(\d{2})-(\d{2})\b/g },
      { kind: "month", rx: new RegExp(`\\b(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "gi") },
      { kind: "day", rx: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthName})(?:,?\\s+(20\\d{2}))?\\b`, "gi") }
    ];
    const matches = [];
    for (const { kind, rx } of patterns)
      for (const match of text.matchAll(rx)) matches.push({ kind, match });
    matches.sort((a, b) => a.match.index - b.match.index);
    const base = new Date(receivedAt);
    const reference = Number.isFinite(base.getTime()) ? base : new Date();
    for (const { kind, match } of matches) {
      const month = kind === "iso" ? +match[2] - 1 :
        MONTHS[(kind === "month" ? match[1] : match[2]).slice(0, 3).toLowerCase()];
      const day = +(kind === "day" ? match[1] : kind === "iso" ? match[3] : match[2]);
      const hasYear = Boolean(kind === "iso" || match[3]);
      let year = hasYear ? +(kind === "iso" ? match[1] : match[3]) : reference.getFullYear();
      const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 160);
      const time = extractStartTime(tail);
      if (!time || !validParts(year, month, day, time.hour, time.minute)) continue;
      if (!hasYear && new Date(year, month, day, time.hour, time.minute).getTime() < reference.getTime() - 86400000) year++;
      const nearby = text.slice(match.index, match.index + match[0].length + 230);
      const candidate = dateWithZone(year, month, day, time.hour, time.minute, nearby);
      const knownZone = /\b(?:India Standard Time|Asia\/Kolkata|IST|Eastern Time|America\/New_York|Pacific Time|America\/Los_Angeles|Central Time|America\/Chicago|British Summer Time|Europe\/London|GMT|UTC)\b/i.test(nearby);
      if (candidate) return { iso: candidate,
        review: !(hasYear && knownZone && time.explicitlyTimed) };
    }
    return null;
  }

  function extractMeetings({ subject = "", body = "", html = "", calendars = [], receivedAt = new Date() } = {}) {
    const sourceText = [subject, body, html].join("\n");
    const links = findMeetingLinks(sourceText);
    const emailAccess = extractAccessDetails([body, html].join("\n"));
    const fromCalendars = calendars.flatMap(content => parseICS(content, links)).map(meeting => ({
      ...meeting,
      passcode: meeting.passcode || emailAccess.passcode,
      meetingId: meeting.meetingId || emailAccess.meetingId
    }));
    if (fromCalendars.length) return fromCalendars;
    if (!links.length) return [];
    const possibleDate = calendarLinkDateCandidate(sourceText) ||
      htmlDateCandidate(html) || textDateCandidate([subject, body, html].join("\n"), receivedAt);
    return [{ uid: null, recurrence: "", title: subject || "Meeting invitation",
      startIso: possibleDate?.iso || null, needsReview: possibleDate?.review ?? true,
      cancelled: false, joinUrl: links[0], passcode: emailAccess.passcode,
      meetingId: emailAccess.meetingId, source: "email or calendar metadata" }];
  }

  return { findMeetingLinks, extractAccessDetails, parseICS, parseICSDate, textDateCandidate, extractMeetings, validMeetingLink };
});
