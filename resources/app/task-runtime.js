// Per-task cancellation follows asynchronous controller work, never other jobs.
const { AsyncLocalStorage } = require('node:async_hooks');
const scopes = new AsyncLocalStorage();

function stoppedError() {
  const error = new Error('任务已由用户停止');
  error.code = 'DOUBAO_TASK_STOPPED';
  return error;
}
function currentSignal() { return scopes.getStore()?.signal; }
function assertRunning() {
  if (currentSignal()?.aborted) throw stoppedError();
}
function runWithSignal(signal, action) { return scopes.run({ signal }, action); }
function onAbort(callback) {
  const signal = currentSignal();
  if (!signal) return () => {};
  if (signal.aborted) { callback(); return () => {}; }
  signal.addEventListener('abort', callback, { once: true });
  return () => signal.removeEventListener('abort', callback);
}
function delay(milliseconds) {
  assertRunning();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { detach(); resolve(); }, milliseconds);
    const detach = onAbort(() => { clearTimeout(timer); reject(stoppedError()); });
  });
}
module.exports = { assertRunning, currentSignal, delay, onAbort, runWithSignal, stoppedError };
