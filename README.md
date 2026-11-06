# Hygiene Records

Digital food hygiene records for restaurants and hospitality: temperature logs and cleaning checklists, signed and time-stamped per person, with inspector-ready reports.

No dependencies. Needs Node 22.5 or newer (uses the built-in SQLite).

## Run

    npm start          # http://localhost:3000
    npm test           # end-to-end API tests

Open it on a phone and use "Add to Home Screen" to install it like an app.

First visit: tap "Set up a new business". You get starter fridges/freezers/hot-hold and Opening, Closing and Weekly deep clean checklists to edit under Setup.

## Config (environment variables)

- `PORT` (default 3000)
- `DB_FILE` (default `data/hygiene.db`)
- `TZ_DEFAULT` (default `Europe/London`, used for "today" and the date on each record)

## What's included

- Temperature logging per fridge, freezer or hot-hold unit with safe ranges. Out-of-range readings require a corrective action.
- Daily and weekly checklists. Every item is ticked or explained, then signed off by the logged-in user.
- Today dashboard showing what's due, done or out of range.
- Reports by date range: on-screen, print / save as PDF, and CSV export.
- Owner and staff roles, each person with their own login. Owners manage equipment, checklists and team.
- Records are append-only: no edit or delete, and checklist/equipment edits never change past records.

## Before going live

- Serve behind HTTPS (e.g. Caddy or nginx in front of this server). Sessions use bearer tokens in localStorage.
- Back up `data/hygiene.db` regularly.
- Check your local rules (UK: Safer Food Better Business / HACCP; US: local health code) and tune ranges and checklists to match.

## Ideas for next steps

Photo evidence, delivery/goods-in checks, allergen matrix, supplier records, probe/Bluetooth sensors, push reminders for overdue checks, multi-site dashboards, password reset email.
