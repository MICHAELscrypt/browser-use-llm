# Visual Browser Agent — Chrome extension

A screenshot-driven browser assistant that lives in Chrome's **Side Panel**. It uses an **OpenAI-compatible Chat Completions vision endpoint** and Chrome's `debugger` permission to visually inspect a webpage, navigate directly to URLs, click/scroll/type, inspect again, and answer questions or complete form-filling tasks in the side-panel conversation.

No Node server, Selenium, Puppeteer, Playwright, or bundler is needed. Works with Chrome **118+** and Manifest V3.

## Install and run

1. Extract this folder to your computer.
2. Open **`chrome://extensions`**, enable **Developer mode**, and click **Load unpacked**. Select the folder containing `manifest.json`.
3. Open a shopping site or another normal `https://` page.
4. Click the extension icon to open **Visual Agent** in the Chrome side panel.
5. Click ⚙ **Settings**. Enter:
   - **API base URL**: `https://api.openai.com/v1` (default) or an OpenAI-compatible endpoint such as `http://localhost:1234/v1`.
   - **Vision model**: `gpt-4o-mini` (default), or a vision-capable model supported by your endpoint.
   - **API key**: your own key, if required (local endpoints may accept a blank key).
   - **Max steps** and optional **Review every click**.
6. Click **Save settings and grant access**. Approve the Chrome prompt requesting permission to call **only that endpoint's host**.
7. Ask, for example, **"What's in my shopping cart?"** or **"Go to amazon.com and search for a blue mug."**
8. Open **Live screenshot & activity** to see the current screenshot and navigation progress. Press **Stop** at any time.

If Chrome restarts the extension's background worker while the panel is idle, the panel reconnects automatically. After reloading the extension itself, reload the panel to reconnect.

## Local WebSocket bridge (optional)

The extension also looks for a small local WebSocket server at **`ws://localhost:8765`**. It connects when one is available and retries every **10 seconds** while the port is closed. No extra Chrome permission or server setup is required.

Messages received over the socket are treated exactly like text typed into the side panel: they appear as a **user message** in the conversation and are worked through by the agent. If a request arrives while a task is already running, it is queued (up to 20) and processed in order. When a request finishes, the final assistant answer is shown in the side panel and returned over the same socket as plain text. Stop also clears queued requests.

Send `/stop` to cancel the current task or `/clear` to reset the conversation. They behave exactly like the side panel's **Stop** and **Clear chat** buttons, and `/stop` also works while a task is running.

Send either plain text:

```text
What's in my shopping cart?
```

or a small JSON envelope:

```json
{"type": "run", "text": "What's in my shopping cart?"}
```

Accepted envelope types are `run`, `user`, `message`, and `prompt` (the `text`, `message`, `prompt`, or `content` field is used). Plain text frames and binary text frames are both accepted. Only one request runs at a time.

The bridge lives in the extension's service worker, so Chrome may suspend it when the worker is idle. Opening the side panel or any other extension activity wakes it and reconnects. Because any local process can connect to this port, only run a server you trust.

> Important: Chrome displays an infobar when an extension attaches a debugger. This is expected; the extension detaches when a task completes or is stopped.

## What happens under the hood

For every step (up to the configured maximum):

1. Attach once to the selected tab using `chrome.debugger.attach`.
2. Capture the **visible viewport** with `Page.captureScreenshot` (JPEG).
3. Obtain viewport measurements with `Page.getLayoutMetrics`.
4. Send a Chat Completions request containing the latest screenshot, the original question, short recent chat context, and the prior actions.
5. Parse the model's JSON response as one of:
   - `navigate`: open an `http(s)` URL in the current tab via `Page.navigate`, then wait for the page to load before the next screenshot. Bare domains such as `amazon.com` are opened over HTTPS.
   - `click`: click normalized screenshot coordinates on a 0–1000 scale via `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`).
   - `type`: click a text field to focus it, then insert the given text via `Input.insertText`.
   - `scroll`: scroll via `Input.dispatchMouseEvent` (`mouseWheel`).
   - `wait`: allow loading to settle.
   - `finish`: reply to the user using what is visible.
   - `ask_user`: stop and ask for clarification or report that the action is out of scope.
6. After navigating, clicking, typing, scrolling, or waiting, capture a **new** screenshot and repeat. Stop on completion, the step limit, or user cancellation.

If the active tab is a Chrome internal page (such as `chrome://newtab`) or another page Chrome will not let the debugger attach to, the extension opens a blank tab and starts there. The model can then navigate to the site the user asked for.

If a click opens a link in a new tab (or `window.open()`), the debugger moves from the opener tab to the newly opened tab before the next screenshot, but only when that tab is the one Chrome is showing. Tabs opened in the background are ignored.

The full image goes to the configured remote/local vision endpoint at **every** step. Requests contain the original question, some recent text context, the tab URL, and recent tool actions. **No screenshot files or API request logs are saved by the extension.** Recent chat text is held in `chrome.storage.session` (until browser restart); connection settings and the API key are held in `chrome.storage.local`.

## Compatibility

- The endpoint must support **`POST /chat/completions`**, `messages`, an image URL content part with a base64 JPEG data URL, and model-generated JSON text. The extension requests `response_format: {"type":"json_object"}` and retries once without it if an endpoint returns HTTP 400/422. The model itself **must support images**.
- API base URLs ending in `/chat/completions` are also accepted directly.
- For OpenAI, the configured model is billed according to its token and image input usage. Each screenshot is a separate API request.
- Remote endpoints must use HTTPS. Plain HTTP is allowed for loopback/localhost only.
- The extension does **not** handle the newer Responses-only API; it uses the more widely compatible Chat Completions format.

## Safety & privacy

- **This is an experimental prototype, not a secure autonomous transactional agent.** The model is instructed to restrict itself to navigation, inspection, and filling non-sensitive visible fields, and it is told never to type credentials or submit high-impact forms. This is **not a hard security guarantee**: a model can mistake a destructive button for a navigation control or type into the wrong field.
- Turn on **Review every click** for sensitive sites. It also asks for approval before typing into a field. Do not use the extension with banking, purchasing, administrative, medical, or other high-impact workflows without careful supervision.
- Typing inserts text into the focused field at the caret; it does **not** clear prefilled content or select existing text. The agent is instructed never to type passwords, payment details, one-time codes, API keys, or other secrets. Review the screenshot before approving a typing action.
- Treat screenshots as sensitive. They may contain personal details, addresses, pricing, or private pages. Use an endpoint you trust.
- Browser extensions cannot keep a secret API key from a person who can inspect the local Chrome profile or extension. For production distribution, prefer a secured backend proxy with user authentication, quotas, logging safeguards, and secret handling instead of distributing keys inside the extension.
- The extension automatically stops when its side panel is closed and detaches the debugger when finished. **Click Stop** while the side panel is open to interrupt the model request/loop.
- The extension asks for the `debugger` permission on install, and separately requests access to the user-selected API host at runtime. Chrome permissions are powerful; only install unpacked code you trust.

## Current limits

- **Screenshots only**: no DOM reading or semantic selectors. Visible text fields can be filled via `Input.insertText`, but the agent cannot reliably clear prefilled fields, select native dropdown options, upload files, or interact with hidden elements.
- Navigation is limited to `http(s)` URLs. The model is told not to invent URLs or site paths; when it does not know a site's search URL, it navigates to the home page and uses the visible search box. Chrome internal pages (`chrome://`, `file://`, extension pages) cannot be automated.
- Captures the visible tab viewport, **not the full webpage**. The agent can scroll and recapture.
- Canvas and simple sites generally work, but hover menus, cross-origin frames, pop-up windows, captcha flows, file uploads, unusual zoom states, animated layouts, or background-tab throttling can fail.
- The extension controls the currently selected tab when you press Send. If a click opens a new tab that Chrome shows to you, the agent follows it and continues there; tabs opened in the background are ignored.
- A model can misread screenshots, make coordinate errors, or get stuck. The agent stops after repeated identical actions or reaching the step limit. It also cannot guarantee page actions are non-destructive.
- Chrome may prevent debugger attachment to protected targets (such as `chrome://` pages) and when a competing debugger/DevTools session is attached.
- If the side panel closes while an action is in progress, the extension stops subsequent actions. A mouse event already dispatched cannot be undone.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Chrome MV3 extension permissions and side panel configuration |
| `background.js` | Screenshot / model / action loop, debugger lifecycle, chat state |
| `sidepanel.html` | Sidebar structure |
| `sidepanel.css` | Sidebar styles |
| `sidepanel.js` | Conversation, settings, preview, Stop and click approvals |

## Tests

The extension has no build step. Run the offline tests directly with Node:

```bash
node tests/smoke-test.mjs
node tests/sidepanel-reconnect-test.mjs
node tests/websocket-bridge-test.mjs
```

## Suggested production hardening

A production version should add a server-side OpenAI proxy, site-specific allowlists, stricter user confirmation for all high-risk operations, sensitive screenshot redaction, structured tool action validation, network retry/backoff and better failure recovery, iframe handling, per-site opt-in, more robust image coordinate calibration, and automated browser integration tests.
