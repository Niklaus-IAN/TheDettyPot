/**
 * DettyPot waitlist: saves emails from the website into this Google Sheet.
 *
 * Setup (once): open the Sheet → Extensions → Apps Script → paste this file →
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone →
 * copy the web app URL into the website's VITE_WAITLIST_URL.
 *
 * Each email is saved once (lower-cased). Rows: time, email, source, referrer.
 */
const SHEET_NAME = "Waitlist";
const HEADERS = ["Joined at", "Email", "Source", "Referrer"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // one write at a time, so the same email can't sneak in twice
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    // A hidden field only bots fill in: pretend it worked, save nothing.
    if (body.website) return reply({ ok: true });

    const email = String(body.email || "").trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) return reply({ ok: false, error: "invalid_email" });

    const sheet = waitlistSheet();
    const rows = sheet.getLastRow();
    if (rows > 1) {
      const found = sheet.getRange(2, 2, rows - 1, 1).createTextFinder(email).matchEntireCell(true).findNext();
      if (found) return reply({ ok: true, duplicate: true });
    }
    sheet.appendRow([new Date(), safe(email, 254), safe(body.source, 100), safe(body.referrer, 300)]);
    return reply({ ok: true });
  } catch (err) {
    console.error(err);
    return reply({ ok: false, error: "server_error" });
  } finally {
    lock.releaseLock();
  }
}

function waitlistSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Text from the internet must never run as a spreadsheet formula. */
function safe(value, max) {
  const text = String(value == null ? "" : value).slice(0, max);
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

function reply(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
