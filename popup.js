(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  let data = {
    meetings: {},
    settings: {
      reminderMinutes: 15,
      senderScope: "all",
      allowedSenders: [],
      accountScope: "all",
      selectedAccountIds: []
    },
    lastScan: null
  };
  let mailSources = [];
  let selectedSenders = new Set();
  let selectedAccounts = new Set();

  function text(tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function button(label, handler, className) {
    const element = text("button", label, className);
    element.type = "button";
    element.addEventListener("click", handler);
    return element;
  }

  function dateLabel(iso) {
    if (!iso || !Number.isFinite(Date.parse(iso))) return "Date and time not included in the email";
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short"
    });
  }

  async function send(request) {
    try {
      const result = await browser.runtime.sendMessage(request);
      if (result && result.meetings) {
        data = result;
        selectedSenders = new Set(data.settings.allowedSenders || []);
        selectedAccounts = new Set(data.settings.selectedAccountIds || []);
        render();
        if (!$("settingsPanel").hidden) renderSenderList();
      }
      return result;
    } catch (error) {
      if ($("status")) $("status").textContent = `Error: ${error.message || error}`;
      throw error;
    }
  }

  function localDayKey(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function accountLabel(accountId) {
    if (!accountId) return "";
    const account = mailSources.find(source => String(source.id) === String(accountId));
    if (!account) return "Account no longer available";
    const name = String(account.name || "").trim();
    const email = String(account.email || "").trim();
    if (name && email && !email.toLowerCase().includes(name.toLowerCase())) return `${name} (${email})`;
    return name || email || "Mail account";
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    copy: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
    check: ["m5 12.5 4.5 4.5L19 7.5"],
    video: ["M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5Z", "m15 10.5 6-3.5v10l-6-3.5"],
    key: ["M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M10.9 12.1 20 3", "M16.5 6.5l3 3"],
    hash: ["M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"]
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("mi");
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function providerOf(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.endsWith("zoom.us")) return "Zoom";
      if (host === "meet.google.com") return "Google Meet";
      if (host.includes("teams.")) return "Microsoft Teams";
      if (host.endsWith("webex.com")) return "Webex";
      if (host === "meet.goto.com") return "GoTo Meeting";
      if (host === "whereby.com") return "Whereby";
      return host;
    } catch { return "Meeting link"; }
  }

  function prettyLink(url) {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname}`.replace(/\/$/, "");
    } catch { return url; }
  }

  async function copyText(value, trigger) {
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; }
    catch {
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch { ok = false; }
    }
    trigger.classList.toggle("done", ok);
    trigger.replaceChildren(icon(ok ? "check" : "copy"));
    trigger.title = ok ? "Copied" : "Could not copy";
    setTimeout(() => {
      trigger.classList.remove("done");
      trigger.replaceChildren(icon("copy"));
      trigger.title = trigger.dataset.label;
    }, 1400);
  }

  function copyButton(value, label) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-button";
    copy.title = label;
    copy.dataset.label = label;
    copy.setAttribute("aria-label", label);
    copy.append(icon("copy"));
    copy.addEventListener("click", () => copyText(value, copy));
    return copy;
  }

  function linkRow(url) {
    const row = document.createElement("div");
    row.className = "link-row";
    const badge = document.createElement("span");
    badge.className = "provider-icon";
    badge.append(icon("video"));
    const copy = document.createElement("div");
    copy.className = "link-copy";
    copy.append(text("span", providerOf(url), "provider-name"));
    const anchor = text("a", prettyLink(url), "link-url");
    anchor.href = "#";
    anchor.title = url;
    anchor.addEventListener("click", event => {
      event.preventDefault();
      browser.tabs.create({ url });
    });
    copy.append(anchor);
    row.append(badge, copy, copyButton(url, "Copy meeting link"));
    return row;
  }

  function fieldChip(iconName, label, value, copyLabel, className) {
    const chip = document.createElement("div");
    chip.className = `field-chip ${className || ""}`.trim();
    const top = document.createElement("div");
    top.className = "field-top";
    top.append(icon(iconName), text("span", label, "field-label"));
    const body = document.createElement("div");
    body.className = "field-body";
    const val = text("span", value, "field-value");
    val.title = value;
    body.append(val, copyButton(value, copyLabel));
    chip.append(top, body);
    return chip;
  }

  function createMeeting(meeting) {
    const card = document.createElement("article");
    card.className = "meeting";
    const main = document.createElement("div");
    main.className = "meeting-main";
    main.append(text("h3", meeting.title || "Meeting"));
    if (meeting.sender) main.append(text("div", `From: ${meeting.sender}`, "meta"));
    const account = accountLabel(meeting.accountId);
    if (account) {
      const badge = text("div", `Account: ${account}`, "account-badge");
      badge.title = `This invitation arrived in ${account}`;
      main.append(badge);
    }
    const knownDate = meeting.startIso && Number.isFinite(Date.parse(meeting.startIso));
    main.append(text("div", dateLabel(knownDate ? meeting.startIso : null), `time${knownDate ? "" : " unknown"}`));
    card.append(main);

    const actions = document.createElement("div");
    actions.className = "meeting-actions";
    const join = button("Join Meeting", () => {
      if (meeting.joinUrl) browser.tabs.create({ url: meeting.joinUrl });
    }, "join-button");
    join.disabled = !meeting.joinUrl;
    join.title = meeting.joinUrl ? "Open the meeting link" : "No meeting link was found";
    actions.append(join);
    actions.append(button("×", () => send({
      type: "dismiss", id: meeting.id, dismissed: true
    }), "dismiss-button"));
    card.append(actions);
    if (meeting.joinUrl || meeting.meetingId || meeting.passcode) {
      const details = document.createElement("div");
      details.className = "meeting-details";
      if (meeting.joinUrl) details.append(linkRow(meeting.joinUrl));
      if (meeting.meetingId || meeting.passcode) {
        const fields = document.createElement("div");
        fields.className = "field-grid";
        if (meeting.meetingId) fields.append(fieldChip("hash", "Meeting ID", meeting.meetingId, "Copy meeting ID"));
        if (meeting.passcode) fields.append(fieldChip("key", "Passcode", meeting.passcode, "Copy passcode", "passcode"));
        details.append(fields);
      }
      card.append(details);
    }
    return card;
  }

  function renderSection(listId, meetings, emptyMessage) {
    const list = $(listId);
    list.replaceChildren();
    if (!meetings.length) {
      list.append(text("div", emptyMessage, "empty"));
      return;
    }
    for (const meeting of meetings) list.append(createMeeting(meeting));
  }

  function render() {
    const now = new Date();
    const allowedSenders = new Set((data.settings.allowedSenders || []).map(value => String(value).toLowerCase()));
    const selectedAccounts = new Set((data.settings.selectedAccountIds || []).map(String));
    const all = Object.values(data.meetings || {}).filter(meeting => {
      if (meeting.dismissed) return false;
      if (data.settings.senderScope === "selected" && !allowedSenders.has(String(meeting.senderEmail || "").toLowerCase())) return false;
      if (data.settings.accountScope === "selected" && !selectedAccounts.has(String(meeting.accountId || ""))) return false;
      return true;
    });
    const todayKey = localDayKey(now);
    const today = all.filter(meeting => meeting.startIso && Number.isFinite(Date.parse(meeting.startIso)) &&
      localDayKey(meeting.startIso) === todayKey);
    const upcoming = all.filter(meeting => {
      if (!meeting.startIso || !Number.isFinite(Date.parse(meeting.startIso))) return true;
      return localDayKey(meeting.startIso) !== todayKey && new Date(meeting.startIso) > now;
    });
    today.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
    upcoming.sort((a, b) => {
      const aTime = a.startIso && Number.isFinite(Date.parse(a.startIso)) ? Date.parse(a.startIso) : Infinity;
      const bTime = b.startIso && Number.isFinite(Date.parse(b.startIso)) ? Date.parse(b.startIso) : Infinity;
      return aTime - bTime;
    });
    $("todayCount").textContent = String(today.length);
    $("upcomingCount").textContent = String(upcoming.length);
    renderSection("todayList", today, "No meetings scheduled for today.");
    renderSection("upcomingList", upcoming, "No upcoming meetings found.");
    $("reminder").value = String(data.settings.reminderMinutes || 15);
    if (data.lastScan && $("status")) {
      const scan = data.lastScan;
      const suffix = scan.capped ? " · message limit reached" : "";
      const skipped = scan.skipped ? ` · ${scan.skipReason || "selected accounts are unavailable"}` : "";
      $("status").textContent = `Last scan ${new Date(scan.at).toLocaleTimeString()} · ${scan.inspected} emails scanned${suffix}${skipped}`;
    }
  }

  function parseEmailInput(value) {
    return String(value || "").split(/[\s,;]+/).map(email => email.trim().toLowerCase()).filter(Boolean);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function renderSenderList() {
    const list = $("senderList");
    list.replaceChildren();
    if (!selectedSenders.size) {
      list.append(text("p", "No sender addresses added yet.", "muted sender-empty"));
      return;
    }
    for (const email of [...selectedSenders].sort()) {
      const chip = document.createElement("span");
      chip.className = "sender-chip";
      chip.append(text("span", email));
      chip.append(button("×", () => {
        selectedSenders.delete(email);
        renderSenderList();
      }, "chip-remove"));
      list.append(chip);
    }
  }

  function addSenderAddresses() {
    const emails = parseEmailInput($("senderEmail").value);
    if (!emails.length) {
      $("status").textContent = "Enter at least one sender email address.";
      return;
    }
    const invalid = emails.filter(email => !isValidEmail(email));
    if (invalid.length) {
      $("status").textContent = `Invalid email address: ${invalid[0]}`;
      return;
    }
    for (const email of emails) selectedSenders.add(email);
    $("senderEmail").value = "";
    $("status").textContent = "";
    renderSenderList();
  }

  function renderSources() {
    const list = $("sourceList");
    list.replaceChildren();
    if (!mailSources.length) {
      list.append(text("p", "No Thunderbird email accounts were found.", "muted"));
      return;
    }
    for (const account of mailSources) {
      const label = document.createElement("label");
      label.className = "source-account-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selectedAccounts.has(String(account.id));
      input.addEventListener("change", () => {
        if (input.checked) selectedAccounts.add(String(account.id));
        else selectedAccounts.delete(String(account.id));
      });
      const accountText = document.createElement("span");
      accountText.className = "account-copy";
      accountText.append(text("strong", account.name || "Email account"));
      if (account.email) accountText.append(text("small", account.email));
      label.append(input, accountText);
      list.append(label);
    }
  }

  async function loadMailSources() {
    $("sourceList").replaceChildren(text("p", "Loading email accounts…", "muted"));
    try {
      mailSources = await browser.runtime.sendMessage({ type: "getMailSources" });
      const availableIds = new Set(mailSources.map(account => String(account.id)));
      selectedAccounts = new Set([...selectedAccounts].filter(id => availableIds.has(String(id))));
      renderSources();
    } catch (error) {
      $("sourceList").replaceChildren(text("p", `Could not load email accounts: ${error.message || error}`, "muted"));
    }
  }

  function updateFilterVisibility() {
    $("senderPicker").hidden = !$("senderSelected").checked;
    $("accountPicker").hidden = !$("accountSelected").checked;
  }

  async function openSettings() {
    const panel = $("settingsPanel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      $("senderAll").checked = data.settings.senderScope !== "selected";
      $("senderSelected").checked = data.settings.senderScope === "selected";
      $("accountAll").checked = data.settings.accountScope !== "selected";
      $("accountSelected").checked = data.settings.accountScope === "selected";
      selectedSenders = new Set(data.settings.allowedSenders || []);
      selectedAccounts = new Set(data.settings.selectedAccountIds || []);
      updateFilterVisibility();
      renderSenderList();
      await loadMailSources();
    }
  }

  $("scan").addEventListener("click", async () => {
    const scanButton = $("scan");
    scanButton.disabled = true;
    scanButton.textContent = "Scanning…";
    $("status").textContent = "Checking recent email for meeting invitations…";
    try { await send({ type: "scan" }); }
    finally { scanButton.disabled = false; scanButton.textContent = "Scan now"; }
  });
  $("toggleSettings").addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", () => { $("settingsPanel").hidden = true; });
  $("senderAll").addEventListener("change", updateFilterVisibility);
  $("senderSelected").addEventListener("change", updateFilterVisibility);
  $("accountAll").addEventListener("change", updateFilterVisibility);
  $("accountSelected").addEventListener("change", updateFilterVisibility);
  $("addSender").addEventListener("click", addSenderAddresses);
  $("senderEmail").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      addSenderAddresses();
    }
  });
  $("refreshSources").addEventListener("click", loadMailSources);
  $("saveSettings").addEventListener("click", async () => {
    const senderScope = $("senderSelected").checked ? "selected" : "all";
    const accountScope = $("accountSelected").checked ? "selected" : "all";
    const allowedSenders = [...selectedSenders];
    const selectedAccountIds = [...selectedAccounts];
    if (senderScope === "selected" && !allowedSenders.length) {
      $("status").textContent = "Add at least one sender email address.";
      return;
    }
    if (accountScope === "selected" && !selectedAccountIds.length) {
      $("status").textContent = "Select at least one Thunderbird email account.";
      return;
    }
    const save = $("saveSettings");
    save.disabled = true;
    try {
      await send({
        type: "settings", senderScope, allowedSenders, accountScope, selectedAccountIds,
        reminderMinutes: Number($("reminder").value)
      });
      $("settingsPanel").hidden = true;
      $("status").textContent = "Settings saved. Click Scan now to check existing mail.";
    } finally { save.disabled = false; }
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.meetings) data.meetings = changes.meetings.newValue || {};
    if (changes.settings) {
      data.settings = { ...data.settings, ...(changes.settings.newValue || {}) };
      selectedSenders = new Set(data.settings.allowedSenders || []);
      selectedAccounts = new Set(data.settings.selectedAccountIds || []);
      if (!$("settingsPanel").hidden) {
        renderSenderList();
        renderSources();
      }
    }
    if (changes.lastScan) data.lastScan = changes.lastScan.newValue || null;
    if (changes.meetings || changes.settings || changes.lastScan) render();
  });
  send({ type: "getState" });
  browser.runtime.sendMessage({ type: "getMailSources" })
    .then(sources => { mailSources = Array.isArray(sources) ? sources : []; render(); })
    .catch(error => console.warn("Could not load email accounts for labels:", error));
})();
