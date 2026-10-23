const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
  maxSteps: 10,
  reviewClicks: false
};

let agentState = { messages: [], events: [], running: false, step: 0, maxSteps: 10, pendingApproval: null };
let lastMessagesKey = "";
let panelPort = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let connectionNotice = "";

// Covers a brief gap (e.g. service worker restart) before falling back to slower retries.
const RECONNECT_DELAYS = [150, 400, 1000, 2500, 5000];

function extensionContextValid() {
  try { return Boolean(chrome?.runtime?.id); } catch { return false; }
}

function handlePortMessage(message) {
  if (message.type === "state") {
    agentState = message;
    connectionNotice = "";
    render();
  } else if (message.type === "preview") {
    const hasImage = Boolean(message.dataUrl);
    $("screenshotPreview").classList.toggle("hidden", !hasImage);
    $("previewEmpty").classList.toggle("hidden", hasImage);
    if (hasImage) $("screenshotPreview").src = message.dataUrl;
    else $("screenshotPreview").removeAttribute("src");
  }
}

function connect() {
  if (panelPort) return true;
  let port;
  try {
    port = chrome.runtime.connect({ name: "visual-agent-panel" });
  } catch {
    return false;
  }
  panelPort = port;
  reconnectAttempt = 0;
  connectionNotice = "";
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  port.onMessage.addListener((message) => {
    if (port === panelPort) handlePortMessage(message);
  });
  port.onDisconnect.addListener(() => {
    // Reading lastError prevents an "Unchecked runtime.lastError" console warning.
    try { void chrome.runtime.lastError; } catch { /* Context already invalidated. */ }
    if (port !== panelPort) return;
    panelPort = null;
    // The background cancels any active run when the panel goes away, so the
    // controls should not stay stuck in their busy state.
    agentState = { ...agentState, running: false, pendingApproval: null };
    scheduleReconnect();
  });
  return true;
}

function scheduleReconnect() {
  if (reconnectTimer !== null || panelPort) return;
  if (!extensionContextValid()) {
    // The extension was reloaded/removed: only a panel reload can reconnect.
    connectionNotice = "Extension updated. Reload this panel to reconnect.";
    render();
    return;
  }
  connectionNotice = "Reconnecting to the extension…";
  render();
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!connect()) scheduleReconnect();
  }, delay);
}

function ensureConnected() {
  if (panelPort) return true;
  if (connect()) return true;
  scheduleReconnect();
  return false;
}

function postToBackground(message) {
  if (!ensureConnected()) return false;
  try {
    panelPort.postMessage(message);
    return true;
  } catch {
    panelPort = null;
    scheduleReconnect();
    return false;
  }
}

function isSlashCommand(text) {
  const command = String(text ?? "").trim().toLowerCase();
  return command === "/clear" || command === "/stop";
}

function refreshSendButton() {
  // Commands stay usable during a run, just like the Stop button.
  $("sendButton").disabled = agentState.running && !isSlashCommand($("prompt").value);
}

function render() {
  const { messages, events, running, step, maxSteps, pendingApproval } = agentState;
  $("welcome").classList.toggle("hidden", messages.length > 0);
  refreshSendButton();
  $("stopButton").classList.toggle("hidden", !running);
  $("clearChat").disabled = running;
  $("statusDot").classList.toggle("busy", running && !connectionNotice);
  $("statusDot").classList.toggle("offline", Boolean(connectionNotice));
  $("stepCounter").textContent = running ? `${step}/${maxSteps}` : "";
  $("statusText").textContent = connectionNotice || (running ? (events.at(-1)?.text || "Working…") : "Ready to inspect a page");
  $("approvalPanel").classList.toggle("hidden", !pendingApproval);
  if (pendingApproval) {
    const typing = pendingApproval.action === "type";
    $("approvalTitle").textContent = typing ? "Approve next typing?" : "Approve next click?";
    $("approveClick").textContent = typing ? "Approve typing" : "Approve click";
    $("approvalDescription").textContent = `${pendingApproval.description} — at (${pendingApproval.x}, ${pendingApproval.y})`;
  }

  const messagesKey = JSON.stringify(messages.map((m) => m.id));
  if (messagesKey !== lastMessagesKey) {
    lastMessagesKey = messagesKey;
    const box = $("messages");
    box.replaceChildren();
    for (const msg of messages) {
      const wrapper = document.createElement("article");
      wrapper.className = `message ${msg.role === "user" ? "user" : "assistant"}`;
      const role = document.createElement("span");
      role.className = "message-role";
      role.textContent = msg.role === "user" ? "You" : "Visual Agent";
      const content = document.createElement("div");
      content.className = "message-text";
      content.textContent = msg.text;
      const time = document.createElement("span");
      time.className = "message-time";
      time.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      wrapper.append(role, content, time);
      box.append(wrapper);
    }
    $("conversation").scrollTop = $("conversation").scrollHeight;
  }

  const log = $("activityLog");
  log.replaceChildren();
  for (const event of events) {
    const line = document.createElement("li");
    line.textContent = event.text;
    log.append(line);
  }
}

function sendQuery() {
  const text = $("prompt").value.trim();
  if (!text) return;
  // While a task is running only slash commands are accepted; the background
  // treats them exactly like the Stop and Clear chat buttons.
  if (agentState.running && !isSlashCommand(text)) return;
  if (!postToBackground({ type: "run", text })) return;
  $("prompt").value = "";
  refreshSendButton();
}

function endpointURL(value) {
  const url = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use HTTPS (HTTP is permitted only for localhost).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API URL cannot include credentials, a query, or a fragment.");
  }
  // Chrome match patterns don't specify ports; localhost permission covers any port.
  return `${url.protocol}//${url.hostname}/*`;
}

async function loadSettings() {
  const data = { ...DEFAULTS, ...await chrome.storage.local.get(DEFAULTS) };
  $("endpoint").value = data.endpoint;
  $("model").value = data.model;
  $("apiKey").value = data.apiKey;
  $("maxSteps").value = String(data.maxSteps);
  $("reviewClicks").checked = Boolean(data.reviewClicks);
}

async function saveSettings() {
  const status = $("settingsMessage");
  status.textContent = "";
  status.classList.remove("error");
  const settings = {
    endpoint: $("endpoint").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value.trim(),
    maxSteps: Number($("maxSteps").value),
    reviewClicks: $("reviewClicks").checked
  };
  try {
    if (!settings.model) throw new Error("Enter a vision model name.");
    const pattern = endpointURL(settings.endpoint);
    // The permission prompt is initiated by this direct Save button gesture.
    const allowed = await chrome.permissions.request({ origins: [pattern] });
    if (!allowed) throw new Error("Host access was not granted. The extension cannot call that API.");
    await chrome.storage.local.set(settings);
    status.textContent = "Saved. This endpoint is ready for screenshots.";
  } catch (error) {
    status.textContent = error.message || String(error);
    status.classList.add("error");
  }
}

async function updateTabLabel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $("tabTitle").textContent = tab ? (tab.title || tab.url || `Tab ${tab.id}`) : "No active tab";
    $("tabTitle").title = tab?.url || "";
  } catch {
    $("tabTitle").textContent = "Tab unavailable";
  }
}

$("settingsToggle").addEventListener("click", () => {
  $("settingsPanel").classList.toggle("hidden");
});
$("settingsClose").addEventListener("click", () => $("settingsPanel").classList.add("hidden"));
$("saveSettings").addEventListener("click", saveSettings);
$("refreshTab").addEventListener("click", updateTabLabel);
$("exampleQuery").addEventListener("click", () => {
  $("prompt").value = "Go to amazon.com and search for a blue mug";
  $("prompt").focus();
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  sendQuery();
});
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendQuery();
  }
});
$("prompt").addEventListener("input", refreshSendButton);
$("stopButton").addEventListener("click", () => postToBackground({ type: "stop" }));
$("clearChat").addEventListener("click", () => postToBackground({ type: "clear" }));
$("approveClick").addEventListener("click", () => postToBackground({ type: "approve", approved: true }));
$("denyClick").addEventListener("click", () => postToBackground({ type: "approve", approved: false }));
chrome.tabs.onActivated.addListener(updateTabLabel);
chrome.tabs.onUpdated.addListener((_, changeInfo, tab) => {
  if (changeInfo.title || changeInfo.status === "complete") void updateTabLabel();
});

ensureConnected();
void loadSettings();
void updateTabLabel();
