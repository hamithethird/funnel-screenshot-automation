const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseEvaluationOption, chooseEvaluationDropdown } = require('../evaluation-select');

const options = [
  { index: 0, text: 'Choose start time', value: '', disabled: false },
  { index: 1, text: 'Today', value: 'today', disabled: false },
  { index: 2, text: 'Tomorrow', value: 'tomorrow', disabled: false }
];

test('evaluation start-time select skips the placeholder and chooses Today', async () => {
  const selected = [];
  const page = { locator: () => ({ selectOption: async option => selected.push(option) }) };
  const result = await chooseEvaluationDropdown(page, { kind: 'native', id: 'time', options }, () => { throw new Error('native select needs selectOption'); }, () => {});
  assert.deepEqual(result, { handled: true, selected: true });
  assert.deepEqual(selected, [{ index: 1 }]);
});

test('a disabled start-time option is skipped', () => {
  assert.equal(chooseEvaluationOption(options.map(o => o.value === 'today' ? { ...o, disabled: true } : o)).value, 'tomorrow');
});

test('an empty or placeholder-only dropdown does not claim a selection', async () => {
  const result = await chooseEvaluationDropdown({}, { kind: 'native', id: 'time', options: [options[0]] }, () => {}, () => {});
  assert.deepEqual(result, { handled: true, selected: false });
});

test('custom evaluation dropdown opens and chooses a real option', async () => {
  const clicks = [];
  const page = {
    locator: selector => selector,
    waitForTimeout: async () => {},
    evaluate: async () => [{ id: 'placeholder', text: 'Choose start time', value: '' }, { id: 'today', text: 'Today', value: 'today' }]
  };
  const result = await chooseEvaluationDropdown(page, { kind: 'custom', id: 'time' }, async locator => { clicks.push(locator); return true; }, () => {});
  assert.deepEqual(result, { handled: true, selected: true });
  assert.deepEqual(clicks, ['[data-crawler-evaluation-select="time"]', '[data-crawler-evaluation-option="today"]']);
});
