# DettyPot website

The waitlist page: one page, one job, getting people on the waitlist. Emails go
into a Google Sheet through a small Google Apps Script. There's no backend
involved yet.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-checks, then builds to dist/ (a static site)
```

Without `VITE_WAITLIST_URL`, the dev server pretends to save emails (and logs
them in the browser console), so the page can be tried out. A production build
without it shows an error on submit instead of losing emails silently.

## Connecting the Google Sheet (once)

1. Create a Google Sheet, for example "DettyPot waitlist".
2. **Extensions → Apps Script**. Replace everything there with
   [`google-sheets/waitlist.gs`](google-sheets/waitlist.gs) and save.
3. **Deploy → New deployment**. Type: **Web app**. Execute as: **Me**. Who has
   access: **Anyone**. Deploy, and approve the permissions it asks for (it only
   touches this one sheet).
4. Copy the **Web app URL** (it ends in `/exec`) into `web/.env`:
   ```
   VITE_WAITLIST_URL=https://script.google.com/macros/s/…/exec
   ```
5. Restart `npm run dev` and sign up with your own email. A **Waitlist** tab
   appears in the sheet with your row.

After changing the script, use **Deploy → Manage deployments → Edit → New
version**, so the URL stays the same.

What the script does: saves each email once (lower-cased), records the time,
`?utm_source=` or `?ref=` from the link, and the referring page; ignores bots
that fill in a hidden field; and stops anything typed in from running as a
spreadsheet formula.

## Design

Same DettyPot identity: dark by default with a light mode (follows the device,
with a toggle), the orange → coral → gold gradient, Bricolage Grotesque for
headings and Outfit for text. Buttons use dark text on the gradient, which
fixes the old site's low contrast. The pot card, group chat and planner answer
on the page are illustrations with sample names and numbers.
