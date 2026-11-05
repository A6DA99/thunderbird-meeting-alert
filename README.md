# Meeting Alert for Thunderbird

**Never miss a meeting buried in your inbox.** Meeting Alert is a Thunderbird add-on that reads your incoming email, picks out meeting invitations (Google Meet, Zoom, Microsoft Teams, Webex, GoTo, Whereby), and shows them in one place with the time, join link, meeting ID and passcode. It then reminds you before each meeting starts, and clicking the reminder opens the join link.

Everything runs locally inside Thunderbird. No server, no account, no data leaves your computer.

---

## What it does

- **Finds meeting invitations automatically.** It scans your recent mail (last 14 days) and every new message as it arrives.
- **Understands many invite formats:**
  - Calendar attachments (`.ics` / `text/calendar`), time zones included
  - Structured dates in HTML emails and calendar links
  - Plain-text dates and times written in the email body
- **Pulls out the details you need:** title, start time, join link, meeting ID and passcode, each with a one-click copy button.
- **Adds a "Meetings" button to the Spaces Toolbar** (the left sidebar in Thunderbird). It opens a full dashboard and shows a badge with the number of meetings in the next 7 days.
- **Lists meetings as "Today" and "Upcoming"**, so you can see your day at a glance.
- **Sends desktop reminders:**
  - one the day before (24 hours ahead)
  - one shortly before the start, at 5, 15, 30 or 60 minutes (you pick)
  - click a reminder to open the meeting link right away
- **Tells you when a new invite arrives** with a notification.
- **Lets you dismiss** meetings you don't care about.
- **Lets you filter what gets scanned:**
  - **Senders:** all emails, or only the addresses you add (for example, your boss or a client)
  - **Accounts:** all Thunderbird accounts, or only the ones you choose
- **Rescans by itself** every 30 minutes. You can also press **Scan now**.

## Supported meeting services

Only links from these known meeting domains are accepted, so random links in an email are never treated as meetings:

| Service | Example link |
|---|---|
| Google Meet | `https://meet.google.com/abc-defg-hij` |
| Zoom | `https://zoom.us/j/…` (including company subdomains) |
| Microsoft Teams | `https://teams.microsoft.com/l/meetup-join/…`, `teams.live.com/meet/…` |
| Webex | `https://*.webex.com/meet/…` |
| GoTo Meeting | `https://meet.goto.com/…` |
| Whereby | `https://whereby.com/…` |

## Requirements

- **Thunderbird 140 or newer** (uses Manifest V3 and the Spaces Toolbar API)

## Installation

### Option 1: Try it quickly (temporary install)

1. Download or clone this repository.
2. In Thunderbird, open **Tools → Developer Tools → Debug Add-ons**.
3. Click **Load Temporary Add-on…** and select the `manifest.json` file from this folder.

A temporary add-on is removed when Thunderbird restarts.

### Option 2: Build an `.xpi` file

From the repository folder:

```bash
zip -r ../meeting-alert-0.5.3.xpi . -x "*.DS_Store" -x README.md -x ".git/*"
```

For a permanent install, Thunderbird needs a **signed** XPI. Upload it to [addons.thunderbird.net](https://addons.thunderbird.net) (listed or unlisted) to get it signed, then install it from **Tools → Add-ons and Themes → ⚙ → Install Add-on From File…**.

## How to use

1. After installing, click the **Meetings** button in the left Spaces Toolbar.
2. Press **Scan now** to check your existing mail.
3. Open **settings** (gear icon) to:
   - pick **All Emails** or **Specific senders only** and add sender addresses
   - pick **All accounts** or **Selected accounts only**
   - choose when the "starting soon" reminder fires
4. Click **Save settings**. From now on new mail is checked automatically, and you'll get reminders before your meetings.

## Privacy

- Email content is read and processed **only on your device**, inside Thunderbird.
- Found meetings and your settings are saved in the add-on's local storage.
- The add-on makes **no network requests**. The only time a browser tab opens is when you click a join link or a reminder.

### Permissions it asks for

| Permission | Why |
|---|---|
| `messagesRead` | Read emails to find meeting invitations |
| `accountsRead` | List your Thunderbird accounts for the account filter |
| `storage` | Save found meetings and settings locally |
| `alarms` | Schedule reminders and the 30-minute rescan |
| `notifications` | Show reminders and "new meeting found" alerts |
| `clipboardWrite` | Copy a join link, meeting ID or passcode |

## Project structure

```
manifest.json          Add-on manifest (id: meeting-radar@addon.local, Thunderbird 140+)
background.html/.js    Mail scanning, reminders, notifications, Spaces Toolbar button and badge
parser.js              Meeting detection: .ics parsing, date/time parsing, join links, IDs, passcodes
dashboard.html/.css    Full meetings page opened from the Spaces Toolbar
popup.html/.css/.js    Meetings list and settings UI (popup.js is shared with the dashboard)
icons/                 Add-on and toolbar icons (light and dark themes)
```

`parser.js` has no Thunderbird dependencies, so you can load it in Node.js and test it on its own:

```js
const { extractMeetings } = require("./parser.js");
console.log(extractMeetings({
  subject: "Weekly sync",
  body: "Join: https://meet.google.com/abc-defg-hij on Nov 10, 2026 at 3:00 PM"
}));
```

## Limits

- The first scan looks at the last **14 days**, up to **400 messages** per scan.
- Reminders are scheduled for meetings up to **90 days** ahead.
- Calendar attachments larger than 512 KB are skipped.

## Author

Made by [A6DA99](https://github.com/A6DA99). Issues and suggestions are welcome.
