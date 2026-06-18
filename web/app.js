const state = {
  token: localStorage.getItem("dashboardToken") || "",
  aliases: [],
  messages: [],
  selectedAlias: "",
  selectedMessageId: "",
  isRefreshing: false
};

const elements = {
  loginForm: document.querySelector("#loginForm"),
  tokenInput: document.querySelector("#tokenInput"),
  aliasForm: document.querySelector("#aliasForm"),
  aliasInput: document.querySelector("#aliasInput"),
  aliasList: document.querySelector("#aliasList"),
  messageList: document.querySelector("#messageList"),
  messageDetail: document.querySelector("#messageDetail"),
  inboxTitle: document.querySelector("#inboxTitle"),
  refreshAliases: document.querySelector("#refreshAliases"),
  refreshMessages: document.querySelector("#refreshMessages"),
  showRecent: document.querySelector("#showRecent"),
  toast: document.querySelector("#toast")
};

elements.tokenInput.value = state.token;

function showToast(message, type = "") {
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type}`.trim();
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

async function api(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
    "X-Dashboard-Token": state.token
  };

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function renderAliases() {
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = `alias-item ${state.selectedAlias ? "" : "active"}`;
  allButton.innerHTML = "<span>Recent messages</span><small>all</small>";
  allButton.addEventListener("click", () => loadRecentMessages());

  elements.aliasList.replaceChildren(
    allButton,
    ...state.aliases.map((alias) => {
      const row = document.createElement("div");
      row.className = `alias-row ${state.selectedAlias === alias.localPart ? "active" : ""}`;

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "alias-open";
      openButton.innerHTML = `<span>${alias.email}</span><small>${alias.active ? "active" : "off"}</small>`;
      openButton.addEventListener("click", () => loadInbox(alias.localPart));

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "copy-button";
      copyButton.title = `Copy ${alias.email}`;
      copyButton.textContent = "Copy";
      copyButton.addEventListener("click", async () => {
        await copyText(alias.email);
        showToast(`Copied ${alias.email}`);
      });

      row.replaceChildren(openButton, copyButton);
      return row;
    })
  );
}

function renderMessages() {
  if (!state.messages.length) {
    elements.messageList.innerHTML = '<div class="empty-state"><h3>No messages</h3><p>This inbox is empty.</p></div>';
    renderMessageDetail(null);
    return;
  }

  elements.messageList.replaceChildren(
    ...state.messages.map((message) => {
      const item = document.createElement("div");
      item.className = `message-item ${state.selectedMessageId === message.id ? "active" : ""}`;
      item.innerHTML = `
        <strong>${message.subject || "(no subject)"}</strong>
        <span class="message-meta">${message.fromEmail || "unknown sender"}</span>
        <span class="message-meta">${message.toEmail} · ${formatDate(message.receivedAt)}</span>
      `;
      item.addEventListener("click", () => {
        state.selectedMessageId = message.id;
        renderMessages();
        renderMessageDetail(message);
      });
      return item;
    })
  );
}

function renderMessageDetail(message) {
  if (!message) {
    elements.messageDetail.innerHTML = `
      <div class="empty-state">
        <h3>Select a message</h3>
        <p>Choose an email from the list to read the body and headers.</p>
      </div>
    `;
    return;
  }

  elements.messageDetail.innerHTML = `
    <div class="detail-header">
      <h3>${message.subject || "(no subject)"}</h3>
      <div class="detail-row"><strong>From:</strong> ${message.fromEmail || "unknown"}</div>
      <div class="detail-row"><strong>To:</strong> ${message.toEmail}</div>
      <div class="detail-row"><strong>Received:</strong> ${formatDate(message.receivedAt)}</div>
    </div>
    <div class="body-tabs">
      <button class="body-tab active" type="button" data-view="preview">Preview</button>
      <button class="body-tab" type="button" data-view="text">Text</button>
      <button class="body-tab" type="button" data-view="raw">Raw</button>
    </div>
    <div class="message-body-host"></div>
  `;

  const host = elements.messageDetail.querySelector(".message-body-host");
  const tabs = [...elements.messageDetail.querySelectorAll(".body-tab")];

  function setView(view) {
    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.view === view);
    });

    if (view === "preview" && message.htmlBody) {
      const iframe = document.createElement("iframe");
      iframe.className = "html-preview";
      iframe.setAttribute("sandbox", "");
      iframe.srcdoc = message.htmlBody;
      host.replaceChildren(iframe);
      return;
    }

    const pre = document.createElement("pre");
    pre.className = "message-body";
    pre.textContent = view === "raw" ? message.rawEmail || "" : message.textBody || message.htmlBody || "";
    host.replaceChildren(pre);
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  });

  setView(message.htmlBody ? "preview" : "text");
}

async function loadAliases() {
  const payload = await api("/api/emails");
  state.aliases = payload.emails;
  renderAliases();
}

async function loadRecentMessages(options = {}) {
  const previousMessageId = state.selectedMessageId;
  state.selectedAlias = "";
  elements.inboxTitle.textContent = "Recent messages";
  const payload = await api("/api/messages");
  state.messages = payload.messages;
  state.selectedMessageId = options.preserveSelection ? previousMessageId : "";
  renderAliases();
  renderMessages();

  if (state.selectedMessageId) {
    renderMessageDetail(state.messages.find((message) => message.id === state.selectedMessageId) || null);
  }
}

async function loadInbox(localPart, options = {}) {
  const previousMessageId = state.selectedMessageId;
  state.selectedAlias = localPart;
  elements.inboxTitle.textContent = `${localPart}@belfellah.tech`;
  const payload = await api(`/api/emails/${encodeURIComponent(localPart)}/messages`);
  state.messages = payload.messages;
  state.selectedMessageId = options.preserveSelection ? previousMessageId : "";
  renderAliases();
  renderMessages();

  if (state.selectedMessageId) {
    renderMessageDetail(state.messages.find((message) => message.id === state.selectedMessageId) || null);
  }
}

async function boot() {
  if (!state.token) {
    showToast("Paste the dashboard key to unlock.", "error");
    return;
  }

  await loadAliases();
  await loadRecentMessages();
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = elements.tokenInput.value.trim();
  localStorage.setItem("dashboardToken", state.token);

  try {
    await boot();
    showToast("Dashboard unlocked.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.aliasForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = elements.aliasInput.value.trim();

  if (!name) {
    return;
  }

  try {
    const payload = await api("/api/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    elements.aliasInput.value = "";
    showToast(`Created ${payload.email}`);
    await loadAliases();
    await loadInbox(payload.emailAddress.localPart);
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.refreshAliases.addEventListener("click", async () => {
  try {
    await loadAliases();
    showToast("Addresses refreshed.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.refreshMessages.addEventListener("click", async () => {
  try {
    if (state.selectedAlias) {
      await loadInbox(state.selectedAlias);
    } else {
      await loadRecentMessages();
    }
    showToast("Messages refreshed.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.showRecent.addEventListener("click", async () => {
  try {
    await loadRecentMessages();
  } catch (error) {
    showToast(error.message, "error");
  }
});

boot().catch((error) => showToast(error.message, "error"));

window.setInterval(async () => {
  if (!state.token || state.isRefreshing) {
    return;
  }

  state.isRefreshing = true;
  try {
    if (state.selectedAlias) {
      await loadInbox(state.selectedAlias, { preserveSelection: true });
    } else {
      await loadRecentMessages({ preserveSelection: true });
    }
  } catch {
    // Keep background refresh quiet; manual refresh still shows errors.
  } finally {
    state.isRefreshing = false;
  }
}, 3000);
