/* Meeting Alert runs only inside Thunderbird. Message content stays local. */
(function () {
  "use strict";

  const HISTORY_DAYS = 14;
  const MAX_MESSAGES_PER_SCAN = 400;
  const MAX_CALENDAR_BYTES = 512 * 1024;
  const DEFAULT_SETTINGS = {
    reminderMinutes: 15,
    senderScope: "all",
    allowedSenders: [],
    accountScope: "all",
    selectedAccountIds: []
  };
  const SPACE_NAME = "MeetingRadar";
  let work = Promise.resolve();
  let meetingSpaceId = null;

  const SPACE_BUTTON = {
    title: "Meetings",
    defaultIcons: "icons/meeting-dark.svg",
    themeIcons: [
      { size: 16, dark: "icons/meeting-dark.svg", light: "icons/meeting-light.svg" },
      { size: 32, dark: "icons/meeting-dark-32.svg", light: "icons/meeting-light-32.svg" }
    ]
  };
  let spaceRetry = null;

  async function mainWindowReady() {
    try {
      if (!browser.windows?.getAll) return true;
      const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
      return windows.length > 0;
    } catch { return true; }
  }

  // One attempt: adopt the existing button or create it. Returns true when it exists.
  async function ensureMeetingSpace() {
    if (!browser.spaces?.create || !browser.spaces?.query) return true;
    try {
      if (!(await mainWindowReady())) return false;
      let existing = await browser.spaces.query({ isSelfOwned: true, name: SPACE_NAME });
      if (!existing.length) {
        try {
          const created = await browser.spaces.create(SPACE_NAME,
            { url: "dashboard.html" }, SPACE_BUTTON);
          meetingSpaceId = created.id;
        } catch (error) {
          // Thunderbird may already know the space (name is unique per extension): adopt it.
          existing = await browser.spaces.query({ isSelfOwned: true, name: SPACE_NAME });
          if (!existing.length) throw error;
        }
      }
      if (existing.length) {
        meetingSpaceId = existing[0].id;
        // Refresh the button so upgrades and restarts keep the right icon/title.
        if (browser.spaces.update) await browser.spaces.update(meetingSpaceId, SPACE_BUTTON);
      }
      return true;
    } catch (error) {
      console.warn("Could not create Meeting Alert Spaces Toolbar button:", error);
      return false;
    }
  }

  // Thunderbird starts background scripts before its main window and Spaces Toolbar are
  // ready, so a single attempt at startup can fail silently. Keep retrying until it sticks.
  function ensureSpaceWithRetry() {
    if (spaceRetry) return spaceRetry;
    spaceRetry = (async () => {
      const delays = [0, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
      for (const delay of delays) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (await ensureMeetingSpace()) {
          enqueue(async () => {
            const current = await state();
            await scheduleReminders(current.meetings, current.settings); // refreshes the badge
          });
          return true;
        }
      }
      return false;
    })().finally(() => { spaceRetry = null; });
    return spaceRetry;
  }

  function enqueue(task) {
    const next = work.then(task, task);
    work = next.catch(error => console.error("Meeting Alert operation failed:", error));
    return next;
  }

  function normalizeSettings(stored = {}) {
    const senderScope = stored.senderScope === "selected" ? "selected" : "all";
    const accountScope = stored.accountScope === "selected" ? "selected" : "all";
    return {
      reminderMinutes: [5, 15, 30, 60].includes(Number(stored.reminderMinutes))
        ? Number(stored.reminderMinutes) : DEFAULT_SETTINGS.reminderMinutes,
      senderScope,
      allowedSenders: [...new Set((Array.isArray(stored.allowedSenders) ? stored.allowedSenders : [])
        .map(value => String(value).trim().toLowerCase()).filter(Boolean))],
      accountScope,
      selectedAccountIds: [...new Set((Array.isArray(stored.selectedAccountIds) ? stored.selectedAccountIds : [])
        .map(String))]
    };
  }

  async function state() {
    const data = await browser.storage.local.get(["meetings", "settings", "lastScan"]);
    return {
      meetings: data.meetings || {},
      settings: normalizeSettings(data.settings || {}),
      lastScan: data.lastScan || null
    };
  }

  async function getMailSources() {
    if (!browser.accounts?.list) return [];
    const accounts = await browser.accounts.list();
    return accounts.map(account => {
      const emails = (account.identities || []).map(identity => identity.email).filter(Boolean);
      return {
        id: String(account.id),
        name: account.name || emails[0] || "Mail account",
        email: emails.join(", ")
      };
    });
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function senderAddresses(author) {
    return String(author || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi) || [];
  }

  function senderAllowed(header, settings) {
    if (settings.senderScope !== "selected") return true;
    const allowed = new Set((settings.allowedSenders || []).map(normalizeEmail));
    if (!allowed.size) return false;
    return senderAddresses(header?.author).some(address => allowed.has(normalizeEmail(address)));
  }

  function meetingMatchesSettings(meeting, settings) {
    if (settings.senderScope === "selected" &&
        !(settings.allowedSenders || []).map(normalizeEmail).includes(normalizeEmail(meeting.senderEmail))) return false;
    if (settings.accountScope === "selected" &&
        !(settings.selectedAccountIds || []).map(String).includes(String(meeting.accountId || ""))) return false;
    return true;
  }

  async function availableSelectedAccountIds(settings) {
    if (settings.accountScope !== "selected") return null;
    const selected = new Set((settings.selectedAccountIds || []).map(String));
    const sources = await getMailSources();
    return sources.filter(account => selected.has(account.id)).map(account => account.id);
  }

  function stableKey(header, candidate) {
    if (candidate.uid) return `ics:${candidate.uid}:${candidate.recurrence || ""}`;
    const origin = header.headerMessageId || `${header.author}:${header.date}:${header.subject}`;
    return `email:${origin}:${candidate.joinUrl}`;
  }

  function collectMIME(part, parts) {
    if (!part) return;
    const type = String(part.contentType || "").toLowerCase();
    const body = typeof part.body === "string" ? part.body : "";
    if (body && type.startsWith("text/calendar")) parts.calendars.push(body);
    else if (body && type.startsWith("text/plain")) parts.plain.push(body);
    else if (body && type.startsWith("text/html")) parts.html.push(body);
    for (const child of part.parts || []) collectMIME(child, parts);
  }

  async function extractFromMessage(header) {
    const mime = await browser.messages.getFull(header.id);
    const parts = { plain: [], html: [], calendars: [] };
    collectMIME(mime, parts);
    if (browser.messages.listAttachments && browser.messages.getAttachmentFile) {
      const attachments = await browser.messages.listAttachments(header.id);
      for (const attachment of attachments.slice(0, 10)) {
        if (!/\.ics$/i.test(attachment.name || "") &&
            !/text\/calendar/i.test(attachment.contentType || "")) continue;
        if (attachment.size > MAX_CALENDAR_BYTES) continue;
        try {
          const file = await browser.messages.getAttachmentFile(header.id, attachment.partName);
          if (file.size <= MAX_CALENDAR_BYTES) parts.calendars.push(await file.text());
        } catch (error) {
          console.warn("Could not read calendar attachment:", error);
        }
      }
    }
    return MeetingParser.extractMeetings({
      subject: header.subject || "",
      body: parts.plain.join("\n"),
      html: parts.html.join("\n"),
      calendars: parts.calendars,
      receivedAt: header.date
    });
  }

  async function processHeaders(headers, existing, settings, sourceAccountId = null) {
    let inspected = 0;
    let found = 0;
    let skippedSenders = 0;
    const newlyDetected = [];
    for (const header of headers) {
      if (!header || !header.id) continue;
      if (!senderAllowed(header, settings)) {
        skippedSenders++;
        continue;
      }
      inspected++;
      try {
        const candidates = await extractFromMessage(header);
        for (const candidate of candidates) {
          const id = stableKey(header, candidate);
          if (candidate.cancelled) {
            delete existing[id];
            continue;
          }
          const old = existing[id];
          const senderEmail = senderAddresses(header.author)[0];
          const accountId = header.folder?.accountId || sourceAccountId || old?.accountId || null;
          existing[id] = {
            id,
            title: candidate.title || header.subject || "Meeting",
            sender: header.author || "Unknown sender",
            senderEmail: senderEmail ? normalizeEmail(senderEmail) : old?.senderEmail || null,
            accountId: accountId ? String(accountId) : null,
            startIso: candidate.startIso || old?.startIso || null,
            needsReview: false,
            dismissed: !!old?.dismissed,
            joinUrl: candidate.joinUrl || old?.joinUrl || null,
            passcode: candidate.passcode || old?.passcode || null,
            meetingId: candidate.meetingId || old?.meetingId || null,
            source: candidate.source || old?.source || "email",
            discoveredAt: old?.discoveredAt || new Date().toISOString()
          };
          if (!old) newlyDetected.push(existing[id]);
          found++;
        }
      } catch (error) {
        console.warn("Meeting Alert could not inspect a message:", error);
      }
    }
    return { inspected, found, skippedSenders, newlyDetected };
  }

  async function scheduleReminders(meetings, settings) {
    await browser.alarms.clearAll();
    await browser.alarms.create("meeting-radar-scan", { periodInMinutes: 30 });
    const now = Date.now();
    for (const meeting of Object.values(meetings)) {
      if (meeting.dismissed || !meetingMatchesSettings(meeting, settings) || !meeting.startIso || !meeting.joinUrl) continue;
      const start = Date.parse(meeting.startIso);
      if (!Number.isFinite(start) || start < now || start > now + 90 * 86400000) continue;
      for (const [label, offset] of [["day", 1440], ["soon", settings.reminderMinutes]]) {
        const when = start - offset * 60000;
        if (when > now) {
          await browser.alarms.create(`meeting:${encodeURIComponent(meeting.id)}:${label}`, { when });
        }
      }
    }
    const active = Object.values(meetings).filter(meeting => !meeting.dismissed && meetingMatchesSettings(meeting, settings));
    const upcoming = active.filter(meeting => {
      if (!meeting.startIso) return false;
      const start = Date.parse(meeting.startIso);
      return Number.isFinite(start) && start >= now && start < now + 7 * 86400000;
    }).length;
    const badgeText = upcoming ? String(Math.min(upcoming, 99)) : "";
    const badgeBackgroundColor = "#0A84FF";
    if (meetingSpaceId && browser.spaces?.update) {
      try {
        await browser.spaces.update(meetingSpaceId, { badgeText, badgeBackgroundColor });
      } catch (error) {
        console.warn("Could not update Spaces Toolbar badge:", error);
      }
    }
  }

  async function commit(meetings, scanDetails) {
    const current = await state();
    const updates = { meetings };
    if (scanDetails) updates.lastScan = { ...scanDetails, at: new Date().toISOString() };
    await browser.storage.local.set(updates);
    await scheduleReminders(meetings, current.settings);
  }

  async function readMessagePages(queryInfo) {
    let page = await browser.messages.query(queryInfo);
    const headers = [];
    const seenIds = new Set();
    const visitedPages = new Set();
    while (page && headers.length < MAX_MESSAGES_PER_SCAN) {
      for (const header of page.messages || []) {
        if (headers.length >= MAX_MESSAGES_PER_SCAN) break;
        if (header?.id && !seenIds.has(header.id)) {
          seenIds.add(header.id);
          headers.push(header);
        }
      }
      if (!page.id || visitedPages.has(page.id)) break;
      visitedPages.add(page.id);
      page = await browser.messages.continueList(page.id);
    }
    return headers;
  }

  async function scanRecent() {
    const current = await state();
    const after = new Date(Date.now() - HISTORY_DAYS * 86400000);
    const queryInfo = { fromDate: after };
    if (current.settings.accountScope === "selected") {
      const selectedAccounts = await availableSelectedAccountIds(current.settings);
      if (!selectedAccounts || !selectedAccounts.length) {
        const empty = { inspected: 0, found: 0, capped: false, skipped: true,
          skipReason: "No selected email accounts are currently available" };
        await commit(current.meetings, empty);
        return empty;
      }
      queryInfo.accountId = selectedAccounts;
    }
    const headers = await readMessagePages(queryInfo);
    const stats = await processHeaders(headers, current.meetings, current.settings);
    await commit(current.meetings, {
      inspected: stats.inspected,
      found: stats.found,
      skippedSenders: stats.skippedSenders,
      capped: headers.length >= MAX_MESSAGES_PER_SCAN,
      accountScope: current.settings.accountScope,
      senderScope: current.settings.senderScope
    });
    return { inspected: stats.inspected, found: stats.found,
      skippedSenders: stats.skippedSenders, capped: headers.length >= MAX_MESSAGES_PER_SCAN };
  }

  async function processNewMail(folder, page) {
    const current = await state();
    if (current.settings.accountScope === "selected") {
      const allowedAccounts = new Set((current.settings.selectedAccountIds || []).map(String));
      if (!folder?.accountId || !allowedAccounts.has(String(folder.accountId))) return;
    }
    const headers = [];
    const visitedPages = new Set();
    const seenIds = new Set();
    while (page && headers.length < 100) {
      for (const header of page.messages || []) {
        if (headers.length >= 100) break;
        if (header?.id && !seenIds.has(header.id)) {
          seenIds.add(header.id);
          headers.push(header);
        }
      }
      if (!page.id || visitedPages.has(page.id)) break;
      visitedPages.add(page.id);
      page = await browser.messages.continueList(page.id);
    }
    const result = await processHeaders(headers, current.meetings, current.settings, folder?.accountId || null);
    await commit(current.meetings);
    if (result.newlyDetected.length) {
      const message = result.newlyDetected.length === 1
        ? `${result.newlyDetected[0].title}\nOpen Meetings to see the invitation and join link.`
        : `${result.newlyDetected.length} meeting invitations found. Open Meetings to join.`;
      try {
        await browser.notifications.create(`meeting-radar-found-${Date.now()}`, {
          type: "basic",
          iconUrl: browser.runtime.getURL("icons/meeting-alert-icon-128.png"),
          title: "New meeting detected",
          message
        });
      } catch (error) {
        console.warn("Could not display new-meeting notification:", error);
      }
    }
  }

  async function notificationForAlarm(alarm) {
    if (alarm.name === "meeting-radar-scan") {
      ensureSpaceWithRetry(); // re-add the Meetings button if Thunderbird dropped it
      await scanRecent();
      return;
    }
    const match = /^meeting:(.*):(day|soon)$/.exec(alarm.name);
    if (!match) return;
    const id = decodeURIComponent(match[1]);
    const meeting = (await state()).meetings[id];
    if (!meeting || meeting.dismissed || !meeting.startIso) return;
    const when = new Date(meeting.startIso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
    const prefix = match[2] === "day" ? "Meeting tomorrow" : "Meeting starting soon";
    let accountLine = "";
    try {
      const source = meeting.accountId
        ? (await getMailSources()).find(item => item.id === String(meeting.accountId)) : null;
      if (source) accountLine = `\nAccount: ${source.email || source.name}`;
    } catch (error) {
      console.warn("Could not look up the meeting account:", error);
    }
    await browser.notifications.create(`meeting-radar:${encodeURIComponent(id)}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/meeting-alert-icon-128.png"),
      title: prefix,
      message: `${meeting.title}\n${when}${accountLine}`
    });
  }

  browser.messages.onNewMailReceived.addListener((folder, page) => {
    enqueue(() => processNewMail(folder, page));
  }, true);

  browser.alarms.onAlarm.addListener(alarm => {
    enqueue(() => notificationForAlarm(alarm));
  });

  browser.notifications.onClicked.addListener(notificationId => {
    const prefix = "meeting-radar:";
    if (!notificationId.startsWith(prefix)) return;
    enqueue(async () => {
      const id = decodeURIComponent(notificationId.slice(prefix.length));
      const meeting = (await state()).meetings[id];
      if (meeting?.joinUrl && MeetingParser.validMeetingLink(meeting.joinUrl)) {
        await browser.tabs.create({ url: meeting.joinUrl });
      }
    });
  });

  browser.runtime.onMessage.addListener(request => enqueue(async () => {
    const current = await state();
    switch (request?.type) {
      case "getState":
        return current;
      case "getMailSources":
        return await getMailSources();
      case "scan":
        await scanRecent();
        return await state();
      case "dismiss": {
        const meeting = current.meetings[request.id];
        if (!meeting) throw new Error("Meeting not found.");
        meeting.dismissed = !!request.dismissed;
        await commit(current.meetings);
        return await state();
      }
      case "settings": {
        const minutes = Number(request.reminderMinutes ?? current.settings.reminderMinutes);
        if (![5, 15, 30, 60].includes(minutes)) throw new Error("Invalid reminder time.");
        const senderScope = request.senderScope || current.settings.senderScope;
        const accountScope = request.accountScope || current.settings.accountScope;
        if (!["all", "selected"].includes(senderScope) || !["all", "selected"].includes(accountScope)) {
          throw new Error("Invalid email scanning option.");
        }
        const allowedSenders = Array.isArray(request.allowedSenders)
          ? [...new Set(request.allowedSenders.map(normalizeEmail).filter(Boolean))]
          : current.settings.allowedSenders;
        const selectedAccountIds = Array.isArray(request.selectedAccountIds)
          ? [...new Set(request.selectedAccountIds.map(String))]
          : current.settings.selectedAccountIds;
        if (senderScope === "selected" && !allowedSenders.length) {
          throw new Error("Add at least one sender email address.");
        }
        if (senderScope === "selected" && allowedSenders.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
          throw new Error("Enter valid sender email addresses.");
        }
        if (accountScope === "selected" && !selectedAccountIds.length) {
          throw new Error("Select at least one email account.");
        }
        current.settings = normalizeSettings({
          reminderMinutes: minutes, senderScope, allowedSenders, accountScope, selectedAccountIds
        });
        await browser.storage.local.set({ settings: current.settings });
        await scheduleReminders(current.meetings, current.settings);
        return await state();
      }
      default:
        throw new Error("Unknown request.");
    }
  }));

  ensureSpaceWithRetry();
  if (browser.windows?.onCreated) browser.windows.onCreated.addListener(() => { ensureSpaceWithRetry(); });
  enqueue(async () => {
    const current = await state();
    await scheduleReminders(current.meetings, current.settings);
    try {
      await scanRecent();
    } catch (error) {
      console.warn("Initial meeting scan failed; retry with Scan Now:", error);
    }
  });
})();
