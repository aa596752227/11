const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../resources/app/app/app.js'), 'utf8');
const start = source.indexOf('function selectedVideoSyncJobs(');
const end = source.indexOf('function showEdgeMenu(', start);
assert.ok(start >= 0 && end > start);
const bulkSource = source.slice(start, end);

function fixture() {
  const nodes = [
    { id: 'node1', type: 'video', lastJobId: 'job1', output: '' },
    { id: 'image1', type: 'image' },
    { id: 'node2', type: 'video', lastJobId: 'job2', output: 'done.mp4' },
    { id: 'node3', type: 'video', lastJobId: 'job3', output: '' },
    { id: 'node4', type: 'video', lastJobId: 'job4', output: '' }
  ];
  const jobs = [
    { id: 'job1', nodeId: 'node1', state: 'monitor_timeout' },
    { id: 'job2', nodeId: 'node2', state: 'completed' },
    { id: 'job3', nodeId: 'node3', state: 'failed', quotaNotDeducted: true },
    { id: 'job4', nodeId: 'node4', state: 'needs_attention', stopped: true }
  ];
  const calls = [], messages = [];
  const context = vm.createContext({
    state: { jobs },
    selectionNodes: () => nodes,
    syncingJobs: new Set(),
    bulkSyncing: false,
    confirm: () => true,
    hideMenu() {},
    paintSelection() {},
    flash: message => messages.push(message),
    syncHistoryJob: async (job, options) => { calls.push({ id: job.id, options }); return { ok: true }; },
    setTimeout: callback => { callback(); return 1; }
  });
  vm.runInContext(bulkSource, context);
  return { context, calls, messages };
}

test('selection keeps only video tasks that still have results to recover', () => {
  const f = fixture();
  assert.equal(f.context.selectedVideoSyncJobs().map(job => job.id).join(','), 'job1,job4');
});

test('bulk sync runs selected tasks sequentially without resubmitting', async () => {
  const f = fixture();
  await f.context.syncSelectedVideoResults();
  assert.equal(f.calls.map(call => call.id).join(','), 'job1,job4');
  assert.ok(f.calls.every(call => call.options.silent && call.options.skipStoppedConfirm));
  assert.match(f.messages.at(-1), /已启动 2 个任务/);
});
