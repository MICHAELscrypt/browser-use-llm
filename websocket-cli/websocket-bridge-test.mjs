// Offline test of the localhost WebSocket bridge in the MV3 service worker.
// Run with: node tests/websocket-bridge-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerSource = fs.readFileSync(path.join(here, "..", "background.js"), "utf8");

function event() {
  const callbacks = [];
  return {
    addListener: (fn) => callbacks.push(fn),
    fire: (...args) => callbacks.forEach((fn) => fn(...args))
  };
}

function fakeTimers() {
  const entries = new Map();
  let nextId = 1;
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      const handle = setTimeout(() => {
        entries.delete(id);
        fn();
      }, ms);
      entries.set(id, { ms, fn, handle });
      return id;
    },
    clearTimeout(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      clearTimeout(entry.handle);
    },
    find(ms) {
      return [...entries.entries()].filter(([, entry]) => entry.ms === ms);
    },
    fire(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`No pending timer ${id}`);
      entries.delete(id);
      entry.fn();
    },
    cleanup() {
      for (const { handle } of entries.values()) clearTimeout(handle);
      entries.clear();
    }
  };
}

function socketHarness() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.sent = [];
      this.listeners = new Map();
      instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, event = {}) {
      for (const fn of this.listeners.get(type) || []) fn(event);
    }
    open() {
      this.readyState = 1; // OPEN
      this.emit("open");
    }
    receive(data) {
      this.emit("message", { data });
    }
    fail() {
      this.emit("error");
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3; // CLOSED
      this.emit("close");
    }
  }
  return { FakeWebSocket, instances };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await tick(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function harness() {
  const timers = fakeTimers();
  const sockets = socketHarness();
  const states = [];
  const portMessage = event();
  const portDisconnect = event();
  let storage = {};

  const tabs = new Map([
    [99, {
      id: 99, windowId: 1, url: "https://example.com/shop", title: "Shop",
      status: "complete", active: true
    }]
  ]);

  const chrome = {
    storage: {
      session: {
        get: async () => ({}),
        set: async (data) => { storage = { ...storage, ...data }; },
        remove: async (key) => { delete storage[key]; }
      },
      local: {
        get: async (defaults) => ({
          ...defaults, endpoint: "http://localhost:1234/v1", model: "test-vision"
        })
      }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { onConnect: event() },
    permissions: { contains: async () => true },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, method) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } };
        }
        if (method === "Page.captureScreenshot") return { data: "ZHVtbXk=" };
        return {};
      },
      onDetach: event()
    },
    tabs: {
      query: async () => [{ ...tabs.get(99) }],
      create: async ({ url, active = true } = {}) => {
        const tab = {
          id: 100, windowId: 1, url: url || "about:blank",
          title: url || "about:blank", status: "complete", active
        };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      },
      onCreated: event(),
      onRemoved: event()
    }
  };

  const fetch = async (_endpoint, options) => {
    const payload = JSON.parse(options.body);
    const request = JSON.parse(payload.messages[1].content[0].text).user_request;
    return {
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ action: "finish", answer: `Done: ${request}` }) } }]
      })
    };
  };

  vm.runInNewContext(workerSource, {
    chrome,
    fetch,
    crypto: webcrypto,
    URL,
    AbortController,
    DOMException,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console,
    WebSocket: sockets.FakeWebSocket
  }, { filename: "background.js" });

  const port = {
    name: "visual-agent-panel",
    onMessage: portMessage,
    onDisconnect: portDisconnect,
    postMessage: (message) => {
      if (message.type === "state") states.push(message);
    }
  };
  chrome.runtime.onConnect.fire(port);

  return { timers, sockets: sockets.instances, states, storage, port };
}

const bus = harness();
assert.equal(bus.sockets.length, 1, "The bridge tries the local port on startup");
assert.equal(bus.sockets[0].url, "ws://localhost:8765");
assert.equal(bus.timers.find(10000).length, 0, "No retry is scheduled while the socket is connecting");

bus.sockets[0].open();
await tick(0);
bus.sockets[0].receive("What is on this page?");
await waitFor(
  () => bus.states.at(-1)?.messages.some((message) => message.role === "assistant"),
  "the websocket request to finish"
);

let state = bus.states.at(-1);
assert.equal(state.messages[0].role, "user", "The socket request appears as a user message");
assert.equal(state.messages[0].text, "What is on this page?");
assert.equal(state.messages.at(-1).text, "Done: What is on this page?");
assert.deepEqual(
  bus.sockets[0].sent,
  ["Done: What is on this page?"],
  "The final answer is sent back over the socket"
);
console.log("PASS: a websocket message runs the agent and the answer is returned");

// A JSON envelope is accepted too, and a second request that arrives during a
// run is queued rather than dropped.
bus.sockets[0].receive(JSON.stringify({ type: "run", text: "First queued task" }));
bus.sockets[0].receive("Second queued task");
await waitFor(
  () => bus.states.at(-1)?.messages.filter((message) => message.role === "assistant").length >= 3,
  "both queued requests to finish"
);

state = bus.states.at(-1);
const userTexts = [...state.messages]
  .filter((message) => message.role === "user")
  .map((message) => message.text);
assert.deepEqual(userTexts, ["What is on this page?", "First queued task", "Second queued task"]);
assert.deepEqual(
  bus.sockets[0].sent.slice(1),
  ["Done: First queued task", "Done: Second queued task"],
  "Queued results are returned in order"
);
console.log("PASS: JSON envelopes work and requests received mid-run are queued");

// Dropping the connection schedules exactly one retry after ten seconds.
const retry = harness();
assert.equal(retry.sockets.length, 1);
retry.sockets[0].close();
const pending = retry.timers.find(10000);
assert.equal(pending.length, 1, "A closed socket schedules one 10s retry");
retry.timers.fire(pending[0][0]);
assert.equal(retry.sockets.length, 2, "The retry opens a fresh socket");
assert.equal(retry.sockets[1].url, "ws://localhost:8765");
console.log("PASS: the bridge reconnects every ten seconds while the server is absent");

// Failed handshakes (error, then close) should still schedule only one retry.
const failed = harness();
failed.sockets[0].fail();
assert.equal(failed.timers.find(10000).length, 1, "An error schedules one retry");
failed.timers.cleanup();
console.log("PASS: a failed connection schedules a single retry");

retry.timers.cleanup();
