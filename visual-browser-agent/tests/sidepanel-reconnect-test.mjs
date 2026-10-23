// Offline test of the side panel's service-worker reconnect handling.
// Run with: node tests/sidepanel-reconnect-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = fs.readFileSync(path.join(here, "..", "sidepanel.js"), "utf8");

function event() {
  const callbacks = [];
  return {
    addListener: (fn) => callbacks.push(fn),
    fire: (...args) => callbacks.forEach((fn) => fn(...args))
  };
}

function element() {
  const classes = new Set();
  const el = {
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    src: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      }
    },
    addEventListener: () => {},
    removeAttribute: (name) => { if (name === "src") el.src = ""; },
    replaceChildren: () => {},
    append: () => {},
    focus: () => {}
  };
  return el;
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ contextValid = true } = {}) {
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: () => element()
  };
  // Mirror the initial status text from sidepanel.html.
  document.getElementById("statusText").textContent = "Ready to inspect a page";

  let connectCalls = 0;
  let currentPort;
  let contextId = "test-extension";

  const chrome = {
    runtime: {
      get id() { return contextId; },
      get lastError() { return undefined; },
      connect: () => {
        if (!contextId) throw new Error("Extension context invalidated.");
        connectCalls++;
        currentPort = {
          name: "visual-agent-panel",
          posted: [],
          onMessage: event(),
          onDisconnect: event(),
          postMessage(message) { this.posted.push(message); }
        };
        return currentPort;
      }
    },
    storage: { local: { get: async (defaults) => ({ ...defaults }), set: async () => {} } },
    tabs: {
      query: async () => [{ title: "Example", url: "https://example.com" }],
      onActivated: event(),
      onUpdated: event()
    }
  };

  vm.runInNewContext(panelSource, {
    chrome, document, setTimeout, clearTimeout, console, URL, Date, JSON,
    Boolean, String, Number, Array, Promise
  }, { filename: "sidepanel.js" });

  return {
    elements,
    status: () => elements.get("statusText").textContent,
    sendDisabled: () => elements.get("sendButton").disabled,
    dotOffline: () => elements.get("statusDot").classList.contains("offline"),
    get connectCalls() { return connectCalls; },
    get port() { return currentPort; },
    disconnect: () => currentPort.onDisconnect.fire(),
    sendState: (state) => currentPort.onMessage.fire({ type: "state", ...state }),
    invalidateContext: () => { contextId = ""; }
  };
}

const auto = harness();
await tick(0);
assert.equal(auto.connectCalls, 1, "Panel connects on load");
assert.equal(auto.status(), "Ready to inspect a page");

auto.sendState({ messages: [], events: [], running: true, step: 1, maxSteps: 10, pendingApproval: null });
assert.equal(auto.sendDisabled(), true, "Send is disabled while running");

auto.disconnect();
assert.match(auto.status(), /Reconnecting/);
assert.equal(auto.sendDisabled(), false, "Disconnect clears the stale busy state");
assert.equal(auto.dotOffline(), true, "Status dot marks the disconnect");

await tick(250);
assert.equal(auto.connectCalls, 2, "Panel reconnects automatically after a service worker restart");
auto.sendState({ messages: [], events: [], running: false, step: 0, maxSteps: 10, pendingApproval: null });
assert.equal(auto.status(), "Ready to inspect a page");
assert.equal(auto.dotOffline(), false);

const reloaded = harness();
await tick(0);
reloaded.invalidateContext();
reloaded.disconnect();
await tick(250);
assert.match(reloaded.status(), /Reload this panel/);
assert.equal(reloaded.connectCalls, 1, "No retry loop once the extension context is invalidated");

console.log("PASS: panel reconnects after service worker disconnect");
console.log("PASS: panel asks for a reload after an extension update");
