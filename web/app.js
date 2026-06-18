const h = React.createElement;
const root = ReactDOM.createRoot(document.querySelector("#root"));
const route = window.location.pathname === "/admin" ? "admin" : window.location.pathname === "/" ? "landing" : "user";
const mailServerHost = "mail.belfellah.tech";
const githubUrl = "https://github.com/MohammedBelfellah/Email_server";

function storageKey() {
  return route === "admin" ? "adminDashboardToken" : "userDashboardToken";
}

function useStoredToken() {
  const [token, setTokenState] = React.useState(localStorage.getItem(storageKey()) || "");

  function setToken(nextToken) {
    localStorage.setItem(storageKey(), nextToken);
    setTokenState(nextToken);
  }

  function clearToken() {
    localStorage.removeItem(storageKey());
    setTokenState("");
  }

  return [token, setToken, clearToken];
}

function App() {
  const [token, setToken, clearToken] = useStoredToken();
  const [tokenInput, setTokenInput] = React.useState(token);
  const [session, setSession] = React.useState(null);
  const [domains, setDomains] = React.useState([]);
  const [aliases, setAliases] = React.useState([]);
  const [messages, setMessages] = React.useState([]);
  const [selectedEmail, setSelectedEmail] = React.useState("");
  const [selectedMessageId, setSelectedMessageId] = React.useState("");
  const [users, setUsers] = React.useState([]);
  const [adminAliases, setAdminAliases] = React.useState([]);
  const [stats, setStats] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const [loading, setLoading] = React.useState(Boolean(token));

  const api = React.useCallback(
    async (path, options = {}) => {
      const response = await fetch(path, {
        ...options,
        headers: {
          ...(options.headers || {}),
          "X-Dashboard-Token": token
        }
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Request failed.");
      }
      return payload;
    },
    [token]
  );

  function notify(message, type = "") {
    setToast({ message, type });
    window.clearTimeout(notify.timeout);
    notify.timeout = window.setTimeout(() => setToast(null), 3200);
  }

  async function copyText(value) {
    await navigator.clipboard.writeText(value);
    notify("Copied");
  }

  async function loadUserData(options = {}) {
    const [sessionPayload, domainsPayload, aliasesPayload, messagesPayload] = await Promise.all([
      api("/api/session"),
      api("/api/domains"),
      api("/api/emails"),
      api("/api/messages")
    ]);

    setSession(sessionPayload);
    setDomains(domainsPayload.domains);
    setAliases(aliasesPayload.emails);
    setMessages(messagesPayload.messages);

    if (!options.preserveSelection) {
      setSelectedEmail("");
      setSelectedMessageId("");
    }
  }

  async function loadAdminData() {
    const [sessionPayload, domainsPayload, usersPayload, aliasesPayload, statsPayload] = await Promise.all([
      api("/api/session"),
      api("/api/domains"),
      api("/api/admin/users"),
      api("/api/admin/aliases"),
      api("/api/admin/stats")
    ]);

    setSession(sessionPayload);
    setDomains(domainsPayload.domains);
    setUsers(usersPayload.users);
    setAdminAliases(aliasesPayload.aliases);
    setStats(statsPayload.stats);
  }

  async function loadApp(options = {}) {
    if (!token) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      if (route === "admin") {
        await loadAdminData();
      } else {
        await loadUserData(options);
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadInbox(email, options = {}) {
    const payload = await api(`/api/emails/${encodeURIComponent(email)}/messages`);
    setSelectedEmail(email);
    setMessages(payload.messages);
    if (!options.preserveSelection) {
      setSelectedMessageId("");
    }
  }

  React.useEffect(() => {
    loadApp().catch((error) => {
      if (token) {
        notify(error.message, "error");
      }
    });
  }, [token]);

  React.useEffect(() => {
    if (route !== "user" || !token) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (selectedEmail) {
        loadInbox(selectedEmail, { preserveSelection: true }).catch(() => {});
      } else {
        loadUserData({ preserveSelection: true }).catch(() => {});
      }
    }, 3000);

    return () => window.clearInterval(timer);
  }, [token, selectedEmail, api]);

  function unlock(event) {
    event.preventDefault();
    setToken(tokenInput.trim());
  }

  function logout() {
    clearToken();
    setTokenInput("");
    setSession(null);
    setAliases([]);
    setMessages([]);
    setUsers([]);
    setAdminAliases([]);
    setStats(null);
  }

  async function createAlias(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") || "").trim();
    const domain = String(form.get("domain") || domains[0] || "");

    if (!name) {
      return;
    }

    try {
      const payload = await api("/api/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, domain })
      });
      formElement.reset();
      notify(`Created ${payload.email}`);
      await loadUserData({ preserveSelection: true });
      await loadInbox(payload.emailAddress.email);
    } catch (error) {
      notify(error.message, "error");
    }
  }

  async function createUser(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") || "").trim();
    const role = String(form.get("role") || "user");

    if (!name) {
      return;
    }

    try {
      const payload = await api("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, role })
      });
      formElement.reset();
      await loadAdminData();
      await copyText(payload.user.accessKey);
      notify(`Created ${payload.user.name}. Key copied.`);
    } catch (error) {
      notify(error.message, "error");
    }
  }

  async function deleteUser(user) {
    if (!window.confirm(`Delete ${user.name} and all addresses/messages owned by this user?`)) {
      return;
    }

    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE"
      });
      notify(`Deleted ${user.name}`);
      await loadAdminData();
    } catch (error) {
      notify(error.message, "error");
    }
  }

  if (route === "landing") {
    return h(LandingPage);
  }

  if (!token || !session) {
    return h(LoginPage, {
      route,
      tokenInput,
      setTokenInput,
      unlock,
      loading,
      toast
    });
  }

  if (route === "admin") {
    if (session.user.role !== "admin") {
      return h(AccessDenied, { logout, message: "This key is for a user account. Admin console requires an admin key." });
    }
    return h(AdminApp, { session, domains, users, aliases: adminAliases, stats, createUser, deleteUser, copyText, logout, toast });
  }

  if (session.user.role === "admin") {
    return h(AccessDenied, { logout, message: "Admin accounts use /admin. Use a user key for the inbox." });
  }

  const selectedMessage = messages.find((message) => message.id === selectedMessageId);
  return h(UserApp, {
    session,
    domains,
    aliases,
    messages,
    selectedEmail,
    selectedMessage,
    selectedMessageId,
    setSelectedMessageId,
    loadInbox,
    loadRecent: () => loadUserData(),
    createAlias,
    copyText,
    logout,
    toast
  });
}

function LandingPage() {
  return h(
    "main",
    { className: "landing-page" },
    h(
      "section",
      { className: "landing-hero" },
      h("h1", null, "NotMyRealEmail"),
      h("p", { className: "hero-copy" }, "Simple private disposable email for your own domains."),
      h("p", { className: "landing-meta" }, "Built by Mohammed Belfellah. Open source and free to modify."),
      h(
        "div",
        { className: "landing-actions" },
        h("a", { className: "primary-link", href: "/dashboard" }, "Open inbox"),
        h("a", { className: "secondary-link", href: "/admin" }, "Admin"),
        h("a", { className: "secondary-link", href: githubUrl, target: "_blank", rel: "noreferrer" }, "GitHub")
      )
    )
  );
}

function LoginPage({ route, tokenInput, setTokenInput, unlock, loading, toast }) {
  const isAdmin = route === "admin";
  return h(
    "main",
    { className: "login-page" },
    h(
      "section",
      { className: "login-hero" },
      h("div", { className: "brand-mark large" }, "B"),
      h("p", { className: "eyebrow" }, isAdmin ? "Admin console" : "Private inbox"),
      h("h1", null, isAdmin ? "Manage users and addresses" : "Your disposable email workspace"),
      h("p", { className: "hero-copy" }, isAdmin ? "Create accounts, copy access keys, and audit created addresses without reading inbox contents." : "Create up to five private addresses across the available domains and watch new messages arrive automatically."),
      h(
        "form",
        { className: "login-card", onSubmit: unlock },
        h("label", null, isAdmin ? "Admin key" : "Access key"),
        h("input", {
          type: "password",
          value: tokenInput,
          onChange: (event) => setTokenInput(event.target.value),
          placeholder: isAdmin ? "Paste admin key" : "Paste your user key",
          autoFocus: true
        }),
        h("button", { type: "submit" }, loading ? "Checking..." : "Enter")
      ),
      h("a", { className: "route-link", href: isAdmin ? "/" : "/admin" }, isAdmin ? "Go to user inbox" : "Go to admin console")
    ),
    toast && h("div", { className: `toast ${toast.type}`.trim() }, toast.message)
  );
}

function AccessDenied({ message, logout }) {
  return h(
    "main",
    { className: "login-page" },
    h("section", { className: "login-hero" }, h("div", { className: "brand-mark large" }, "B"), h("h1", null, "Wrong key for this page"), h("p", { className: "hero-copy" }, message), h("button", { type: "button", onClick: logout }, "Use another key"))
  );
}

function UserApp(props) {
  const remaining = Math.max(0, 5 - props.aliases.length);

  return h(
    "div",
    { className: "app-shell" },
    h(
      "aside",
      { className: "sidebar" },
      h(Brand, { domains: props.domains }),
      h(ProfileBox, { user: props.session.user, logout: props.logout }),
      h(
        "form",
        { className: "alias-form", onSubmit: props.createAlias },
        h("div", { className: "form-title" }, h("label", null, "New address"), h("span", null, `${remaining} left`)),
        h(
          "div",
          { className: "input-row alias-create-row user-create-row" },
          h("input", { name: "name", type: "text", placeholder: "instagram", disabled: remaining === 0 }),
          h("select", { name: "domain", disabled: remaining === 0 }, props.domains.map((domain) => h("option", { key: domain, value: domain }, `@${domain}`))),
          h("button", { type: "submit", disabled: remaining === 0 }, "Create")
        )
      ),
      h("div", { className: "section-heading" }, h("span", null, "Addresses"), h("button", { className: "icon-button", type: "button", onClick: props.loadRecent }, "R")),
      h(AliasList, props)
    ),
    h(
      "main",
      { className: "main" },
      h(
        "header",
        { className: "toolbar" },
        h("div", null, h("p", { className: "eyebrow" }, "User inbox"), h("h2", null, props.selectedEmail || "Recent messages")),
        h("div", { className: "toolbar-actions" }, h("button", { type: "button", onClick: props.loadRecent }, "Recent"), h("button", { type: "button", onClick: () => (props.selectedEmail ? props.loadInbox(props.selectedEmail) : props.loadRecent()) }, "Refresh"))
      ),
      h("section", { className: "content-grid" }, h(MessageList, props), h(MessageDetail, { message: props.selectedMessage }))
    ),
    props.toast && h("div", { className: `toast ${props.toast.type}`.trim() }, props.toast.message)
  );
}

function AdminApp({ session, domains, users, aliases, stats, createUser, deleteUser, copyText, logout, toast }) {
  const usersById = new Map(users.map((user) => [user.id, user]));

  return h(
    "div",
    { className: "admin-shell" },
    h(
      "header",
      { className: "admin-topbar" },
      h(Brand, { domains }),
      h("nav", null, h("a", { href: "/" }, "User inbox"), h("button", { type: "button", onClick: logout }, "Logout"))
    ),
    h(
      "main",
      { className: "admin-main" },
      h("section", { className: "admin-hero" }, h("p", { className: "eyebrow" }, `Signed in as ${session.user.name}`), h("h1", null, "Admin console"), h("p", null, "Create user accounts and audit which addresses each user owns. Message contents stay private to the user account.")),
      h(
        "section",
        { className: "admin-grid" },
        h("div", { className: "admin-panel" }, h("h3", null, "System"), h("div", { className: "stats-grid" }, h("div", null, h("strong", null, stats?.users ?? 0), h("span", null, "Users")), h("div", null, h("strong", null, stats?.aliases ?? 0), h("span", null, "Aliases")), h("div", null, h("strong", null, stats?.messages ?? 0), h("span", null, "Stored messages")))),
        h("div", { className: "admin-panel" }, h("h3", null, "Create account"), h("form", { className: "admin-form", onSubmit: createUser }, h("input", { name: "name", placeholder: "Friend name" }), h("select", { name: "role" }, h("option", { value: "user" }, "User"), h("option", { value: "admin" }, "Admin")), h("button", { type: "submit" }, "Generate key"))),
        h(DomainSetupPanel, { copyText }),
        h(
          "div",
          { className: "admin-panel wide" },
          h("h3", null, "Users"),
          h(
            "div",
            { className: "user-list" },
            users.map((user) =>
              h(
                "div",
                { key: user.id, className: "user-row" },
                h("div", null, h("strong", null, user.name), h("span", null, user.role)),
                h("code", null, user.accessKey),
                h("div", { className: "row-actions" }, h("button", { type: "button", className: "copy-button", onClick: () => copyText(user.accessKey) }, "Copy key"), h("button", { type: "button", className: "danger-button", onClick: () => deleteUser(user) }, "Delete"))
              )
            )
          )
        ),
        h(
          "div",
          { className: "admin-panel wide" },
          h("h3", null, "Created addresses"),
          h(
            "div",
            { className: "alias-table" },
            aliases.length
              ? aliases.map((alias) =>
                  h("div", { key: alias.id, className: "alias-table-row" }, h("strong", null, alias.email), h("span", null, usersById.get(alias.ownerUserId)?.name || alias.ownerName || "Unassigned"), h("button", { type: "button", className: "copy-button", onClick: () => copyText(alias.email) }, "Copy"))
                )
              : h("p", { className: "muted" }, "No addresses created yet.")
          )
        )
      )
    ),
    toast && h("div", { className: `toast ${toast.type}`.trim() }, toast.message)
  );
}

function DomainSetupPanel({ copyText }) {
  const [domainInput, setDomainInput] = React.useState("");
  const domain = normalizeSetupDomain(domainInput);
  const isValid = isValidSetupDomain(domain);
  const records = buildDnsRecords();
  const zoneText = records
    .map((record) => `${record.type} ${record.host} ${record.value}${record.priority ? ` priority ${record.priority}` : ""}`)
    .join("\n");

  return h(
    "div",
    { className: "admin-panel wide" },
    h(
      "div",
      { className: "panel-title-row" },
      h("div", null, h("h3", null, "Domain setup"), h("p", { className: "muted" }, "Type a new domain and copy the DNS records. This does not activate it automatically.")),
      isValid && h("button", { type: "button", className: "copy-button", onClick: () => copyText(zoneText) }, "Copy all")
    ),
    h(
      "div",
      { className: "domain-helper" },
      h("input", {
        type: "text",
        value: domainInput,
        onChange: (event) => setDomainInput(event.target.value),
        placeholder: "example.com"
      }),
      h("div", { className: `domain-status ${isValid ? "ready" : ""}` }, isValid ? `Ready for ${domain}` : "Enter a domain name")
    ),
    isValid &&
      h(
        "div",
        { className: "dns-table" },
        h("div", { className: "dns-row dns-head" }, h("span", null, "Type"), h("span", null, "Host"), h("span", null, "Value"), h("span", null, "Priority"), h("span", null, "TTL"), h("span", null, "")),
        records.map((record) =>
          h(
            "div",
            { key: `${record.type}-${record.value}`, className: "dns-row" },
            h("strong", null, record.type),
            h("span", null, record.host),
            h("code", null, record.value),
            h("span", null, record.priority || "-"),
            h("span", null, record.ttl),
            h("button", { type: "button", className: "copy-button", onClick: () => copyText(record.value) }, "Copy")
          )
        )
      ),
    isValid &&
      h(
        "div",
        { className: "setup-note" },
        h("strong", null, "After DNS is added: "),
        "add ",
        h("code", null, domain),
        " to ",
        h("code", null, "EMAIL_DOMAINS"),
        " on the server and restart the app when you want to activate it."
      )
  );
}

function normalizeSetupDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/^@/, "");
}

function isValidSetupDomain(domain) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain);
}

function buildDnsRecords() {
  return [
    {
      type: "MX",
      host: "@",
      value: mailServerHost,
      priority: "10",
      ttl: "Auto"
    },
    {
      type: "TXT",
      host: "@",
      value: "v=spf1 -all",
      priority: "",
      ttl: "Auto"
    }
  ];
}

function Brand() {
  return h(
    "div",
    { className: "brand" },
    h("div", { className: "brand-mark" }, "N"),
    h("div", null, h("h1", null, "NotMyRealEmail \u{1F602}"))
  );
}

function ProfileBox({ user, logout }) {
  return h("div", { className: "profile-box" }, h("div", null, h("strong", null, user.name), h("span", null, user.role)), h("button", { type: "button", className: "copy-button", onClick: logout }, "Logout"));
}

function AliasList({ aliases, selectedEmail, loadInbox, copyText, loadRecent }) {
  return h(
    "nav",
    { className: "alias-list" },
    h("button", { type: "button", className: `alias-item ${selectedEmail ? "" : "active"}`, onClick: loadRecent }, h("span", null, "Recent messages"), h("small", null, "all")),
    aliases.map((alias) =>
      h("div", { key: alias.id, className: `alias-row ${selectedEmail === alias.email ? "active" : ""}` }, h("button", { type: "button", className: "alias-open", onClick: () => loadInbox(alias.email) }, h("span", null, alias.email), h("small", null, "active")), h("button", { type: "button", className: "copy-button", onClick: () => copyText(alias.email) }, "Copy"))
    )
  );
}

function MessageList({ messages, selectedMessageId, setSelectedMessageId }) {
  if (!messages.length) {
    return h("div", { className: "message-list" }, h("div", { className: "empty-state" }, h("h3", null, "No messages"), h("p", null, "This inbox is empty.")));
  }

  return h("div", { className: "message-list" }, messages.map((message) => h("div", { key: message.id, className: `message-item ${selectedMessageId === message.id ? "active" : ""}`, onClick: () => setSelectedMessageId(message.id) }, h("strong", null, message.subject || "(no subject)"), h("span", { className: "message-meta" }, message.fromEmail || "unknown sender"), h("span", { className: "message-meta" }, `${message.toEmail} - ${formatDate(message.receivedAt)}`))));
}

function MessageDetail({ message }) {
  const [view, setView] = React.useState("preview");

  React.useEffect(() => {
    setView(message?.htmlBody ? "preview" : "text");
  }, [message?.id]);

  if (!message) {
    return h("article", { className: "message-detail" }, h("div", { className: "empty-state" }, h("h3", null, "Select a message"), h("p", null, "Choose an email from the list to read the body and headers.")));
  }

  return h(
    "article",
    { className: "message-detail" },
    h("div", { className: "detail-header" }, h("h3", null, message.subject || "(no subject)"), h("div", { className: "detail-row" }, h("strong", null, "From: "), message.fromEmail || "unknown"), h("div", { className: "detail-row" }, h("strong", null, "To: "), message.toEmail), h("div", { className: "detail-row" }, h("strong", null, "Received: "), formatDate(message.receivedAt))),
    h("div", { className: "body-tabs" }, ["preview", "text", "raw"].map((tab) => h("button", { key: tab, className: `body-tab ${view === tab ? "active" : ""}`, type: "button", onClick: () => setView(tab) }, tab[0].toUpperCase() + tab.slice(1)))),
    view === "preview" && message.htmlBody ? h("iframe", { className: "html-preview", sandbox: "", srcDoc: message.htmlBody }) : h("pre", { className: "message-body" }, view === "raw" ? message.rawEmail || "" : message.textBody || message.htmlBody || "")
  );
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

root.render(h(App));
