const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { chooseRatioAndDuration } = require('../resources/app/doubao-controller');

// Evaluate the actual injected scripts in a separate page scope, as CDP does.
function pageFixture({ native = false, finalChip = null } = {}) {
  let open = true;
  let current = 10;
  const keys = [];
  class Element {
    constructor(text = '', attrs = {}, rect = {}) {
      this.innerText = text;
      this.textContent = text;
      this.attrs = attrs;
      this.rect = { left: 300, top: 200, width: 30, height: 20, ...rect };
    }
    getBoundingClientRect() { return this.rect; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    querySelectorAll() { return []; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  class HTMLInputElement extends Element {
    min = '4';
    max = '15';
    get value() { return String(current); }
    set value(value) { current = Number(value); }
    dispatchEvent() {}
  }
  const track = new Element('', {}, { width: 330 });
  const slider = new Element('', { 'aria-valuemin': '4', 'aria-valuemax': '15' });
  slider.getAttribute = name => name === 'aria-valuenow' ? String(current) : slider.attrs[name];
  slider.parentElement = track;
  const range = new HTMLInputElement('', {}, { width: 330 });
  const labels = [new Element('4s'), new Element('15s')];
  const menu = new Element('比例 时长 4s 15s', {
    'data-slot': 'dropdown-menu-content', 'data-state': 'open'
  }, { width: 365, height: 270 });
  track.parentElement = menu;
  menu.querySelectorAll = selector => {
    if (selector === 'span,div') return labels;
    if (selector.includes('[role="slider"]')) return native ? [] : [slider];
    return [];
  };
  const trigger = new Element('9:16 · 10s', { 'data-state': 'open' });
  const context = vm.createContext({
    Element, HTMLInputElement, innerWidth: 1200, innerHeight: 800,
    InputEvent: class {}, Event: class {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: {
      querySelectorAll(selector) {
        if (selector === 'input[type="range"]') return open && native ? [range] : [];
        if (selector === '[role="slider"]') return open && !native ? [slider] : [];
        if (selector.includes('[data-slot="dropdown-menu-sub-content"]') ||
            selector.includes('[role="menu"][data-state="open"]')) return open ? [menu] : [];
        if (selector.startsWith('button')) {
          const text = open ? `9:16 · ${current}s` : (finalChip ?? `9:16 · ${current}s`);
          trigger.innerText = trigger.textContent = text;
          return text ? [trigger] : [];
        }
        return [];
      }
    }
  });
  return {
    client: {
      evaluate: async source => vm.runInContext(source, context),
      async send(method, event) {
        if (method !== 'Input.dispatchKeyEvent' || event.type !== 'keyDown') return;
        keys.push(event.key);
        if (event.key === 'Home') current = 4;
        if (event.key === 'ArrowRight') current = Math.min(15, current + 1);
        if (event.key === 'Escape') open = false;
      }
    },
    get current() { return current; },
    get open() { return open; },
    keys
  };
}

for (const native of [false, true]) {
  for (const duration of [4, 10, 15]) {
    test(`${native ? 'native range' : 'custom slider'}: ${duration}s closes panel and returns`, async () => {
      const page = pageFixture({ native });
      const result = await chooseRatioAndDuration(page.client, '9:16', `${duration}s`, 'Seedance 2.0 Fast');
      assert.equal(page.current, duration);
      assert.equal(page.open, false);
      assert.equal(result.text, `9:16 · ${duration}s`);
      assert.equal(page.keys.filter(key => key === 'Escape').length, 2);
    });
  }
}

for (const finalChip of ['', '9:16 · 8s']) {
  test(`slider evidence remains in scope when final chip is ${JSON.stringify(finalChip)}`, async () => {
    const page = pageFixture({ finalChip });
    const result = await chooseRatioAndDuration(page.client, '9:16', '10s', 'Seedance 2.0 Fast');
    assert.equal(page.current, 10);
    assert.equal(page.open, false);
    assert.ok(result);
  });
}

test('unsupported duration still rejects before changing the slider', async () => {
  const page = pageFixture();
  await assert.rejects(
    chooseRatioAndDuration(page.client, '9:16', '16s', 'Seedance 2.0 Fast'),
    /4 到 15 秒/
  );
  assert.equal(page.current, 10);
  assert.deepEqual(page.keys, []);
});
