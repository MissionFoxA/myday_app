/**
 * ADHD assistant: free personal prototype (Google Apps Script).
 *
 * Paste this whole file into Code.gs in a new project at script.google.com.
 * Sections:
 *   1. Web page + settings
 *   2. Gmail reading
 *   3. Date finder (rule-based, English + Hungarian)
 *   4. Importance score (rule-based)
 *   5. Gemini (optional free AI)
 *   6. Storage in a Google Sheet (notes, reminders, suggestions)
 *   7. Calendar
 *   8. Functions the web page calls (api...)
 *   9. App screens: Home, Now, Inbox, XP + plant, buddy, voice
 *  10. Full calendar: repeating events, edit/delete one or all, alerts
 */

// ============================================================
// 1. Web page + settings
// ============================================================

var DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

// ---- Phone app (home-screen app on GitHub Pages) ----
// Paste your two addresses here, then run setupPhoneApp once (see the setup guide).
var PHONE_APP_URL = 'https://missionfoxa.github.io/myday_app/';  // your GitHub Pages address, e.g. 'https://yourname.github.io/myday/'
var API_URL = 'https://script.google.com/macros/s/AKfycbwFODWdQ6TXHIiIwPDdx-81iy8mJtjAEcG64ngcgLnCI9zGi6TRZv9-U4WACF9lErG6ug/exec';        // this script's web app address, ending in /exec

/** The secret that lets only your phone use this script. */
function appToken_() { return PropertiesService.getScriptProperties().getProperty('APP_TOKEN') || ''; }

function doGet(e) {
  // Once the phone app is set up, the web app is reachable by link, so it asks for the secret too.
  var tok = appToken_();
  if (tok && !(e && e.parameter && e.parameter.k === tok)) {
    return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width, initial-scale=1"><p style="font:18px system-ui;padding:24px">This is a private app. Open it from your home screen icon, or from the link in your setup email.</p>').setTitle('My day');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('My day')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** The phone app calls the same api... functions as the web page, with the secret. */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var tok = appToken_();
    if (!tok || typeof req.t !== 'string' || req.t.length !== tok.length || req.t !== tok) throw new Error('Not allowed. Open the newest setup link from your email.');
    var fn = String(req.fn || '');
    var g = (function () { return this; })();
    if (!/^api[A-Z]\w*$/.test(fn) || typeof g[fn] !== 'function') throw new Error('Unknown action: ' + fn);
    var r = g[fn].apply(null, Array.isArray(req.args) ? req.args : []);
    out = { result: r === undefined ? null : r };
  } catch (err) {
    out = { error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor: makes your secret and emails you the link that installs the phone app. */
function setupPhoneApp() {
  // The addresses are remembered, so after a code update they don't need pasting again.
  var sp = PropertiesService.getScriptProperties();
  var appUrl = PHONE_APP_URL || sp.getProperty('PHONE_APP_URL') || '', apiUrl = API_URL || sp.getProperty('API_URL') || '';
  if (!/^https:\/\/.+/.test(appUrl)) throw new Error('Paste your GitHub Pages address into PHONE_APP_URL at the top of Code.gs first.');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(apiUrl)) throw new Error('Paste your web app address (ending in /exec) into API_URL at the top of Code.gs first.');
  sp.setProperty('PHONE_APP_URL', appUrl); sp.setProperty('API_URL', apiUrl);
  var p = sp;
  if (!p.getProperty('APP_TOKEN')) p.setProperty('APP_TOKEN', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  var code = Utilities.base64EncodeWebSafe(JSON.stringify({ u: apiUrl, t: appToken_() }));
  var app = appUrl.replace(/\/?$/, '/') + '?k=' + code;
  var web = apiUrl + '?k=' + appToken_();
  var me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, 'My day: your phone app link',
    'Open this link on your iPhone in Safari, then tap Share and Add to Home Screen:\n\n' + app +
    '\n\nTo use the app on a computer, open:\n' + web + '\n\nKeep these links private: anyone with them can see your app. To make new links and turn off the old ones, run newPhoneLinks in the script editor.');
  Logger.log('Sent to ' + me + '. Phone app link: ' + app);
}

/** Turns off the old links (for example if you shared one by mistake) and emails new ones. */
function newPhoneLinks() {
  PropertiesService.getScriptProperties().deleteProperty('APP_TOKEN');
  setupPhoneApp();
}

function getSettings_() {
  var p = PropertiesService.getUserProperties();
  return {
    engine: p.getProperty('ENGINE') || 'rules',
    model: p.getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL,
    hasKey: !!p.getProperty('GEMINI_API_KEY')
  };
}

// ============================================================
// 2. Gmail reading
// ============================================================

function myEmail_() {
  return (Session.getActiveUser().getEmail() || '').toLowerCase();
}

/** Cut quoted replies ("On ... wrote:", "... írta:", lines starting with >). */
function stripQuoted_(body) {
  var lines = String(body || '').split(/\r?\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .{5,200}wrote:\s*$/i.test(line)) break;
    if (/írta:\s*$/i.test(line) && line.length < 250) break;
    if (/^-{2,}\s*Original Message/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function fetchRecentEmails_(days, max) {
  var query = 'in:inbox newer_than:' + days + 'd';
  var threads = GmailApp.search(query, 0, max);
  var bulkIds = {};
  GmailApp.search(query + ' (category:promotions OR category:social OR category:forums)', 0, max)
    .forEach(function (t) { bulkIds[t.getId()] = true; });
  var me = myEmail_();

  return threads.map(function (t) {
    var msgs = t.getMessages();
    // Use the newest message that was not sent by me.
    var msg = msgs[msgs.length - 1];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].getFrom().toLowerCase().indexOf(me) === -1) { msg = msgs[i]; break; }
    }
    var body = stripQuoted_(msg.getPlainBody()).slice(0, 3000);
    return {
      threadId: t.getId(),
      messageId: msg.getId(),
      subject: msg.getSubject() || '(no subject)',
      from: msg.getFrom(),
      to: msg.getTo() + ' ' + msg.getCc(),
      date: msg.getDate(),
      body: body,
      snippet: body.slice(0, 200).replace(/\s+/g, ' '),
      link: 'https://mail.google.com/mail/u/0/#inbox/' + t.getId(),
      signals: {
        unread: t.isUnread(),
        starred: t.hasStarredMessages(),
        gmailImportant: t.isImportant(),
        hasAttachment: msg.getAttachments().length > 0,
        iRepliedBefore: msgs.some(function (m) { return m.getFrom().toLowerCase().indexOf(me) !== -1; }),
        toMeDirectly: me !== '' && msg.getTo().toLowerCase().indexOf(me) !== -1,
        bulkCategory: !!bulkIds[t.getId()]
      }
    };
  });
}

// ============================================================
// 3. Date finder (rule-based). Pure JavaScript, no Google calls.
// ============================================================

var MONTHS_ = {
  // English
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
  june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  // Hungarian
  'január': 0, 'február': 1, febr: 1, 'március': 2, 'márc': 2, 'április': 3, 'ápr': 3,
  'május': 4, 'máj': 4, 'június': 5, 'jún': 5, 'július': 6, 'júl': 6, augusztus: 7,
  szeptember: 8, szept: 8, 'október': 9, okt: 9
};

var WEEKDAYS_ = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  'vasárnap': 0, 'hétfő': 1, 'hétfőn': 1, kedd: 2, kedden: 2, szerda: 3, 'szerdán': 3,
  'csütörtök': 4, 'csütörtökön': 4, 'péntek': 5, 'pénteken': 5, szombat: 6, szombaton: 6
};

var DEADLINE_WORDS_ = /(deadline|due|until|no later than|by the end|határid|legkésőbb)/i;
var EVENT_WORDS_ = /(meeting|appointment|call|interview|event|party|dinner|lunch|webinar|exam|találkoz|megbeszél|időpont|értekezlet|vizsga|esemény|hívás|ebéd|vacsora|buli|program)/i;

function altOf_(obj) {
  return Object.keys(obj).sort(function (a, b) { return b.length - a.length; }).join('|');
}

// "letter before/after" guards, because \b does not work with accented letters.
var NL_ = '(?<![\\p{L}\\d])';
var NR_ = '(?![\\p{L}])';

function buildDateRegexes_() {
  var M = '(' + altOf_(MONTHS_) + ')\\.?';
  var W = '(' + altOf_(WEEKDAYS_) + ')';
  var HU_SUFFIX = '(?:-?(?:án|én|ján|jén|jától|étől|ától|áig|éig|ig|a|e|i))?';
  return [
    // 2026-11-28  |  2026.11.28.  |  2026. 11. 28.
    { type: 'ymd', re: new RegExp(NL_ + '(\\d{4})(?:-|\\.\\s?)(\\d{1,2})(?:-|\\.\\s?)(\\d{1,2})\\.?' + HU_SUFFIX, 'giu') },
    // 28/11/2026  |  28.11.2026  (day first, European)
    { type: 'dmy', re: new RegExp(NL_ + '(\\d{1,2})[./](\\d{1,2})[./](\\d{4}|\\d{2})(?!\\d)', 'giu') },
    // November 28, 2026  |  2026. november 28-án  |  nov. 28.
    { type: 'md', re: new RegExp(NL_ + '(?:(\\d{4})\\.?\\s+)?' + M + '\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th|\\.)?' + HU_SUFFIX + '(?:,?\\s+(\\d{4}))?' + NR_, 'giu') },
    // 28 November 2026  |  28th of Nov
    { type: 'dm', re: new RegExp(NL_ + '(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s+(?:of\\s+)?' + M + NR_ + '(?:,?\\s+(\\d{4}))?', 'giu') },
    // today / tomorrow / holnap / holnapután / ma
    { type: 'rel', re: new RegExp(NL_ + '(day after tomorrow|holnapután|tomorrow|holnap|today|tonight|ma este|ma)' + NR_, 'giu') },
    // next Friday / on Friday / jövő pénteken / pénteken
    { type: 'wd', re: new RegExp(NL_ + '(?:(next|this|on|coming|jövő|ezen a|e)\\s+)?' + W + NR_, 'giu') }
  ];
}

var DATE_RES_ = buildDateRegexes_();

var TIME_RE_ = new RegExp(
  NL_ + '(?:(délután|du\\.|este|éjjel|reggel|délelőtt|de\\.)\\s*)?' +
  '(?:at\\s+|@\\s*|kb\\.?\\s+)?' +
  '(\\d{1,2})(?:[:.](\\d{2}))?' +
  '\\s*(a\\.m\\.|p\\.m\\.|am|pm|órakor|órától|óráig|óra|-kor|-kör|-kot|-tól|-től|kor|h)?' + NR_,
  'giu');

var TIME_END_RE_ = new RegExp(
  '^\\s*(?:-|–|to|until|till|és)\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.m\\.|p\\.m\\.|am|pm|óráig|-ig|ig)?',
  'iu');

function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

function validDate_(y, m, d) {
  var dt = new Date(y, m, d);
  return (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) ? dt : null;
}

/** Year missing: take the next occurrence (allow up to 7 days in the past). */
function inferYear_(m, d, ref) {
  var y = ref.getFullYear();
  var dt = validDate_(y, m, d);
  if (dt && dt < addDays_(startOfDay_(ref), -7)) dt = validDate_(y + 1, m, d);
  return dt;
}

/** Turn a time match into {h, m} or null when it is just a number. */
function parseTime_(tm) {
  var prefix = (tm[1] || '').toLowerCase();
  var h = parseInt(tm[2], 10);
  var min = tm[3] ? parseInt(tm[3], 10) : 0;
  var suffix = (tm[4] || '').toLowerCase();
  if (!tm[3] && !suffix && !prefix) return null; // a bare number is not a time
  if (!tm[3] && !suffix && prefix) return null;   // "du. 3" without -kor is too vague
  if (h > 23 || min > 59) return null;
  if ((suffix === 'pm' || suffix === 'p.m.') && h < 12) h += 12;
  if ((suffix === 'am' || suffix === 'a.m.') && h === 12) h = 0;
  if ((prefix === 'délután' || prefix === 'du.' || prefix === 'este') && h < 12) h += 12;
  if (suffix === 'am' || suffix === 'a.m.' || suffix === 'pm' || suffix === 'p.m.') {
    if (h > 23) return null;
  }
  return { h: h, m: min };
}

/** Find a time right after (preferred) or right before a date match. */
function findTimeNear_(text, start, end) {
  var after = text.slice(end, end + 35);
  // Do not cross into another sentence.
  after = after.split(/[\n;!?]|\.\s+[A-ZÁÉÍÓÖŐÚÜŰ]/)[0];
  var found = scanTimes_(after, false);
  if (found) { found.offset = end + found.index; return found; }
  var beforeStart = Math.max(0, start - 30);
  var before = text.slice(beforeStart, start);
  var parts = before.split(/[\n;!?]|\.\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ])/);
  before = parts[parts.length - 1];
  found = scanTimes_(before, true);
  if (found) { found.offset = start - before.length + found.index; return found; }
  return null;
}

function scanTimes_(s, takeLast) {
  TIME_RE_.lastIndex = 0;
  var tm, result = null;
  while ((tm = TIME_RE_.exec(s)) !== null) {
    var t = parseTime_(tm);
    if (t) {
      var r = { h: t.h, m: t.m, index: tm.index, length: tm[0].length, text: tm[0] };
      var rest = s.slice(tm.index + tm[0].length);
      var em = TIME_END_RE_.exec(rest);
      if (em) {
        var eh = parseInt(em[1], 10), emin = em[2] ? parseInt(em[2], 10) : 0;
        var esuf = (em[3] || '').toLowerCase();
        if ((esuf === 'pm' || esuf === 'p.m.') && eh < 12) eh += 12;
        if (eh < t.h && t.h >= 12 && eh + 12 <= 23) eh += 12; // "3pm-4" -> 16:00
        if (eh <= 23 && emin <= 59 && (eh > t.h || (eh === t.h && emin > t.m))) {
          r.endH = eh; r.endM = emin; r.length += em[0].length; r.text += em[0];
        }
      }
      result = r;
      if (!takeLast) return result;
    }
    if (tm[0].length === 0) TIME_RE_.lastIndex++;
  }
  return result;
}

function resolveDateMatch_(type, m, ref) {
  var y, mo, d;
  switch (type) {
    case 'ymd':
      y = +m[1]; mo = +m[2] - 1; d = +m[3];
      return validDate_(y, mo, d);
    case 'dmy':
      d = +m[1]; mo = +m[2] - 1; y = +m[3]; if (y < 100) y += 2000;
      return validDate_(y, mo, d);
    case 'md':
      mo = MONTHS_[m[2].toLowerCase()]; d = +m[3];
      y = m[1] ? +m[1] : (m[4] ? +m[4] : null);
      return y ? validDate_(y, mo, d) : inferYear_(mo, d, ref);
    case 'dm':
      d = +m[1]; mo = MONTHS_[m[2].toLowerCase()];
      return m[3] ? validDate_(+m[3], mo, d) : inferYear_(mo, d, ref);
    case 'rel':
      var w = m[1].toLowerCase();
      if (w === 'tomorrow' || w === 'holnap') return addDays_(ref, 1);
      if (w === 'day after tomorrow' || w === 'holnapután') return addDays_(ref, 2);
      return startOfDay_(ref);
    case 'wd':
      var mod = (m[1] || '').toLowerCase();
      var target = WEEKDAYS_[m[2].toLowerCase()];
      var diff = (target - ref.getDay() + 7) % 7;
      if (mod === 'next' || mod === 'jövő') {
        // Next calendar week (weeks start on Monday): days until next Monday + weekday offset.
        var toNextMonday = 8 - (ref.getDay() || 7);
        return addDays_(ref, toNextMonday + (target + 6) % 7);
      }
      // Same weekday as today: "this Friday"/"pénteken" = today only with "this"/"e"; otherwise a week later.
      if (diff === 0 && mod !== 'this' && mod !== 'ezen a' && mod !== 'e') diff = 7;
      return addDays_(ref, diff);
  }
  return null;
}

/**
 * Find dates/times in a text.
 * @param {string} text
 * @param {Date} ref  "now" for this text (an email's sent date, or the current time)
 * @param {{looseTimes:boolean}=} opts  looseTimes: also treat a plain "14:30" with no date as today/tomorrow
 *        (used for typed reminders; emails only do this for "3pm", "10 a.m.", "15 órakor" style times)
 * @return {Array<{start:Date,end:Date,allDay:boolean,kind:string,confidence:number,matchedText:string,context:string,index:number}>}
 */
function findDates(text, ref, opts) {
  opts = opts || {};
  text = String(text || '');
  ref = ref || new Date();
  var raw = [];
  DATE_RES_.forEach(function (def) {
    def.re.lastIndex = 0;
    var m;
    while ((m = def.re.exec(text)) !== null) {
      // Lowercase English "may" is usually the verb, not the month.
      if ((def.type === 'md' || def.type === 'dm') && /(^|[^\p{L}])may\b/u.test(m[0])) continue;
      var day = resolveDateMatch_(def.type, m, ref);
      if (day) raw.push({ type: def.type, day: day, index: m.index, end: m.index + m[0].length, text: m[0] });
    }
  });

  // Drop overlapping matches and weekday/relative words sitting next to a full date
  // ("Friday, 28 November" -> keep only the full date).
  var absolute = raw.filter(function (r) { return r.type !== 'rel' && r.type !== 'wd'; });
  raw = raw.filter(function (r) {
    if (r.type !== 'rel' && r.type !== 'wd') return true;
    return !absolute.some(function (a) { return Math.abs(a.index - r.end) < 6 || Math.abs(r.index - a.end) < 6 || (r.index >= a.index && r.index < a.end); });
  });
  raw.sort(function (a, b) { return a.index - b.index || (b.end - b.index) - (a.end - a.index); });
  var kept = [];
  raw.forEach(function (r) {
    var last = kept[kept.length - 1];
    if (last && r.index < last.end) return; // overlap: keep the earlier/longer one
    kept.push(r);
  });

  var results = [];
  kept.forEach(function (r) {
    var t = findTimeNear_(text, r.index, r.end);
    var ctxStart = Math.max(0, r.index - 60), ctxEnd = Math.min(text.length, r.end + 60);
    var context = text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
    var start, end, allDay;
    if (t) {
      start = new Date(r.day.getFullYear(), r.day.getMonth(), r.day.getDate(), t.h, t.m);
      end = (t.endH !== undefined)
        ? new Date(r.day.getFullYear(), r.day.getMonth(), r.day.getDate(), t.endH, t.endM)
        : new Date(start.getTime() + 60 * 60000);
      allDay = false;
    } else {
      start = startOfDay_(r.day);
      end = addDays_(start, 1);
      allDay = true;
    }
    var near = text.slice(Math.max(0, r.index - 40), Math.min(text.length, r.end + 40));
    var justBefore = text.slice(Math.max(0, r.index - 15), r.index);
    var kind = (DEADLINE_WORDS_.test(near) || /-?(ig|áig|éig)$/i.test(r.text.trim()) ||
                /(^|\s)(by|before|till)\s+(the\s+)?$/i.test(justBefore)) ? 'deadline' : 'event';
    var confidence = (r.type === 'rel' || r.type === 'wd') ? 0.45 : 0.6;
    if (t) confidence += 0.25;
    if (EVENT_WORDS_.test(near) || kind === 'deadline') confidence += 0.1;
    var matchedText = (t ? (t.offset < r.index ? text.slice(t.offset, r.end) : text.slice(r.index, t.offset + t.length)) : r.text).trim();
    results.push({
      start: start, end: end, allDay: allDay, kind: kind,
      confidence: Math.min(0.95, Math.round(confidence * 100) / 100),
      matchedText: matchedText, context: context, index: r.index,
      spanStart: Math.min(r.index, t ? t.offset : r.index),
      spanEnd: Math.max(r.end, t ? t.offset + t.length : r.end)
    });
  });

  // A time with no date ("call at 3pm") -> today, or tomorrow if that time has already passed.
  var used = results.map(function (c) { return [c.spanStart, c.spanEnd]; })
    .concat(raw.map(function (r) { return [r.index, r.end]; }));
  TIME_RE_.lastIndex = 0;
  var tm;
  while ((tm = TIME_RE_.exec(text)) !== null) {
    if (tm[0].length === 0) { TIME_RE_.lastIndex++; continue; }
    var a = tm.index, b = tm.index + tm[0].length;
    if (used.some(function (u) { return a < u[1] && b > u[0]; })) continue;
    var t0 = parseTime_(tm);
    if (!t0) continue;
    var strong = /^(a\.m\.|p\.m\.|am|pm|órakor|óra|-kor|-kör|-kot)$/i.test(tm[4] || '');
    if (!strong && !opts.looseTimes) continue;
    var st = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), t0.h, t0.m);
    if (st <= ref) st = addDays_(st, 1), st = new Date(st.getFullYear(), st.getMonth(), st.getDate(), t0.h, t0.m);
    var full = scanTimes_(text.slice(a), false); // picks up an end time like "3pm-4pm"
    var en = (full && full.index === 0 && full.endH !== undefined)
      ? new Date(st.getFullYear(), st.getMonth(), st.getDate(), full.endH, full.endM)
      : new Date(st.getTime() + 60 * 60000);
    var spanEnd = a + (full && full.index === 0 ? full.length : tm[0].length);
    var nearT = text.slice(Math.max(0, a - 40), Math.min(text.length, b + 40));
    results.push({
      start: st, end: en, allDay: false, kind: DEADLINE_WORDS_.test(nearT) ? 'deadline' : 'event',
      confidence: EVENT_WORDS_.test(nearT) ? 0.55 : 0.45,
      matchedText: text.slice(a, spanEnd).trim(),
      context: text.slice(Math.max(0, a - 60), Math.min(text.length, b + 60)).replace(/\s+/g, ' ').trim(),
      index: a, spanStart: a, spanEnd: spanEnd
    });
    used.push([a, spanEnd]);
    TIME_RE_.lastIndex = spanEnd;
  }
  results.sort(function (x, y) { return x.index - y.index; });

  // Same start twice -> keep the more confident one.
  var seen = {};
  return results.filter(function (c) {
    var k = c.start.getTime() + '|' + c.allDay;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

/** For quick capture: "holnap 9:00 hívd fel a bankot" -> title "hívd fel a bankot". */
function titleWithoutDate_(text, cand) {
  if (!cand) return text.trim();
  var t = (text.slice(0, cand.spanStart) + ' ' + text.slice(cand.spanEnd))
    .replace(/\s+(on|at|by|-kor)\s*$/i, '')
    .replace(/^\s*[,.:\-–]+\s*/, '')
    .replace(/\s*[,.:\-–]+\s*$/, '')
    .replace(/\s+/g, ' ').trim();
  return t || text.trim();
}

function cleanSubject_(s) {
  return String(s || '').replace(/^\s*((re|fw|fwd|vá|tov)\s*:\s*)+/i, '').trim() || '(no subject)';
}

// ============================================================
// 4. Importance score (rule-based)
// ============================================================

var URGENT_WORDS_ = /(urgent|asap|as soon as possible|important|action required|deadline|reminder|today|sürgős|fontos|határid|azonnal|mielőbb|emlékeztet|ma\b)/i;
var BULK_WORDS_ = /(unsubscribe|leiratkoz|newsletter|hírlevél|view in browser|böngészőben)/i;
var NOREPLY_ = /(no-?reply|noreply|notifications?@|newsletter|mailer|marketing|info@)/i;

/** @return {{score:number, level:string, reasons:string[]}} */
function scoreEmail(email, foundDates) {
  var s = email.signals || {};
  var score = 30, reasons = [];
  function add(points, why) { score += points; reasons.push((points > 0 ? '+' : '') + points + ' ' + why); }
  if (s.starred) add(25, 'starred');
  if (s.gmailImportant) add(15, 'Gmail marked it important');
  if (s.iRepliedBefore) add(15, 'you replied in this thread');
  if (s.toMeDirectly) add(5, 'sent directly to you');
  if (s.unread) add(5, 'unread');
  if (s.hasAttachment) add(5, 'has attachment');
  if (URGENT_WORDS_.test(email.subject + ' ' + email.body.slice(0, 800))) add(15, 'urgent or deadline words');
  if (foundDates && foundDates.length) add(10, 'contains a date');
  if (/\?/.test(email.body.slice(0, 1000)) && !s.bulkCategory) add(5, 'asks a question');
  if (s.bulkCategory) add(-25, 'Promotions/Social tab');
  if (NOREPLY_.test(email.from)) add(-15, 'automatic sender');
  if (BULK_WORDS_.test(email.body)) add(-15, 'newsletter/unsubscribe link');
  score = Math.max(0, Math.min(100, score));
  return { score: score, level: score >= 60 ? 'high' : (score >= 35 ? 'medium' : 'low'), reasons: reasons };
}

// ============================================================
// 5. Gemini (optional free AI). Same output shape as the rules.
// ============================================================

function fmtLocal_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm (EEEE)");
}

/** "2026-11-28T15:00" or "2026-11-28" in the script time zone -> Date */
function parseLocalIso_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}

function callGemini_(prompt) {
  var p = PropertiesService.getUserProperties();
  var key = p.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('No Gemini key saved. Paste your free key in Settings first.');
  var model = p.getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    })
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) throw new Error('Gemini error ' + code + ': ' + body.slice(0, 300));
  var data = JSON.parse(body);
  var text = data.candidates && data.candidates[0] && data.candidates[0].content.parts.map(function (x) { return x.text || ''; }).join('');
  return JSON.parse(String(text).replace(/^```(json)?|```$/g, '').trim());
}

/** Analyze up to 10 emails in one request (saves free-tier quota). */
function geminiAnalyze_(emails) {
  var out = [];
  for (var i = 0; i < emails.length; i += 10) {
    var batch = emails.slice(i, i + 10);
    var prompt =
      'You help a person with ADHD manage their inbox. Time zone: ' + Session.getScriptTimeZone() + '. Now: ' + fmtLocal_(new Date()) + '.\n' +
      'For EACH email below return an object in a JSON array, same order, with:\n' +
      '  "importance": 0-100 (how much this person needs to see or act on it),\n' +
      '  "reason": one short sentence why,\n' +
      '  "events": list of things worth putting in a calendar (appointments, meetings, deadlines) with\n' +
      '     "title" (short, in the email\'s language), "start" ("YYYY-MM-DDTHH:MM" local time, or "YYYY-MM-DD" if no time),\n' +
      '     "end" (same format or null), "allDay" (true/false), "kind" ("event" or "deadline"), "quote" (the words you used).\n' +
      'Resolve relative dates like "tomorrow" or "holnap" from the email\'s sent date. Ignore dates in the past, in signatures, or in quoted older emails. Empty list if none.\n' +
      'Reply with only the JSON array.\n\n' +
      batch.map(function (e, j) {
        return '### Email ' + j + '\nSent: ' + fmtLocal_(e.date) + '\nFrom: ' + e.from + '\nSubject: ' + e.subject + '\n' + e.body.slice(0, 1500);
      }).join('\n\n');
    var arr = callGemini_(prompt);
    if (!Array.isArray(arr)) arr = arr.emails || arr.results || [];
    batch.forEach(function (e, j) {
      var r = arr[j] || {};
      var events = (r.events || []).map(function (ev) {
        var start = parseLocalIso_(ev.start);
        if (!start) return null;
        var allDay = !!ev.allDay || !/T\d/.test(ev.start);
        var end = parseLocalIso_(ev.end) || (allDay ? addDays_(start, 1) : new Date(start.getTime() + 3600000));
        return { start: start, end: end, allDay: allDay, kind: ev.kind || 'event', confidence: 0.8,
                 matchedText: ev.quote || '', context: ev.quote || '', title: ev.title || '' };
      }).filter(Boolean);
      var score = Math.max(0, Math.min(100, Number(r.importance) || 0));
      out.push({
        importance: { score: score, level: score >= 60 ? 'high' : (score >= 35 ? 'medium' : 'low'), reasons: [r.reason || ''] },
        events: events
      });
    });
  }
  return out;
}

// ============================================================
// 6. Storage in a Google Sheet
// ============================================================

var TABLES_ = {
  Notes: ['id', 'created', 'text', 'deleted'],
  Reminders: ['id', 'created', 'text', 'due', 'done', 'calendarEventId', 'doneAt'],
  Suggestions: ['id', 'key', 'status', 'source', 'title', 'start', 'end', 'allDay', 'kind', 'confidence', 'matchedText', 'context', 'subject', 'from', 'link', 'calendarEventId', 'decidedAt'],
  // New in v2 (new columns always go at the END so older sheets keep working)
  Points: ['id', 'date', 'kind', 'refId', 'points', 'label'],
  Handled: ['id', 'key', 'kind', 'date'],
  // New in v3: the app's own calendar (nothing is written to Google Calendar)
  Events: ['id', 'created', 'title', 'start', 'end', 'allDay', 'location', 'source', 'refId', 'deleted',
           // v4: full calendar
           'notes', 'repeat', 'repeatUntil', 'alert', 'color', 'exdates', 'updated']
};

var DB_CACHE_ = null;
var DB_SCHEMA_ = 'v4';
var ROWS_CACHE_ = {}; // per request: each tab is read from the sheet at most once
function db_() {
  if (DB_CACHE_) return DB_CACHE_;
  var p = PropertiesService.getUserProperties();
  var id = p.getProperty('SHEET_ID');
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Assistant prototype data');
    p.setProperty('SHEET_ID', ss.getId());
    p.deleteProperty('DB_SCHEMA');
  }
  DB_CACHE_ = ss;
  // Setting up the tabs and formats is slow, so only do it once per schema version.
  if (p.getProperty('DB_SCHEMA') === DB_SCHEMA_ && Object.keys(TABLES_).every(function (n) { return ss.getSheetByName(n); })) return ss;
  Object.keys(TABLES_).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, TABLES_[name].length).setValues([TABLES_[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else if (sh.getLastColumn() < TABLES_[name].length) {
      // Older sheet from v1: add the new column names at the end of the header row.
      sh.getRange(1, 1, 1, TABLES_[name].length).setValues([TABLES_[name]]).setFontWeight('bold');
    }
    sh.getRange('A:Z').setNumberFormat('@'); // store everything as plain text
  });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Munkalap1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  p.setProperty('DB_SCHEMA', DB_SCHEMA_);
  return ss;
}

function rows_(table) {
  if (ROWS_CACHE_[table]) return ROWS_CACHE_[table];
  ROWS_CACHE_[table] = readRows_(table);
  return ROWS_CACHE_[table];
}
function readRows_(table) {
  var sh = db_().getSheetByName(table);
  var values = sh.getDataRange().getValues();
  var head = values.shift();
  return values.map(function (v, i) {
    var o = { _row: i + 2 };
    // Sheets turns text like "2026-12-15" or "10:30" into dates, and the web page
    // gets nothing back if a reply contains a Date. Turn every Date back into text.
    head.forEach(function (h, j) { o[h] = v[j] instanceof Date ? v[j].toISOString() : v[j]; });
    return o;
  });
}

function insert_(table, obj) {
  var sh = db_().getSheetByName(table);
  obj.id = obj.id || ('x' + Utilities.getUuid().slice(0, 8)); // letter prefix so Sheets keeps it as text
  sh.appendRow(TABLES_[table].map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
  delete ROWS_CACHE_[table];
  return obj;
}

function update_(table, id, changes) {
  var sh = db_().getSheetByName(table);
  var head = TABLES_[table];
  var row = rows_(table).filter(function (r) { return String(r.id) === String(id); })[0];
  if (!row) throw new Error(table + ' item not found: ' + id);
  // Write the whole row in one go (one write is much faster than one per cell).
  var values = head.map(function (h) {
    if (changes.hasOwnProperty(h)) return changes[h];
    var v = row[h];
    return v === undefined || v === null ? '' : v;
  });
  sh.getRange(row._row, 1, 1, head.length).setValues([values]);
  delete ROWS_CACHE_[table];
}

// ============================================================
// 7. The app's own calendar (stored in the "Events" tab of the data sheet).
//    Nothing is written to Google Calendar. Sync can be added later.
// ============================================================

/** Save an event in the app's calendar. Returns the plain event. */
function createEvent_(title, start, end, allDay, source, refId) {
  if (allDay) {
    start = startOfDay_(start);
    end = end > start ? startOfDay_(end) : addDays_(start, 1);
    if (end <= start) end = addDays_(start, 1);
  } else if (!(end > start)) {
    end = new Date(start.getTime() + 3600000);
  }
  var row = insert_('Events', { created: new Date().toISOString(), title: String(title || '').trim() || '(no title)',
    start: start.toISOString(), end: end.toISOString(), allDay: !!allDay, location: '', source: source || 'app',
    refId: refId || '', deleted: false });
  return eventFromRow_(row);
}

function eventFromRow_(r) {
  var start = iso_(r.start);
  return { id: String(r.id), title: String(r.title), start: start, end: iso_(r.end),
           allDay: r.allDay === true || String(r.allDay).toUpperCase() === 'TRUE',
           location: String(r.location || ''), notes: String(r.notes || ''), repeat: String(r.repeat || 'none') || 'none',
           repeatUntil: r.repeatUntil ? iso_(r.repeatUntil) : '', alert: r.alert === '' || r.alert === undefined || r.alert === null ? '' : String(r.alert),
           color: String(r.color || '') || 'blue', source: String(r.source || ''), key: 'ev:' + r.id + ':' + start };
}

// Kept so older code paths that announce "calendar changed" still work.
function calChanged_() {}

// ============================================================
// 8. Functions the web page calls
// (google.script.run cannot send Date objects, so dates travel as ISO text)
// ============================================================

function iso_(d) { return d instanceof Date ? d.toISOString() : (d ? new Date(d).toISOString() : ''); }

function apiStatus() {
  var s = getSettings_();
  var ss = db_();
  return {
    email: myEmail_(),
    calendar: 'Built into the app (no Google Calendar)',
    timeZone: Session.getScriptTimeZone(),
    inboxUnread: GmailApp.getInboxUnreadCount(),
    sheetUrl: ss.getUrl(),
    engine: s.engine, model: s.model, hasKey: s.hasKey
  };
}

function apiSaveSettings(engine, model, key) {
  var p = PropertiesService.getUserProperties();
  if (engine) p.setProperty('ENGINE', engine);
  if (model) p.setProperty('GEMINI_MODEL', model.trim());
  if (key) p.setProperty('GEMINI_API_KEY', key.trim());
  if (key === '-') p.deleteProperty('GEMINI_API_KEY');
  return getSettings_();
}

/** Scan inbox: score every email, find dates, save new "add to calendar?" suggestions. */
function apiScan(days, max, engine) {
  days = Math.max(1, Math.min(30, Number(days) || 3));
  max = Math.max(1, Math.min(60, Number(max) || 25));
  engine = engine || getSettings_().engine;
  var emails = fetchRecentEmails_(days, max);
  var ai = engine === 'gemini' ? geminiAnalyze_(emails) : null;
  var todayStart = startOfDay_(new Date());

  var existing = {};
  rows_('Suggestions').forEach(function (r) { existing[r.key] = r; });

  var result = emails.map(function (e, i) {
    var dates, importance;
    if (ai) {
      dates = ai[i].events;
      importance = ai[i].importance;
    } else {
      dates = findDates(e.subject + '\n' + e.body, e.date);
      importance = scoreEmail(e, dates);
    }
    dates = dates.filter(function (d) { return d.start >= todayStart; });
    // Same day found twice ("Saturday" and "Saturday 10:00"): keep only the one with a time.
    dates = dates.filter(function (d) {
      return !(d.allDay && dates.some(function (o) { return !o.allDay && todayKey_(o.start) === todayKey_(d.start); }));
    });
    // Newsletters and shop mail ("Can skip" lane) don't get "add to calendar?" cards.
    if (importance.score < 35) dates = [];
    dates.forEach(function (d) {
      var key = e.messageId + '|' + d.start.toISOString() + '|' + d.allDay;
      if (existing[key]) return;
      existing[key] = insert_('Suggestions', {
        key: key, status: 'pending', source: engine,
        title: d.title || ((d.kind === 'deadline' ? 'Deadline: ' : '') + cleanSubject_(e.subject)),
        start: d.start.toISOString(), end: d.end.toISOString(), allDay: d.allDay,
        kind: d.kind, confidence: d.confidence, matchedText: d.matchedText,
        context: d.context, subject: e.subject, from: e.from, link: e.link
      });
    });
    return {
      threadId: e.threadId, subject: e.subject, from: e.from, date: iso_(e.date), snippet: e.snippet.slice(0, 140), link: e.link,
      unread: !!e.signals.unread, category: categoryOf_(e),
      importance: importance,
      found: dates.map(function (d) { return { start: iso_(d.start), allDay: d.allDay, kind: d.kind, matchedText: d.matchedText }; })
    };
  });
  result.sort(function (a, b) { return b.importance.score - a.importance.score; });
  saveInboxCache_({ scannedAt: new Date().toISOString(), engine: engine, days: days, emails: result });
  return { engine: engine, emails: result, suggestions: apiPendingSuggestions() };
}

function apiPendingSuggestions() {
  var todayStart = startOfDay_(new Date());
  return rows_('Suggestions')
    .filter(function (r) { return r.status === 'pending' && new Date(r.start) >= todayStart; })
    .map(function (r) {
      return { id: String(r.id), title: String(r.title), start: iso_(r.start), end: iso_(r.end), allDay: r.allDay === true || String(r.allDay).toUpperCase() === 'TRUE',
               kind: String(r.kind), confidence: Number(r.confidence) || 0, matchedText: String(r.matchedText), context: String(r.context),
               subject: String(r.subject), from: String(r.from), link: String(r.link), source: String(r.source) };
    })
    .sort(function (a, b) { return a.start < b.start ? -1 : 1; });
}

function apiAcceptSuggestion(id, title, startIso, endIso, allDay) {
  var start = new Date(startIso), end = new Date(endIso);
  var ev = createEvent_(title, start, end, !!allDay, 'email', id);
  update_('Suggestions', id, { status: 'added', title: title, start: start.toISOString(), end: end.toISOString(), calendarEventId: ev.id, decidedAt: new Date().toISOString() });
  var pts = award_('suggestion', id, XP_.suggestion, 'Added to calendar: ' + title);
  return { ok: true, event: ev, points: pts };
}

function apiDismissSuggestion(id) {
  update_('Suggestions', id, { status: 'dismissed', decidedAt: new Date().toISOString() });
  return { ok: true, points: award_('decided', id, XP_.decided, 'Decided on an email date') };
}

/** Try the date finder on any text (no mailbox access). */
function apiTestDateFinder(text) {
  return findDates(text, new Date(), { looseTimes: true }).map(function (c) {
    return { start: iso_(c.start), end: iso_(c.end), allDay: c.allDay, kind: c.kind, confidence: c.confidence,
             matchedText: c.matchedText, titleGuess: titleWithoutDate_(text, c) };
  });
}

function apiUpcoming(days) {
  var now = new Date();
  return eventsBetween_(startOfDay_(now), addDays_(now, Number(days) || 7));
}

/** Add an event to the app's calendar by hand (simple form; the calendar screen uses apiSaveEvent). */
function apiAddEvent(title, startIso, endIso, allDay) {
  return apiSaveEvent({ title: title, start: startIso, end: endIso, allDay: !!allDay }, 'all');
}

// ---- Notes ----
function apiAddNote(text) {
  if (!String(text || '').trim()) throw new Error('Note is empty');
  insert_('Notes', { created: new Date().toISOString(), text: String(text).trim(), deleted: false });
  return apiListNotes();
}
function apiListNotes() {
  return rows_('Notes').filter(function (r) { return String(r.deleted).toUpperCase() !== 'TRUE'; })
    .map(function (r) { return { id: String(r.id), created: iso_(r.created), text: String(r.text) }; }).reverse();
}
function apiDeleteNote(id) { update_('Notes', id, { deleted: true }); return apiListNotes(); }

// ---- Reminders ----
/** dueIso optional: if empty, the date is read from the text ("holnap 9:00 bank"). */
function apiAddReminder(text, dueIso) {
  text = String(text || '').trim();
  if (!text) throw new Error('Reminder is empty');
  var due, title = text;
  if (dueIso) {
    due = new Date(dueIso);
  } else {
    var c = findDates(text, new Date(), { looseTimes: true })[0];
    if (!c) throw new Error('No date/time found in the text. Add one (e.g. "tomorrow 9:00") or fill the date field.');
    due = c.start;
    if (c.allDay) due = new Date(due.getFullYear(), due.getMonth(), due.getDate(), 9, 0); // all-day -> 9:00
    title = titleWithoutDate_(text, c);
  }
  if (due < new Date()) throw new Error('That time is already in the past: ' + due);
  insert_('Reminders', { created: new Date().toISOString(), text: title, due: due.toISOString(), done: false, calendarEventId: '' });
  return apiListReminders();
}
function apiListReminders() {
  return rows_('Reminders').filter(function (r) { return String(r.done).toUpperCase() !== 'TRUE'; })
    .map(function (r) { return { id: String(r.id), text: String(r.text), due: iso_(r.due) }; })
    .sort(function (a, b) { return a.due < b.due ? -1 : 1; });
}
/** Done/delete: mark it done. */
function apiCompleteReminder(id) {
  var row = rows_('Reminders').filter(function (r) { return String(r.id) === String(id); })[0];
  update_('Reminders', id, { done: true, doneAt: new Date().toISOString() });
  award_('reminder', id, XP_.reminder, 'Reminder: ' + (row ? row.text : ''));
  return apiListReminders();
}

// ---- Daily view ----
function apiDaily() {
  var now = new Date();
  var emails = fetchRecentEmails_(2, 30).map(function (e) {
    var imp = scoreEmail(e, findDates(e.subject + '\n' + e.body, e.date));
    return { subject: e.subject, from: e.from, link: e.link, importance: imp };
  }).filter(function (e) { return e.importance.level !== 'low'; })
    .sort(function (a, b) { return b.importance.score - a.importance.score; }).slice(0, 5);
  var soon = addDays_(now, 3);
  return {
    now: now.toISOString(),
    today: eventsBetween_(startOfDay_(now), addDays_(startOfDay_(now), 1)),
    tomorrow: eventsBetween_(addDays_(startOfDay_(now), 1), addDays_(startOfDay_(now), 2)),
    reminders: apiListReminders().filter(function (r) { return new Date(r.due) <= soon; }),
    topEmails: emails,
    suggestions: apiPendingSuggestions().slice(0, 5),
    notes: apiListNotes().slice(0, 5)
  };
}

// ---- For pressing Run in the editor (first-time sign-in) ----
function testConnection() {
  Logger.log(JSON.stringify(apiStatus(), null, 2));
}

// ============================================================
// 9. App screens: Home, Now, Inbox, XP + plant, buddy, voice
// ============================================================

/** XP for each kind of finished thing. A level is every 200 XP. */
var XP_ = { reminder: 10, suggestion: 5, decided: 2, email: 5, event: 20, boss: 50 };
var XP_PER_LEVEL_ = 200;

function todayKey_(d) { return Utilities.formatDate(d || new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function sameDay_(a, b) { return todayKey_(a) === todayKey_(b); }
/** Monday 00:00 of the week that contains d. */
function weekStart_(d) { var s = startOfDay_(d); var wd = (s.getDay() + 6) % 7; return addDays_(s, -wd); }

/** Give XP once per (kind, refId). Returns the points given (0 if already given). */
function award_(kind, refId, points, label) {
  refId = String(refId || '');
  var done = rows_('Points').some(function (r) { return String(r.kind) === kind && String(r.refId) === refId; });
  if (done) return 0;
  insert_('Points', { date: new Date().toISOString(), kind: kind, refId: refId, points: points, label: String(label || '').slice(0, 120) });
  return points;
}

function markHandled_(key, kind) {
  if (isHandled_(key)) return;
  insert_('Handled', { key: key, kind: kind, date: new Date().toISOString() });
}
function handledKeys_() {
  var h = {};
  rows_('Handled').forEach(function (r) { h[String(r.key)] = true; });
  return h;
}
function isHandled_(key) { return !!handledKeys_()[key]; }

/** Email category used by the "Can skip" lane. */
function categoryOf_(e) {
  var s = e.signals || {};
  if (s.bulkCategory || BULK_WORDS_.test(e.body || '')) return 'Newsletters & shops';
  if (NOREPLY_.test(e.from || '')) return 'Automatic';
  return 'Other';
}

/** "Name <a@b.c>" -> "Name" */
function senderName_(from) {
  var m = /^\s*"?([^"<]+?)"?\s*</.exec(String(from || ''));
  return (m ? m[1] : String(from || '').split('@')[0]).trim();
}

var WHY_SHORT_ = { 'Gmail marked it important': 'important', 'urgent or deadline words': 'deadline', 'you replied in this thread': 'you replied before',
  'contains a date': 'has a date', 'has attachment': 'attachment', 'starred': 'starred', 'asks a question': 'asks a question' };

/** Short reason for the lanes, from the score reasons ("+15 starred" -> "starred"). */
function shortWhy_(imp) {
  var good = (imp.reasons || []).filter(function (r) { return !/^-/.test(r); })
    .map(function (r) { return String(r).replace(/^\+?\d+\s*/, ''); })
    .filter(function (r) { return r && r !== 'unread' && r !== 'sent directly to you'; })
    .map(function (r) { return WHY_SHORT_[r] || r; });
  return good.slice(0, 2).join(' + ');
}

// ---- Inbox cache (so Home and Now don't re-read Gmail every time) ----
function saveInboxCache_(obj) {
  try { CacheService.getUserCache().put('inbox_v2', JSON.stringify(obj), 21600); } catch (e) { /* too big: skip cache */ }
}
function loadInboxCache_() {
  try { var t = CacheService.getUserCache().get('inbox_v2'); return t ? JSON.parse(t) : null; } catch (e) { return null; }
}

/** Inbox in three lanes. force=true reads Gmail again. */
function apiInbox(force) {
  var cache = force ? null : loadInboxCache_();
  if (!cache) { apiScan(3, 30); cache = loadInboxCache_() || { emails: [] }; }
  var handled = handledKeys_();
  var lanes = { needs: [], later: [], skip: [] }, groups = {};
  (cache.emails || []).forEach(function (e) {
    if (handled['mail:' + e.threadId]) return;
    var item = { threadId: e.threadId, name: senderName_(e.from), subject: e.subject, snippet: e.snippet, link: e.link,
                 date: e.date, why: shortWhy_(e.importance), score: e.importance.score,
                 dates: (e.found || []).length };
    if (e.importance.score >= 60) lanes.needs.push(item);
    else if (e.importance.score >= 35) lanes.later.push(item);
    else { lanes.skip.push(item); groups[e.category || 'Other'] = (groups[e.category || 'Other'] || 0) + 1; }
  });
  var sugByLink = {};
  apiPendingSuggestions().forEach(function (s) { (sugByLink[s.link] = sugByLink[s.link] || []).push(s); });
  lanes.needs.concat(lanes.later).forEach(function (m) { m.suggestions = sugByLink[m.link] || []; });
  return {
    scannedAt: cache.scannedAt || '', total: (cache.emails || []).length,
    needs: lanes.needs, later: lanes.later, skip: lanes.skip,
    skipGroups: Object.keys(groups).map(function (k) { return { name: k, count: groups[k] }; })
  };
}

/** Mark an email thread as dealt with: read in Gmail, gone from the lanes, +XP. */
function apiEmailDone(threadId) {
  try { var t = GmailApp.getThreadById(String(threadId)); if (t) t.markRead(); } catch (e) { /* thread gone */ }
  markHandled_('mail:' + threadId, 'email');
  var pts = award_('email', threadId, XP_.email, 'Handled an email');
  return { ok: true, points: pts };
}

// ---- Calendar helpers ----
/** Events from the app's own calendar that overlap [from, to), sorted by start. */
function eventsBetween_(from, to) {
  var out = [];
  rows_('Events').forEach(function (r) {
    if (String(r.deleted).toUpperCase() === 'TRUE') return;
    var e = eventFromRow_(r);
    occurrences_(e, String(r.exdates || ''), from, to).forEach(function (o) { out.push(o); });
  });
  return out.sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : (a.allDay ? -1 : 1)); });
}

/** Today's events, taken from this week's (cached) calendar read so a request reads the calendar only once. */
function todayEvents_() {
  var now = new Date(), ws = weekStart_(now), d0 = startOfDay_(now), d1 = addDays_(d0, 1);
  return eventsBetween_(ws, addDays_(ws, 7)).filter(function (e) { return new Date(e.start) < d1 && new Date(e.end) > d0; });
}

function openReminders_() {
  return rows_('Reminders').filter(function (r) { return String(r.done).toUpperCase() !== 'TRUE'; })
    .map(function (r) { return { id: String(r.id), text: String(r.text), due: iso_(r.due) }; });
}

// ---- XP, level and plant ----
function apiStats() {
  var now = new Date();
  var pts = rows_('Points');
  var total = pts.reduce(function (s, r) { return s + (Number(r.points) || 0); }, 0);
  var todayPts = pts.filter(function (r) { return sameDay_(new Date(r.date), now); });
  return { xp: total, level: Math.floor(total / XP_PER_LEVEL_) + 1, xpInLevel: total % XP_PER_LEVEL_,
           perLevel: XP_PER_LEVEL_, todayXp: todayPts.reduce(function (s, r) { return s + (Number(r.points) || 0); }, 0),
           plant: plant_(now, todayPts.length) };
}

/**
 * Today's plant: one leaf per thing finished today (green), a brown wilted leaf for
 * each reminder due today whose time passed without being done, and a dashed
 * outline for each thing still coming today. Finishing a missed reminder late
 * turns its leaf green again (it moves from "missed" to "done").
 */
function plant_(now, doneCount) {
  var endToday = addDays_(startOfDay_(now), 1);
  var missed = 0, toGrow = 0;
  openReminders_().forEach(function (r) {
    var due = new Date(r.due);
    if (!sameDay_(due, now)) return;
    if (due < now) missed++; else toGrow++;
  });
  var handled = handledKeys_();
  todayEvents_().forEach(function (e) { if (!e.allDay && new Date(e.end) > now && !handled[e.key]) toGrow++; });
  toGrow += Math.min(3, apiPendingSuggestions().length);
  return { done: doneCount, missed: missed, toGrow: toGrow, total: doneCount + missed + toGrow };
}

// ---- Buddy message ----
function buddy_(ctx) {
  var p = PropertiesService.getUserProperties();
  var key = 'BUDDY_' + todayKey_();
  var s = getSettings_();
  if (s.engine === 'gemini' && s.hasKey) {
    var cached = p.getProperty(key);
    if (cached) return cached;
    try {
      var r = callGemini_('You are a warm, brief buddy in an app for a person with ADHD. Write ONE friendly message of at most 25 words about their day, ' +
        'naming the next thing. No lists, no emoji. Reply as JSON {"message": "..."}. Their day: ' + JSON.stringify(ctx));
      if (r && r.message) { p.setProperty(key, String(r.message).slice(0, 220)); return String(r.message).slice(0, 220); }
    } catch (e) { /* fall back to the built-in sentences */ }
  }
  var h = new Date().getHours();
  var hi = h < 11 ? 'Morning!' : (h < 18 ? 'Hey!' : 'Evening!');
  var parts = [];
  if (!ctx.count) parts.push('Nothing planned for the rest of today. Nice and calm.');
  else if (ctx.count <= 2) parts.push('Easy day.');
  else if (ctx.count <= 5) parts.push(ctx.count + ' things today, one at a time.');
  else parts.push('Busy day with ' + ctx.count + ' things. Let\'s just do the next one.');
  if (ctx.next) parts.push('Up next: ' + ctx.next + '.');
  if (ctx.missed) parts.push(ctx.missed === 1 ? 'One reminder slipped past, you can still finish it.' : ctx.missed + ' reminders slipped past, you can still finish them.');
  if (ctx.suggestions) parts.push(ctx.suggestions === 1 ? 'I found a date in your email.' : 'I found ' + ctx.suggestions + ' dates in your email.');
  return hi + ' ' + parts.join(' ');
}

function hhmm_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm'); }

/** Home: week strip, buddy message and the chosen day's blocks. dateIso optional (defaults to today). */
function apiHome(dateIso) {
  var now = new Date();
  var day = dateIso ? startOfDay_(new Date(dateIso)) : startOfDay_(now);
  var isToday = sameDay_(day, now);
  var ws = weekStart_(day), we = addDays_(ws, 7);
  var weekEvents = eventsBetween_(ws, we);
  var reminders = openReminders_();
  var sugs = apiPendingSuggestions();

  var week = [];
  for (var i = 0; i < 7; i++) {
    var d = addDays_(ws, i);
    var n = weekEvents.filter(function (e) { return sameDay_(new Date(e.start), d) || (e.allDay && new Date(e.start) <= d && new Date(e.end) > d); }).length +
            reminders.filter(function (r) { return sameDay_(new Date(r.due), d); }).length +
            sugs.filter(function (s) { return sameDay_(new Date(s.start), d); }).length;
    week.push({ date: d.toISOString(), count: n, today: sameDay_(d, now) });
  }

  var dayEnd = addDays_(day, 1);
  var blocks = [];
  weekEvents.forEach(function (e) {
    var st = new Date(e.start), en = new Date(e.end);
    if (!(st < dayEnd && en > day)) return;
    blocks.push({ type: 'event', key: e.key, id: e.id, color: e.color, repeat: e.repeat, repeatUntil: e.repeatUntil, alert: e.alert, notes: e.notes, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
                  past: !e.allDay && en < now });
  });
  reminders.forEach(function (r) {
    var due = new Date(r.due);
    if (!sameDay_(due, day) && !(isToday && due < day)) return; // overdue ones show on today
    blocks.push({ type: 'reminder', id: r.id, title: r.text, start: r.due, missed: due < now });
  });
  var sugShown = 0;
  sugs.forEach(function (s) {
    var onDay = sameDay_(new Date(s.start), day);
    if (!onDay && !(isToday && sugShown < 3)) return; // today also shows up to 3 email dates for later days
    sugShown++;
    blocks.push({ type: 'suggestion', id: s.id, title: s.title, start: s.start, end: s.end, allDay: s.allDay, from: senderName_(s.from), onDay: sameDay_(new Date(s.start), day) });
  });
  // order: all-day first, then by time; email suggestions for other days go last
  blocks.sort(function (a, b) {
    var ka = a.type === 'suggestion' && !a.onDay ? 2 : (a.allDay ? 0 : 1), kb = b.type === 'suggestion' && !b.onDay ? 2 : (b.allDay ? 0 : 1);
    return ka !== kb ? ka - kb : (a.start < b.start ? -1 : 1);
  });
  var next = blocks.filter(function (b) { return b.type !== 'suggestion' && !b.allDay && new Date(b.start) >= now; })[0];
  if (next && isToday) next.now = true;

  var stats = apiStats();
  var buddy = '';
  if (isToday) {
    buddy = buddy_({
      count: blocks.filter(function (b) { return b.type !== 'suggestion' && !b.past; }).length,
      next: next ? next.title + ' at ' + hhmm_(new Date(next.start)) : '',
      missed: blocks.filter(function (b) { return b.missed; }).length,
      suggestions: blocks.filter(function (b) { return b.type === 'suggestion'; }).length
    });
  }
  return { now: now.toISOString(), day: day.toISOString(), isToday: isToday, week: week, blocks: blocks.slice(0, 30), buddy: buddy,
           stats: { level: stats.level, xp: stats.xp } };
}

// ---- Now: one card at a time ----
function laterKey_() { return 'LATER_' + todayKey_(); }
function laterList_() {
  try { return JSON.parse(PropertiesService.getUserProperties().getProperty(laterKey_()) || '[]'); } catch (e) { return []; }
}

function nowCards_() {
  var now = new Date();
  var endToday = addDays_(startOfDay_(now), 1);
  var handled = handledKeys_();
  var cards = [];
  var events = todayEvents_().filter(function (e) { return !e.allDay && new Date(e.end) > now && !handled[e.key]; });
  var boss = events[0] ? events[0].key : '';
  events.forEach(function (e) {
    var isBoss = e.key === boss;
    cards.push({ key: e.key, type: 'event', title: e.title, start: e.start, end: e.end, location: e.location, boss: isBoss,
                 xp: isBoss ? XP_.boss : XP_.event });
  });
  openReminders_().forEach(function (r) {
    var due = new Date(r.due);
    if (due >= endToday) return;
    cards.push({ key: 'rem:' + r.id, type: 'reminder', id: r.id, title: r.text, start: r.due, missed: due < now, xp: XP_.reminder });
  });
  var sugLinks = {};
  apiPendingSuggestions().slice(0, 5).forEach(function (s) {
    sugLinks[s.link] = true;
    cards.push({ key: 'sug:' + s.id, type: 'suggestion', id: s.id, title: s.title, start: s.start, end: s.end, allDay: s.allDay,
                 from: senderName_(s.from), link: s.link, xp: XP_.suggestion });
  });
  var cache = loadInboxCache_();
  if (cache) cache.emails.filter(function (e) { return e.importance.score >= 60 && !handled['mail:' + e.threadId] && !sugLinks[e.link]; }).slice(0, 3).forEach(function (e) {
    cards.push({ key: 'mail:' + e.threadId, type: 'email', threadId: e.threadId, title: e.subject, from: senderName_(e.from),
                 why: shortWhy_(e.importance), link: e.link, start: e.date, xp: XP_.email });
  });
  // missed reminders first, then by time; emails (no time) after timed things
  var rank = function (c) { return c.type === 'reminder' && c.missed ? 0 : (c.type === 'email' || c.type === 'suggestion' ? 2 : 1); };
  cards.sort(function (a, b) { return rank(a) !== rank(b) ? rank(a) - rank(b) : (a.start < b.start ? -1 : 1); });
  var later = laterList_();
  cards.sort(function (a, b) { return later.indexOf(a.key) - later.indexOf(b.key); }); // not-later (-1) stay first, later ones at the back in the order they were sent
  return cards;
}

function apiNow() {
  var stats = apiStats();
  return { cards: nowCards_(), stats: stats };
}

/** "Got it" on a card: finish it and give XP. */
function apiCardDone(key) {
  key = String(key);
  var card = nowCards_().filter(function (c) { return c.key === key; })[0];
  if (!card) return apiNow();
  if (card.type === 'event') {
    markHandled_(key, 'event');
    award_(card.boss ? 'boss' : 'event', key, card.xp, (card.boss ? 'Boss: ' : '') + card.title);
  } else if (card.type === 'reminder') {
    apiCompleteReminder(card.id);
  } else if (card.type === 'suggestion') {
    apiAcceptSuggestion(card.id, card.title, card.start, card.end, card.allDay);
  } else if (card.type === 'email') {
    apiEmailDone(card.threadId);
  }
  return apiNow();
}

/** "Later": send the card to the back of today's pile. */
function apiCardLater(key) {
  var list = laterList_().filter(function (k) { return k !== key; });
  list.push(String(key));
  PropertiesService.getUserProperties().setProperty(laterKey_(), JSON.stringify(list.slice(-50)));
  return apiNow();
}

/** "No" on an email-date card. */
function apiCardDismiss(key) {
  var m = /^sug:(.+)$/.exec(String(key));
  if (m) apiDismissSuggestion(m[1]);
  return apiNow();
}

// ---- Voice (or typed) quick add ----
var SPOKEN_LEAD_ = /^\s*(please\s+)?(remind me (to|that|about)?|reminder:?|don'?t forget (to)?|emlékeztess(?:\s+(arra|hogy))*|ne felejtsem(?:\s+el)?|ne felejtsd(?:\s+el)?)\s*/i;
var NOTE_LEAD_ = /^\s*(note|jegyzet|write down|jegyezd fel)\s*[:,-]?\s*/i;

/** Work out what a spoken sentence means, without saving anything. */
function apiParseSpoken(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('Nothing was heard. Try again or type it.');
  if (NOTE_LEAD_.test(text)) return { type: 'note', text: text.replace(NOTE_LEAD_, '') };
  var wantsReminder = SPOKEN_LEAD_.test(text);
  var clean = text.replace(SPOKEN_LEAD_, '');
  var c = findDates(clean, new Date(), { looseTimes: true })[0];
  if (c) {
    var due = c.start;
    if (c.allDay) due = new Date(due.getFullYear(), due.getMonth(), due.getDate(), 9, 0);
    var title = (titleWithoutDate_(clean, c) || clean)
      .replace(/\s+(at|@|around|about|kb\.?|körül)?\s*\d{1,2}([:.]\d{2})?\s*(am|pm|a\.m\.|p\.m\.|órakor|kor)?\s*$/i, '')
      .replace(/^\s*(at|on|by)\s+/i, '').trim() || clean;
    title = title.charAt(0).toUpperCase() + title.slice(1);
    return { type: 'reminder', title: title, due: due.toISOString(), past: due < new Date() };
  }
  if (wantsReminder) {
    var t = clean.charAt(0).toUpperCase() + clean.slice(1);
    return { type: 'reminder', title: t, due: '', needsTime: true };
  }
  return { type: 'note', text: text };
}

/** Everything the app shows, in one trip (used at start-up so every tab opens instantly). */
/** Home for all 7 days of the week that holds dateIso, so the app can switch days without asking again. */
function apiHomeWeek(dateIso) {
  var day = dateIso ? startOfDay_(new Date(dateIso)) : startOfDay_(new Date());
  var ws = weekStart_(day), out = [];
  for (var i = 0; i < 7; i++) out.push(apiHome(addDays_(ws, i).toISOString()));
  return out;
}

/** Events and reminders for several ranges in one trip (the calendar preloads months with this). */
function apiCalendarMany(ranges) {
  return (ranges || []).slice(0, 4).map(function (r) { return apiCalendar(r[0], r[1]); });
}

function apiBoot() {
  var week = apiHomeWeek('');
  var home = week.filter(function (h) { return h.isToday; })[0] || apiHome('');
  var now = apiNow();
  var inbox = null;
  if (loadInboxCache_()) inbox = apiInbox(false);
  return { home: home, week: week, now: now, inbox: inbox, notes: apiListNotes() };
}

// ============================================================
// 10. Full calendar: repeating events, edit/delete one or all, alerts
//     Works like iPhone Calendar: a repeating event is one row; changing
//     "this event only" skips that date in the series and saves a copy.
// ============================================================

var REPEATS_ = { none: 1, daily: 1, weekdays: 1, weekly: 1, biweekly: 1, monthly: 1, yearly: 1 };
var COLORS_ = { blue: 1, orange: 1, pink: 1, green: 1, purple: 1 };

/** The n-th repeat of a start date (keeps the time of day, like a real calendar). null = skip (e.g. no 31st). */
function nthStart_(start, repeat, n) {
  var y = start.getFullYear(), m = start.getMonth(), d = start.getDate(), h = start.getHours(), mi = start.getMinutes();
  if (repeat === 'daily') return new Date(y, m, d + n, h, mi);
  if (repeat === 'weekly') return new Date(y, m, d + 7 * n, h, mi);
  if (repeat === 'biweekly') return new Date(y, m, d + 14 * n, h, mi);
  if (repeat === 'monthly') { var x = new Date(y, m + n, d, h, mi); return x.getDate() === d ? x : null; }
  if (repeat === 'yearly') { var z = new Date(y + n, m, d, h, mi); return z.getDate() === d ? z : null; }
  return null;
}

/** All times an event happens inside [from, to). */
function occurrences_(e, exdatesText, from, to) {
  var start = new Date(e.start), end = new Date(e.end), dur = end - start;
  if (!e.repeat || e.repeat === 'none' || !REPEATS_[e.repeat]) {
    return (start < to && end > from) ? [e] : [];
  }
  var ex = {};
  String(exdatesText || '').split(',').forEach(function (x) { if (x) ex[new Date(x).getTime()] = true; });
  var until = e.repeatUntil ? addDays_(startOfDay_(new Date(e.repeatUntil)), 1) : null; // the whole "end repeat" day counts
  var out = [], n = 0;
  if (e.repeat !== 'weekdays') {
    // Jump close to "from" instead of walking from the first date.
    var per = { daily: 1, weekly: 7, biweekly: 14, monthly: 28, yearly: 365 }[e.repeat];
    n = Math.max(0, Math.floor((from - start - dur) / (per * 864e5)) - 2);
    if (e.repeat === 'monthly') n = Math.max(0, (from.getFullYear() - start.getFullYear()) * 12 + from.getMonth() - start.getMonth() - 2);
    if (e.repeat === 'yearly') n = Math.max(0, from.getFullYear() - start.getFullYear() - 1);
    for (var guard = 0; guard < 2000; guard++, n++) {
      var s = nthStart_(start, e.repeat, n);
      if (s === null) continue;
      if (s >= to || (until && s >= until)) break;
      push_(s);
    }
  } else {
    var day = startOfDay_(start);
    var k = Math.max(0, Math.floor((startOfDay_(from) - day) / 864e5) - 1);
    for (var g = 0; g < 2000; g++, k++) {
      var s2 = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k, start.getHours(), start.getMinutes());
      if (s2 >= to || (until && s2 >= until)) break;
      if (s2.getDay() === 0 || s2.getDay() === 6) continue;
      push_(s2);
    }
  }
  return out;
  function push_(s) {
    if (ex[s.getTime()]) return;
    var en = new Date(s.getTime() + dur);
    if (!(s < to && en > from)) return;
    var o = JSON.parse(JSON.stringify(e));
    o.seriesStart = e.start; o.start = s.toISOString(); o.end = en.toISOString(); o.key = 'ev:' + e.id + ':' + o.start;
    out.push(o);
  }
}

function eventRow_(id) {
  var row = rows_('Events').filter(function (r) { return String(r.id) === String(id); })[0];
  if (!row) throw new Error('That event no longer exists. Pull down to refresh.');
  return row;
}

/** Clean up what the page sends (dates as ISO text). */
function cleanEvent_(ev) {
  var title = String(ev.title || '').trim() || 'New event';
  var allDay = !!ev.allDay;
  var start = new Date(ev.start);
  if (isNaN(start)) throw new Error('Pick a start time');
  var end = ev.end ? new Date(ev.end) : null;
  if (allDay) {
    start = startOfDay_(start);
    end = end && !isNaN(end) ? startOfDay_(end) : start;
    if (end <= start) end = addDays_(start, 1);  // all-day "ends" are the morning after the last day
  } else if (!end || isNaN(end) || end <= start) {
    end = new Date(start.getTime() + 3600000);
  }
  var repeat = REPEATS_[ev.repeat] ? ev.repeat : 'none';
  var alert = ev.alert === '' || ev.alert === null || ev.alert === undefined ? '' : String(Math.max(0, Math.round(Number(ev.alert) || 0)));
  return { title: title.slice(0, 200), start: start.toISOString(), end: end.toISOString(), allDay: allDay,
           location: String(ev.location || '').slice(0, 200), notes: String(ev.notes || '').slice(0, 4000),
           repeat: repeat, repeatUntil: repeat !== 'none' && ev.repeatUntil ? startOfDay_(new Date(ev.repeatUntil)).toISOString() : '',
           alert: alert, color: COLORS_[ev.color] ? ev.color : 'blue', updated: new Date().toISOString() };
}

/**
 * Create or change an event.
 * ev: {id?, occurrence?, title, start, end, allDay, location, notes, repeat, repeatUntil, alert, color}
 *     occurrence = start (ISO) of the repeat that was tapped, for repeating events.
 * scope: 'all' (whole series), 'this' (only this date), 'future' (this and later dates).
 */
function apiSaveEvent(ev, scope) {
  var v = cleanEvent_(ev);
  if (!ev.id) {
    v.created = new Date().toISOString(); v.source = 'app'; v.refId = ''; v.deleted = false; v.exdates = '';
    var row = insert_('Events', v);
    return { ok: true, event: eventFromRow_(row) };
  }
  var old = eventRow_(ev.id), oldE = eventFromRow_(old);
  var repeating = oldE.repeat !== 'none';
  var occ = ev.occurrence ? new Date(ev.occurrence) : new Date(oldE.start);
  if (!repeating || scope === 'all' || !scope || (scope === 'future' && occ.getTime() === new Date(oldE.start).getTime())) {
    if (repeating && occ.getTime() !== new Date(oldE.start).getTime()) {
      // Moving one date of the series by X moves the whole series by X (like iPhone "all events").
      var shift = new Date(v.start) - occ, len = new Date(v.end) - new Date(v.start);
      v.start = new Date(new Date(oldE.start).getTime() + shift).toISOString();
      v.end = new Date(new Date(v.start).getTime() + len).toISOString();
    }
    update_('Events', ev.id, v);
    return { ok: true };
  }
  if (scope === 'this') {
    addExdate_(old, occ);
    v.repeat = 'none'; v.repeatUntil = '';
    v.created = new Date().toISOString(); v.source = 'app'; v.refId = String(ev.id); v.deleted = false; v.exdates = '';
    insert_('Events', v);
    return { ok: true };
  }
  // 'future': end the old series the day before, start a new one from here.
  update_('Events', ev.id, { repeatUntil: addDays_(startOfDay_(occ), -1).toISOString(), updated: new Date().toISOString() });
  v.created = new Date().toISOString(); v.source = 'app'; v.refId = String(ev.id); v.deleted = false; v.exdates = '';
  if (v.repeat === 'none') v.repeat = oldE.repeat;
  insert_('Events', v);
  return { ok: true };
}

function addExdate_(row, occ) {
  var list = String(row.exdates || '').split(',').filter(Boolean);
  list.push(occ.toISOString());
  update_('Events', row.id, { exdates: list.join(','), updated: new Date().toISOString() });
}

/** Delete an event. For a repeating one: scope 'this' (just that date), 'future', or 'all'. */
function apiDeleteEvent(id, occurrenceIso, scope) {
  var row = eventRow_(id), e = eventFromRow_(row);
  var occ = occurrenceIso ? new Date(occurrenceIso) : new Date(e.start);
  if (e.repeat === 'none' || !scope || scope === 'all' || (scope === 'future' && occ.getTime() <= new Date(e.start).getTime())) {
    update_('Events', id, { deleted: true, updated: new Date().toISOString() });
  } else if (scope === 'this') {
    addExdate_(row, occ);
  } else {
    update_('Events', id, { repeatUntil: addDays_(startOfDay_(occ), -1).toISOString(), updated: new Date().toISOString() });
  }
  return { ok: true };
}

/** Everything the calendar screen shows between two dates: events (repeats expanded) and reminders. */
function apiCalendar(fromIso, toIso) {
  var from = new Date(fromIso), to = new Date(toIso);
  if (isNaN(from) || isNaN(to) || to <= from) throw new Error('Bad date range');
  if (to - from > 100 * 864e5) to = new Date(from.getTime() + 100 * 864e5);
  var reminders = openReminders_().filter(function (r) { var d = new Date(r.due); return d >= from && d < to; });
  return { from: from.toISOString(), to: to.toISOString(), events: eventsBetween_(from, to), reminders: reminders };
}

/** One event (series) with all its details, for the edit screen. */
function apiGetEvent(id) {
  var row = eventRow_(id), e = eventFromRow_(row);
  e.exdates = String(row.exdates || '');
  return e;
}

// ---- Alerts ----
/** Alerts due in the next `hours` hours (the page shows them while it is open). */
function apiAlerts(hours) {
  var now = new Date(), until = new Date(now.getTime() + (Number(hours) || 24) * 3600e3);
  return alertsBetween_(new Date(now.getTime() - 60e3), until);
}

function alertsBetween_(from, to) {
  var out = [];
  // events: look a week ahead so a "1 week before" alert is found
  eventsBetween_(from, new Date(to.getTime() + 8 * 864e5)).forEach(function (e) {
    if (e.alert === '') return;
    var base = new Date(e.start);
    if (e.allDay) base = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0); // all-day alerts at 9:00
    var at = new Date(base.getTime() - Number(e.alert) * 60e3);
    if (at >= from && at < to) out.push({ key: 'alert:' + e.key + ':' + e.alert, at: at.toISOString(), title: e.title, start: e.start, allDay: e.allDay, location: e.location, kind: 'event', id: e.id });
  });
  openReminders_().forEach(function (r) {
    var at = new Date(r.due);
    if (at >= from && at < to) out.push({ key: 'alert:rem:' + r.id + ':' + r.due, at: r.due, title: r.text, start: r.due, kind: 'reminder', id: r.id });
  });
  return out.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
}

// ---- Optional email alerts (so the phone buzzes even when the app is closed) ----
function apiEmailAlerts(on) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sendDueAlerts') ScriptApp.deleteTrigger(t); });
  if (on) ScriptApp.newTrigger('sendDueAlerts').timeBased().everyMinutes(5).create();
  PropertiesService.getUserProperties().setProperty('EMAIL_ALERTS', on ? '1' : '');
  return { on: !!on };
}
function apiEmailAlertsOn() { return PropertiesService.getUserProperties().getProperty('EMAIL_ALERTS') === '1'; }

/** Runs every 5 minutes when email alerts are on. Sends each alert once. */
function sendDueAlerts() {
  var now = new Date();
  var sent = handledKeys_();
  var me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  alertsBetween_(new Date(now.getTime() - 15 * 60e3), new Date(now.getTime() + 60e3)).forEach(function (a) {
    if (sent[a.key]) return;
    var when = a.allDay ? 'today' : Utilities.formatDate(new Date(a.start), Session.getScriptTimeZone(), 'HH:mm');
    var subject = (a.kind === 'reminder' ? '⏰ ' : '📅 ') + a.title + (a.kind === 'reminder' ? '' : ' · ' + when);
    MailApp.sendEmail(me, subject, (a.location ? 'Where: ' + a.location + '\n' : '') + 'Sent by your assistant app.');
    markHandled_(a.key, 'alert');
  });
}
