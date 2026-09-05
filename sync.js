import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const {
  GEMINI_API_KEY,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
} = process.env;

const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`;

// Same prompt as admin.html — keep both in sync.
const GEMINI_PROMPT = `You are an event extraction engine. Parse campus emails into structured calendar events for a NISER (National Institute of Science Education and Research) student.

═══ WHAT TO EXTRACT ═══
Extract ONLY emails containing a concrete, actionable event with a date or time:
- Classes, labs, lectures, tutorials with a specific time slot
- Seminars, workshops, orientations, guest lectures with a date
- Deadlines: assignment submission, registration, fee payment, form filling
- Exams, quizzes, viva, oral presentations with a date
- Club meetings, sports events, practices, tryouts, photoshoots
- Festivals, cultural events, orientations, inductions
- Any event where someone is expected to be somewhere at a specific time

═══ WHAT TO SKIP (return nothing for these) ═══
- Lost and found / missing items (wallet, ID card, keys, earbuds)
- Mess complaints, hygiene, food quality issues
- Secondhand sales, buy/sell, "looking for roommate"
- Generic newsletters, weekly digests, motivational quotes
- Anything without a concrete date, time, or deadline
- Pure informational emails with no action required

═══ SEPARATION RULES (critical) ═══
- Each DISTINCT event gets its OWN entry. Different date = different event. Different time = different event. Different type (seminar vs deadline) = different event.
- DO merge: a "general announcement" email + a "detailed follow-up" about the SAME event → one entry with combined details.
- DO merge: "VAC Course Session" + "VAC Course: Sports and Physical Education" if they are the same event on the same date.
- DO NOT merge: "Seminar on Monday" and "Workshop on Tuesday" — these are separate events.
- DO NOT merge: "Assignment 1 due Friday" and "Assignment 2 due next Monday" — different deadlines.
- DO NOT merge: "Physics Lab Batch 1" and "Physics Lab Batch 2" if they are at different times.
- If an email mentions MULTIPLE separate events (e.g. "upcoming week has a seminar on Wed and a deadline on Fri"), extract EACH as a separate entry.

═══ DATE/TIME RULES ═══
- Each email has a "Date:" header showing when it was sent. USE THIS to resolve relative dates in the email body.
- If the email body says "today", "tomorrow", "this Friday" — resolve it relative to the email's Date header, NOT the current date.
- Example: email sent on "Wed 20 Aug" mentions "tomorrow's seminar" → the event is on "Thu 21 Aug".
- Example: email sent on "Mon 18 Aug" mentions "today at 3PM" → the event is on "Mon 18 Aug".
- Parse dates from email text: "21st August", "August 21", "21/08", "next Monday", "this Friday"
- If only a date is given with no time, use "TBD" for the time field
- If a time range is given ("11:30 AM - 12:30 PM"), include the full range
- For deadlines, use the deadline time if given, otherwise "TBD"
- NEVER guess or fabricate a date or time. If not stated, use "TBD".

═══ CATEGORY RULES ═══
- "mandatory": emails that say mandatory/required/compulsory/"must attend"/"no absence allowed"
- "optional-academic": seminars, workshops, guest lectures, optional classes
- "admin": registration deadlines, fee payments, form submissions, administrative tasks
- "club-sports": club meetings, sports events, cultural events, festivals

═══ FIELD RULES ═══
- title: Short event name under 60 chars. Use the MOST SPECIFIC title available (e.g. "Quantum Computing Workshop" not just "Workshop")
- time: "HH:MM AM - HH:MM PM" format, or "TBD"
- date: "Day DD Mon" format (e.g. "Fri 21 Aug")
- location: Room/hall/building ONLY if explicitly mentioned. Leave "" if not stated.
- compulsory: true ONLY if email explicitly says mandatory/required/compulsory
- "for": Target audience — roll numbers, batch, year, department if mentioned
- "bring": Materials, documents, laptops, IDs if mentioned
- "sender": Sender email address
- "note": Extra details — registration links, contact info, prerequisites
- NEVER invent details. If not in the email, leave the field empty or "TBD".

═══ OUTPUT FORMAT ═══
Return ONLY a raw JSON array. No markdown, no explanation, no text before/after.
First character must be [, last must be ].
Each item:
{"title":"short name","time":"11:30 AM - 12:30 PM","date":"Fri 21 Aug","location":"LHC 302","category":"mandatory","compulsory":true,"bring":"","for":"","sender":"sender@example.com","note":""}

Max 20 items. Sort chronologically by date then time. If no events found, return: []`;

// Gmail query-level filter: exclude junk threads before fetch. Add more terms to the same -subject:() pattern if new junk categories appear.
const EXCLUDE = '-subject:(lost OR found OR missing OR "for sale" OR selling OR wallet OR charger OR earbuds) -subject:(hygiene OR complaint)';

const DATA_FILE = 'timetable-data.json';
const CURSOR_FILE = 'cursor.json';

function readJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseRetryDelay(body) {
  try {
    const data = JSON.parse(body);
    const details = data.error?.details || [];
    for (const d of details) {
      if (d['@type']?.includes('RetryInfo') && d.retryDelay) {
        const secs = parseInt(d.retryDelay.replace(/s$/, ''), 10);
        if (!isNaN(secs)) return secs;
      }
    }
  } catch(e) {}
  return null;
}

function extractPlainTextBody(payload) {
  if (!payload) return '';
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data;
      const nested = extractPlainTextBody(part);
      if (nested) return nested;
    }
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) return payload.body.data;
  return '';
}

function decodeGmailBody(encoded) {
  if (!encoded) return '';
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = Buffer.from(padded, 'base64').toString('utf8');
  return binary;
}

function formatEmailForGemini(messages) {
  return messages.map(msg => {
    const headers = (msg.payload?.headers || []);
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    const from = headers.find(h => h.name === 'From')?.value || '(unknown)';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    let body = decodeGmailBody(extractPlainTextBody(msg.payload));
    if (!body) body = msg.snippet || '';
    if (body.length > 1500) body = body.substring(0, 1500);
    return `From: ${from}\nDate: ${date}\nSubject: ${subject}\nBody:\n${body}`;
  }).join('\n\n---\n\n');
}

function parseGeminiResponse(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const arrayStart = clean.indexOf('[');
  const arrayEnd = clean.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1) {
    return JSON.parse(clean.substring(arrayStart, arrayEnd + 1));
  }
  return JSON.parse(clean);
}

function isJunk(evt) {
  const t = ((evt.title || '') + ' ' + (evt.note || '')).toLowerCase();
  return /lost|found|missing|sale|sell|buy|complaint|mess|hygiene|keyboard|mouse|charger|wallet|id card|hostel.*issue|food.*quality/.test(t);
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();
}

function normalizeDate(d) {
  const dayShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = {jan:'Jan',feb:'Feb',mar:'Mar',apr:'Apr',may:'May',jun:'Jun',jul:'Jul',aug:'Aug',sep:'Sep',oct:'Oct',nov:'Nov',dec:'Dec',
    january:'Jan',february:'Feb',march:'Mar',april:'Apr',june:'Jun',july:'Jul',august:'Aug',september:'Sep',october:'Oct',november:'Nov',december:'Dec'};
  const cleaned = d.replace(/[,\s]+/g,' ').trim();
  const parts = cleaned.split(' ');
  let day = null, num = null, mon = null;
  for(const p of parts) {
    const lower = p.toLowerCase();
    if(dayShort.map(d=>d.toLowerCase()).includes(lower)) day = dayShort[dayShort.map(d=>d.toLowerCase()).indexOf(lower)];
    else if(months[lower]) mon = months[lower];
    else if(/^\d{1,2}$/.test(p)) num = parseInt(p,10);
  }
  if(num && mon) return `${day || ''} ${num} ${mon}`.trim();
  return d;
}

function dedupEvents(events) {
  const seen = new Map();
  for (const e of events) {
    if(e.date) e.date = normalizeDate(e.date);
    const key = normalizeTitle(e.title) + '|' + (e.date || '') + '|' + (e.time || '');
    if (!seen.has(key)) {
      seen.set(key, e);
    } else {
      const existing = seen.get(key);
      if ((e.note||'').length > (existing.note||'').length) existing.note = e.note;
      if ((e.bring||'').length > (existing.bring||'').length) existing.bring = e.bring;
      if ((e.for||'').length > (existing.for||'').length) existing.for = e.for;
    }
  }
  return [...seen.values()];
}

function mergeEvents(existing, fresh) {
  for (const evt of fresh) {
    if (isJunk(evt)) continue;
    const eTitle = normalizeTitle(evt.title);
    const idx = existing.findIndex(e => normalizeTitle(e.title) === eTitle && e.date === evt.date);
    if (idx >= 0) {
      existing[idx] = evt;
    } else {
      existing.push(evt);
    }
  }
  return dedupEvents(existing);
}

async function main() {
  // Skip scans between 23:00 and 05:00 to save tokens
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 5) {
    console.log(`Skipping scan — it's ${hour}:00 (outside 05:00–23:00 window).`);
    return;
  }

  if (!GEMINI_API_KEY || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    console.error('Missing required env vars: GEMINI_API_KEY, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN');
    process.exit(1);
  }

  // Set up Gmail OAuth2 client
  const oauth2 = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  // Build query with cursor
  const cursor = readJSON(CURSOR_FILE, { lastMessageEpoch: null });
  let query;
  if (cursor.lastMessageEpoch) {
    query = `in:inbox after:${cursor.lastMessageEpoch} ${EXCLUDE}`;
  } else {
    query = `in:inbox newer_than:14d ${EXCLUDE}`;
  }
  console.log('Gmail query:', query);

  // Fetch message list with pagination
  let allIds = [];
  let pageToken = undefined;
  do {
    const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 75, pageToken });
    if (listRes.data.messages) allIds = allIds.concat(listRes.data.messages);
    pageToken = listRes.data.nextPageToken || null;
  } while (pageToken);
  console.log(`Found ${allIds.length} messages`);

  if (allIds.length === 0) {
    console.log('No new messages. Exiting.');
    return;
  }

  // Fetch each message with full body
  const messages = [];
  for (const { id } of allIds) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    messages.push(msg.data);
  }

  // Process in batches of 8
  const today = new Date();
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dateContext = `Today is ${dayNames[today.getDay()]}, ${today.getDate()} ${monthNames[today.getMonth()]} ${today.getFullYear()}.`;

  const CHUNK_SIZE = 8;
  const allEvents = [];
  let failedBatches = 0;
  const totalBatches = Math.ceil(messages.length / CHUNK_SIZE);
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    const batchNum = Math.floor(i / CHUNK_SIZE) + 1;
    console.log(`Processing batch ${batchNum}/${totalBatches} (${chunk.length} emails)...`);

    const emailText = formatEmailForGemini(chunk);

    let batchOk = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(GEMINI_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${dateContext}\n\n${GEMINI_PROMPT}\n\n--- EMAILS ---\n\n${emailText}` }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json'
          }
        })
      });

      if (res.status === 503) {
        const waitMs = 2000 * (attempt + 1);
        console.log(`Gemini overloaded on batch ${batchNum}/${totalBatches} — waiting ${waitMs/1000}s (attempt ${attempt + 1}/5)...`);
        await sleep(waitMs);
        continue;
      }
      if (res.status === 429) {
        const errBody = await res.text();
        const retrySecs = parseRetryDelay(errBody);
        const waitSecs = (retrySecs || 60) + 1;
        console.log(`Rate limited on batch ${batchNum}/${totalBatches} — waiting ${waitSecs}s (attempt ${attempt + 1}/5)...`);
        await sleep(waitSecs * 1000);
        continue;
      }
      if (!res.ok) {
        const err = await res.text();
        console.error(`Gemini API failed on batch ${batchNum}/${totalBatches}:`, err);
        break;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) {
        console.error(`Gemini returned empty response on batch ${batchNum}/${totalBatches}:`, JSON.stringify(data).substring(0, 500));
        break;
      }

      try {
        const parsed = parseGeminiResponse(text);
        if (Array.isArray(parsed)) allEvents.push(...parsed);
        batchOk = true;
      } catch (e) {
        console.error(`Failed to parse Gemini JSON on batch ${batchNum}/${totalBatches}:`, e.message);
        console.error('Raw response (first 500 chars):', text.substring(0, 500));
      }
      break;
    }

    if (!batchOk) failedBatches++;
    if (i + CHUNK_SIZE < messages.length) {
      console.log(`Waiting 4s before batch ${batchNum + 1}/${totalBatches}...`);
      await sleep(4000);
    }
  }

  if (failedBatches > 0) {
    console.log(`${failedBatches} of ${totalBatches} batches failed, ${allEvents.length} events still extracted from the rest`);
  }

  // Parse response
  let freshEvents = allEvents;

  if (!Array.isArray(freshEvents)) {
    console.error('Gemini returned non-array:', typeof freshEvents);
    process.exit(1);
  }

  console.log(`Gemini returned ${freshEvents.length} events`);

  // Deduplicate fresh events (same title/time from different emails)
  freshEvents = dedupEvents(freshEvents);

  // Merge into existing timetable-data.json
  const existing = readJSON(DATA_FILE, { events: [], lastSynced: null });
  existing.events = mergeEvents(existing.events || [], freshEvents);
  existing.lastSynced = Date.now();
  writeJSON(DATA_FILE, existing);
  console.log(`Wrote ${existing.events.length} total events to ${DATA_FILE}`);

  // Update cursor
  let maxEpoch = cursor.lastMessageEpoch || 0;
  for (const msg of messages) {
    const epoch = Math.floor(parseInt(msg.internalDate || '0', 10) / 1000);
    if (epoch > maxEpoch) maxEpoch = epoch;
  }
  if (maxEpoch > 0) {
    writeJSON(CURSOR_FILE, { lastMessageEpoch: maxEpoch });
    console.log(`Updated cursor to ${maxEpoch}`);
  }
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
