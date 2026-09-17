const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { restorableConversationContext } = require('../resources/app/doubao-controller');

const mainSource = fs.readFileSync(path.join(__dirname, '../resources/app/main.js'), 'utf8');
const start = mainSource.indexOf('function readJsonIfPresent(');
const end = mainSource.indexOf('ipcMain.handle("sync-doubao-result"', start);
assert.ok(start >= 0 && end > start);
const recoverySource = mainSource.slice(start, end);

function recovery(files = {}) {
  const context = vm.createContext({
    path,
    fs: {
      readFileSync(file) {
        const name = path.basename(file);
        if (Object.prototype.hasOwnProperty.call(files, name)) return files[name];
        const error = new Error(`missing ${name}`);
        error.code = 'ENOENT';
        throw error;
      }
    }
  });
  vm.runInContext(recoverySource, context);
  return context.loadDoubaoRecoveryRecord('/task', 'job1');
}

test('missing receipt and pending record is classified without leaking ENOENT', () => {
  const result = recovery();
  assert.equal(result.receipt, null);
  assert.equal(result.pending, null);
  assert.equal(result.baseline, null);
});

test('a formal receipt supplies the exact recovery baseline', () => {
  const baseline = { targetId: 'target1' };
  const result = recovery({ '豆包提交凭据.json': JSON.stringify({ jobId: 'job1', baseline }) });
  assert.equal(result.baseline.targetId, baseline.targetId);
  assert.equal(result.pending, null);
});

test('a pending record remains recoverable but distinct from a receipt', () => {
  const before = { targetId: 'target2' };
  const result = recovery({ '豆包待确认.json': JSON.stringify({ jobId: 'job1', before }) });
  assert.equal(result.baseline.targetId, before.targetId);
  assert.equal(result.receipt, null);
  assert.ok(result.pending);
});

test('a mismatched record is rejected instead of guessed', () => {
  assert.throws(
    () => recovery({ '豆包提交凭据.json': JSON.stringify({ jobId: 'other', baseline: {} }) }),
    /原提交凭据与任务不一致/
  );
});

test('a pending receipt can restore only its exact saved Doubao conversation', () => {
  const baseline = {
    awaitingSubmissionReceipt: true,
    confirmationContext: {
      url: 'chrome://doubao-chat/chat/38441970884741634',
      root: { messageId: '55680392056585474' }
    }
  };
  assert.equal(restorableConversationContext(baseline), baseline.confirmationContext);
  assert.equal(restorableConversationContext({
    awaitingSubmissionReceipt: true,
    confirmationContext: { url: 'chrome://doubao-chat/', root: { messageId: '55680392056585474' } }
  }), null);
  assert.equal(restorableConversationContext({
    awaitingSubmissionReceipt: true,
    confirmationContext: { url: 'chrome://doubao-chat/chat/38441970884741634', root: {} }
  }), null);
});
