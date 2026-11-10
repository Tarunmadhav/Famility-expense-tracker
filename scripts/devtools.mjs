#!/usr/bin/env node
// Evaluate JavaScript inside the running Android WebView, for device checks.
//
//   node scripts/devtools.mjs 'document.title'
//
// Requires a build made with plannerWebViewDebug=true and an adb forward:
//   adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
// This is a development tool; it is never deployed.

const endpoint = process.env.CDP || 'http://127.0.0.1:9333';
const expression = process.argv[2];
if (!expression) {
  console.error('usage: node scripts/devtools.mjs "<javascript>"');
  process.exit(2);
}

const targets = await (await fetch(`${endpoint}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('no page target; is the app running and the port forwarded?');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const timeout = setTimeout(() => {
  console.error('timed out waiting for the page');
  process.exit(1);
}, 20000);

socket.addEventListener('open', () => {
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    }),
  );
});

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== 1) return;
  clearTimeout(timeout);
  const result = message.result;
  if (result.exceptionDetails) {
    console.error('evaluation threw:', result.exceptionDetails.text, result.exceptionDetails.exception?.description || '');
    process.exit(1);
  }
  console.log(JSON.stringify(result.result.value ?? result.result.description ?? null));
  socket.close();
  process.exit(0);
});

socket.addEventListener('error', (err) => {
  console.error('websocket error', err.message || err);
  process.exit(1);
});
