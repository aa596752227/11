const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const controller = require('../resources/app/doubao-controller');
const recovery = require('../resources/app/submission-recovery');
const identity = require('../resources/app/message-identity');
const source = fs.readFileSync(path.join(__dirname, '../resources/app/doubao-controller.js'), 'utf8');

async function receipt(text) {
  const root = { sender: 'user', messageId: 'root', signature: 'user|id:root', index: 0 };
  const answer = { sender: 'assistant', messageId: 'answer', signature: 'assistant|id:answer', replyId: 'root', index: 1, text };
  const context = vm.createContext({
    ...controller, ...recovery, ...identity,
    waitFor: async (_client, fn) => fn(),
    conversationMessageState: async () => ({ url: 'https://www.doubao.com/chat/test', messages: [root, answer] }),
    relatedSubmissionMessages: () => ({ user: root, fresh: [root, answer], assistant: [answer] })
  });
  vm.runInContext(source.slice(source.indexOf('async function waitForSubmissionAccepted('), source.indexOf('function savePendingSubmission(')), context);
  return context.waitForSubmissionAccepted({}, '', {
    submissionContext: { url: 'https://www.doubao.com/chat/test', root }
  }, 100);
}

test('paid submission receipt is accepted despite free-quota notice', async () => {
  const result = await receipt('视频生成已提交。本次使用 Seedance 2.0 Fast 生成。今日视频生成免费额度已用完，本次将消耗付费额度，并使用优先生成通道。');
  assert.equal(result.accepted, true);
});

test('an actual payment question still requires manual action', async () => {
  const result = await receipt('今日视频生成免费额度已用完，本次将消耗付费额度。是否继续生成？');
  assert.equal(result.actionType, 'paid_quota');
  assert.equal(result.accepted, undefined);
});

test('quota exhaustion without a receipt is not accepted', async () => {
  assert.equal((await receipt('今日视频生成免费额度已用完')).quotaExhausted, true);
});

test('explicitly bound manual confirmation links only its own replies', () => {
  const root = { sender: 'user', messageId: 'root', signature: 'user|id:root', index: 0 };
  const result = recovery.confirmationChain({ url: 'same', root, ownedMessageIds: ['manual-confirmation'] }, {
    url: 'same', messages: [root,
      { sender: 'assistant', messageId: 'receipt', replyId: 'manual-confirmation', index: 1 },
      { sender: 'assistant', messageId: 'video', replyId: 'manual-confirmation', index: 2 },
      { sender: 'assistant', messageId: 'other-video', replyId: 'other-task', index: 3 }]
  });
  assert.deepEqual(result.assistant.map(m => m.messageId), ['receipt', 'video']);
});

test('Doubao quick action text keeps the receipt in the original task chain', () => {
  const root = { sender: 'user', messageId: 'root', signature: 'user|id:root', index: 0 };
  const question = { sender: 'assistant', messageId: 'question', signature: 'assistant|id:question', replyId: 'root', index: 1 };
  const confirmation = { sender: 'user', messageId: 'confirm', signature: 'user|id:confirm', replyId: '0', index: 2, text: '生成视频' };
  const receiptMessage = { sender: 'assistant', messageId: 'receipt', signature: 'assistant|id:receipt', replyId: 'confirm', index: 3, text: '本次使用 Seedance 2.0 Fast 生成，预计等待 5 分钟。视频生成好后，我会主动发送给你。' };
  const result = recovery.confirmationChain({ url: 'same', root }, {
    url: 'same', messages: [root, question, confirmation, receiptMessage]
  });
  assert.equal(result.valid, true);
  assert.equal(result.interrupted, false);
  assert.deepEqual(result.users.map(m => m.messageId), ['root', 'confirm']);
  assert.deepEqual(result.assistant.map(m => m.messageId), ['question', 'receipt']);
});
