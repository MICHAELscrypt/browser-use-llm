// Offline integration test of the MV3 service worker using mocked Chrome APIs.
// Run with: node tests/smoke-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerSource = fs.readFileSync(path.join(here, "..", "background.js"), "utf8");

function event() {
  const callbacks = [];
  return {
    addListener: (fn) => callbacks.push(fn),
    fire: (...args) => callbacks.forEach((fn) => fn(...args))
  };
}

async function scenario({
  reviewClicks = false, approve = true, actions = null, newTab = null,
  startUrl = "https://example.com/shop"
} = {}) {
  const connected = event();
  const portMessage = event();
  const portDisconnect = event();
  const detachEvent = event();
  const tabCreated = event();
  const calls = [];
  const modelBodies = [];
  const states = [];
  let fetchCalls = 0;
  let storage = {};
  const attachedTabs = new Set();
  let newTabOpened = false;
  let lastSettings;

  // Tab 99 is the page the run starts on; a click may open tab 100.
  const tabs = new Map([
    [99, {
      id: 99, windowId: 1, url: startUrl, title: "Shop",
      status: "complete", active: true
    }]
  ]);

  const chrome = {
    storage: {
      session: {
        get: async () => ({}),
        set: async (data) => { storage = { ...storage, ...data }; },
        remove: async () => { delete storage.chatHistory; }
      },
      local: {
        get: async (defaults) => ({ ...defaults, endpoint: "http://localhost:1234/v1", model: "test-vision", reviewClicks }),
      }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { onConnect: connected },
    permissions: { contains: async (requested) => {
      assert.deepEqual(JSON.parse(JSON.stringify(requested.origins)), ["http://localhost/*"]);
      return true;
    } },
    debugger: {
      attach: async (target, version) => {
        assert.equal(version, "1.3");
        attachedTabs.add(target.tabId);
        calls.push(["attach", target.tabId]);
      },
      detach: async (target) => {
        attachedTabs.delete(target.tabId);
        calls.push(["detach", target.tabId]);
        detachEvent.fire(target, "target_closed");
      },
      sendCommand: async (target, method, params) => {
        calls.push([method, params, target.tabId]);
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased" && newTab && !newTabOpened) {
          newTabOpened = true;
          tabs.set(newTab.id, {
            id: newTab.id, windowId: 1, url: newTab.url, title: newTab.title,
            status: "complete", active: newTab.active, openerTabId: newTab.openerTabId
          });
          if (!newTab.active) {
            tabs.get(99).active = true;
          } else {
            tabs.get(99).active = false;
          }
          tabCreated.fire({ ...tabs.get(newTab.id) });
        }
        if (method === "Page.navigate") {
          const tab = tabs.get(target.tabId);
          if (tab) {
            tab.url = params.url;
            tab.title = params.url;
            tab.status = "complete";
          }
          return { frameId: "frame-1" };
        }
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } };
        if (method === "Page.captureScreenshot") return { data: "ZHVtbXk=" };
        return {};
      },
      onDetach: detachEvent
    },
    tabs: {
      query: async () => [{ ...tabs.get(99) }],
      create: async ({ url, active = true } = {}) => {
        const tab = {
          id: 101, windowId: 1, url: url || "about:blank", title: url || "about:blank",
          status: "complete", active
        };
        tabs.set(tab.id, tab);
        if (active) tabs.get(99).active = false;
        calls.push(["create", tab.id, tab.url]);
        return { ...tab };
      },
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      },
      onCreated: tabCreated,
      onRemoved: event()
    }
  };
  const fetch = async (_endpoint, options) => {
    fetchCalls++;
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-Type"], "application/json");
    const payload = JSON.parse(options.body);
    modelBodies.push(payload);
    const image = payload.messages[1].content[1];
    assert.equal(image.type, "image_url");
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    const action = actions
      ? actions[fetchCalls - 1]
      : fetchCalls === 1
        ? { action: "click", x: 500, y: 250, description: "Open cart", risk: "navigation" }
        : { action: "finish", answer: "Your cart contains a blue mug." };
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(action) } }] }) };
  };
  vm.runInNewContext(workerSource, {
    chrome, fetch, crypto: webcrypto, URL, AbortController, DOMException,
    setTimeout, clearTimeout, console
  }, { filename: "background.js" });

  const port = {
    name: "visual-agent-panel",
    onMessage: portMessage,
    onDisconnect: portDisconnect,
    postMessage: (msg) => {
      if (msg.type === "state") {
        states.push(msg);
        if (msg.pendingApproval) {
          setTimeout(() => portMessage.fire({ type: "approve", approved: approve }), 0);
        }
      }
    }
  };
  connected.fire(port);
  portMessage.fire({ type: "run", text: "What's in my shopping cart?" });
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const last = states.at(-1);
      if (last && !last.running && last.messages.some((m) => m.role === "assistant")) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 6000) {
        clearInterval(timer);
        reject(new Error("Test timed out"));
      }
    }, 20);
  });
  assert.equal(attachedTabs.size, 0, "Debugger should be detached from every tab when finished");
  assert.equal(storage.chatHistory[0].role, "user");
  const answer = states.at(-1).messages.at(-1).text;
  return { calls, modelBodies, fetchCalls, answer, states };
}

const run = await scenario();
assert.equal(run.fetchCalls, 2, "One screenshot decision per step");
assert.match(run.answer, /blue mug/);
const pressed = run.calls.find((c) => c[0] === "Input.dispatchMouseEvent" && c[1]?.type === "mousePressed");
assert.equal(pressed[1].x, 600, "Normalized X mapped to 1200px viewport");
assert.equal(pressed[1].y, 200, "Normalized Y mapped to 800px viewport");
assert.equal(run.calls.filter((c) => c[0] === "Page.captureScreenshot").length, 2);
console.log("PASS: capture → analyze → click → capture → answer → detach");

const approval = await scenario({ reviewClicks: true, approve: false });
assert.equal(approval.fetchCalls, 1);
assert.equal(approval.calls.filter((c) => c[0] === "Input.dispatchMouseEvent").length, 0);
assert.match(approval.answer, /not approved/);
console.log("PASS: optional click approval prevents unapproved clicks");

const typing = await scenario({
  actions: [
    { action: "type", x: 250, y: 500, text: "blue mug", description: "Enter a search term" },
    { action: "finish", answer: "Search results for blue mug." }
  ]
});
assert.equal(typing.fetchCalls, 2);
const focusClick = typing.calls.find((c) => c[0] === "Input.dispatchMouseEvent" && c[1]?.type === "mousePressed");
assert.equal(focusClick[1].x, 300, "Typing focuses the field at the normalized X");
assert.equal(focusClick[1].y, 400, "Typing focuses the field at the normalized Y");
const inserted = typing.calls.find((c) => c[0] === "Input.insertText");
assert.equal(inserted[1].text, "blue mug");
assert.ok(
  typing.calls.indexOf(inserted) > typing.calls.indexOf(focusClick),
  "The field is focused before text is inserted"
);
assert.match(
  typing.modelBodies[1].messages[1].content[0].text,
  /"action":"type"/,
  "The typing action is included in the next model request"
);
console.log("PASS: type action clicks the field and inserts text");

const typingApproval = await scenario({
  reviewClicks: true,
  approve: false,
  actions: [
    { action: "type", x: 250, y: 500, text: "blue mug", description: "Enter a search term" },
    { action: "finish", answer: "Should not get here." }
  ]
});
assert.equal(typingApproval.fetchCalls, 1);
assert.equal(typingApproval.calls.filter((c) => c[0] === "Input.insertText").length, 0);
assert.equal(typingApproval.calls.filter((c) => c[0] === "Input.dispatchMouseEvent").length, 0);
assert.match(typingApproval.answer, /not approved/);
console.log("PASS: optional click approval also gates typing");

const navigation = await scenario({
  actions: [
    { action: "navigate", url: "amazon.com", description: "Go to Amazon" },
    { action: "finish", answer: "Amazon is open." }
  ]
});
assert.equal(navigation.fetchCalls, 2);
const navigated = navigation.calls.find((c) => c[0] === "Page.navigate");
assert.ok(navigated, "The navigate action issues Page.navigate");
assert.equal(navigated[1].url, "https://amazon.com/", "A bare domain is opened over HTTPS");
assert.equal(navigated[2], 99, "Navigation happens in the tab the agent controls");
assert.equal(
  JSON.parse(navigation.modelBodies[1].messages[1].content[0].text).current_url,
  "https://amazon.com/",
  "The next step sees the navigated URL"
);
assert.match(
  navigation.modelBodies[1].messages[1].content[0].text,
  /"action":"navigate"/,
  "The navigation is included in the next model request"
);
console.log("PASS: a navigate action opens a URL in the current tab");

const blockedNavigation = await scenario({
  actions: [
    { action: "navigate", url: "file:///etc/passwd", description: "Read a local file" },
    { action: "finish", answer: "Should not get here." }
  ]
});
assert.equal(blockedNavigation.calls.filter((c) => c[0] === "Page.navigate").length, 0);
assert.match(blockedNavigation.answer, /Only http\(s\) URLs/);
console.log("PASS: non-http URLs are refused");

const blankStart = await scenario({
  startUrl: "chrome://newtab/",
  actions: [
    { action: "navigate", url: "https://example.com/search?q=blue+mug", description: "Go to results" },
    { action: "finish", answer: "Search results are open." }
  ]
});
const firstCreate = blankStart.calls.find((c) => c[0] === "create");
assert.ok(firstCreate, "A blank tab is created when the active tab is not automatable");
assert.equal(firstCreate[2], "about:blank");
assert.deepEqual(
  blankStart.calls.filter((c) => c[0] === "attach").map((c) => c[1]),
  [101],
  "The debugger attaches to the new blank tab instead of the chrome:// page"
);
assert.equal(
  blankStart.calls.find((c) => c[0] === "Page.navigate")[2],
  101,
  "Navigation runs in the new blank tab"
);
console.log("PASS: the agent starts in a blank tab from a chrome:// page");

const followTab = await scenario({
  newTab: {
    id: 100, openerTabId: 99, active: true,
    url: "https://example.com/product/42", title: "Product 42"
  },
  actions: [
    { action: "click", x: 500, y: 250, description: "Open the product in a new tab" },
    { action: "finish", answer: "The product is a blue mug." }
  ]
});
assert.equal(followTab.fetchCalls, 2);
assert.deepEqual(
  followTab.calls.filter((c) => c[0] === "attach").map((c) => c[1]),
  [99, 100],
  "The debugger attaches to the tab opened by the click"
);
assert.ok(
  followTab.calls.some((c) => c[0] === "detach" && c[1] === 99),
  "The debugger leaves the opener tab"
);
assert.equal(
  followTab.calls.filter((c) => c[0] === "Page.captureScreenshot").at(-1)[2],
  100,
  "The next screenshot is taken from the new tab"
);
assert.match(
  followTab.modelBodies[1].messages[1].content[0].text,
  /product\/42/,
  "The model is told about the new tab's URL"
);
assert.match(
  followTab.modelBodies[1].messages[1].content[0].text,
  /new_tab/,
  "The model learns that the click opened a new tab"
);
assert.equal(followTab.calls.filter((c) => c[0] === "detach").at(-1)[1], 100);
console.log("PASS: a click that opens a new tab moves the agent to that tab");

const backgroundTab = await scenario({
  newTab: {
    id: 100, openerTabId: 99, active: false,
    url: "https://example.com/product/42", title: "Product 42"
  },
  actions: [
    { action: "click", x: 500, y: 250, description: "Open the product in a new tab" },
    { action: "finish", answer: "The shop page is unchanged." }
  ]
});
assert.equal(
  backgroundTab.calls.filter((c) => c[0] === "attach").length,
  1,
  "A background tab is not followed"
);
assert.equal(
  backgroundTab.calls.filter((c) => c[0] === "Page.captureScreenshot").at(-1)[2],
  99,
  "The agent stays on the tab the user can see"
);
console.log("PASS: a background tab opened by a click does not steal the agent");

const noOpenerTab = await scenario({
  // Some pop-up flows omit openerTabId; a tab activated right after the click
  // must still be followed.
  newTab: {
    id: 100, active: true,
    url: "https://example.com/landing", title: "Landing"
  },
  actions: [
    { action: "click", x: 500, y: 250, description: "Open the offer" },
    { action: "finish", answer: "The offer is 20% off." }
  ]
});
assert.equal(
  noOpenerTab.calls.filter((c) => c[0] === "Page.captureScreenshot").at(-1)[2],
  100,
  "A tab activated by the click is followed even without openerTabId"
);
console.log("PASS: the click fallback follows a newly activated tab without an opener");
