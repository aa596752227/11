const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

function sourceSection(file, from, to) {
  const source = fs.readFileSync(path.join(__dirname, '../resources/app', file), 'utf8');
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function frontend(response) {
  const item = { id: 'node1', type: 'video', output: 'original.mp4', lastJobId: 'job1' };
  const job = { id: 'job1', output: item.output };
  const messages = [];
  let calls = 0;
  const context = vm.createContext({
    state: { jobs: [job] }, findNode: () => item,
    flash: message => messages.push(message), checkpointUndo() {}, saveNow() {}, render() {},
    refreshNoWatermarkStatus: async () => {},
    window: { desktop: { removeVideoWatermark: async id => { calls++; assert.equal(id, 'job1'); return response(); } } }
  });
  vm.runInContext(sourceSection('app/app.js', 'const removingWatermarkJobs =', 'function showNodeMenu('), context);
  return { item, job, messages, context, get calls() { return calls; } };
}

test('completed node switches to the returned watermark-free file', async () => {
  const f = frontend(() => ({ ok: true, url: 'clean.mp4', file: '/clean.mp4' }));
  await f.context.removeNodeWatermark(f.item);
  assert.equal(f.item.output, 'clean.mp4');
  assert.equal(f.job.output, 'clean.mp4');
  assert.equal(f.job.noWatermark.state, 'completed');
});

test('failure preserves the original video and releases the retry lock', async () => {
  const f = frontend(() => ({ ok: false, error: 'missing proof' }));
  await f.context.removeNodeWatermark(f.item);
  await f.context.removeNodeWatermark(f.item);
  assert.equal(f.item.output, 'original.mp4');
  assert.equal(f.calls, 2);
  assert.match(f.messages.join('\n'), /missing proof/);
});

test('missing history never initiates a download', async () => {
  const f = frontend(() => { throw new Error('unexpected request'); });
  f.context.state.jobs = [];
  await f.context.removeNodeWatermark(f.item);
  assert.equal(f.calls, 0);
});

test('duplicate clicks share one request; a new node task is not overwritten', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const f = frontend(() => response);
  const pending = f.context.removeNodeWatermark(f.item);
  await f.context.removeNodeWatermark(f.item);
  f.item.lastJobId = 'job2';
  f.item.output = 'new.mp4';
  resolve({ ok: true, url: 'clean.mp4', file: '/clean.mp4' });
  await pending;
  assert.equal(f.calls, 1);
  assert.equal(f.item.output, 'new.mp4');
  assert.equal(f.job.noWatermark.file, '/clean.mp4');
});

function backend({ invalid = false, active = false, material = async () => ({ file: '/clean.mp4' }) } = {}) {
  let started = 0;
  let captured = 0;
  const context = vm.createContext({
    fs: { readFileSync: () => JSON.stringify({ id: invalid ? 'other' : 'job1', nodeId: 'node1', accountIdentity: { name: 'account' } }) },
    path, pathToFileURL, jobFolder: () => '/job1',
    activeMonitors: new Set(active ? ['job1'] : []), activeSubmissions: new Set(),
    taskControl: () => ({ cancelled: false }),
    noWatermarkService: { status: () => ({ running: false, enabled: false }), start: async () => { started++; } },
    loadConfig: () => ({}), saveConfig() {}, emitNoWatermarkStatus() {},
    retryBoundMaterial: async () => { captured++; return material(); }
  });
  vm.runInContext(sourceSection('main.js', 'const manualMaterialJobs =', 'function emitResult('), context);
  return { context, get started() { return started; }, get captured() { return captured; } };
}

test('backend uses the bound-material service and returns a local URL', async () => {
  const b = backend();
  const result = await b.context.removeVideoWatermark('job1');
  assert.equal(result.ok, true);
  assert.match(result.url, /^file:/);
  assert.equal(b.started, 1);
  assert.equal(b.captured, 1);
});

for (const options of [{ invalid: true }, { active: true }]) {
  test(`backend rejects before download: ${JSON.stringify(options)}`, async () => {
    const b = backend(options);
    assert.equal((await b.context.removeVideoWatermark('job1')).ok, false);
    assert.equal(b.captured, 0);
    assert.equal(b.started, 0);
  });
}

test('backend deduplicates in-flight requests and releases the lock after failure', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const b = backend({ material: () => pending });
  const first = b.context.removeVideoWatermark('job1');
  assert.equal((await b.context.removeVideoWatermark('job1')).ok, false);
  resolve({ message: 'source unavailable' });
  assert.equal((await first).ok, false);
  assert.equal((await b.context.removeVideoWatermark('job1')).error, 'source unavailable');
  assert.equal(b.captured, 2);
});
