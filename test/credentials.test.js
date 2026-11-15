process.env.CRAWLER_PASSWORD = 'fake-test-password-1';
process.env.CRAWLER_EMAIL = 'primary@example.com';
process.env.CRAWLER_NAME = 'Test User';
process.env.CRAWLER_FALLBACK_EMAIL = 'backup@example.com';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {
  createRunCredentials, genericFormFieldType, isEmailRejection, redactCrawlerLog
} = require('../funnel-crawler-multiscreen');
const primary = process.env.CRAWLER_EMAIL;
const backup = process.env.CRAWLER_FALLBACK_EMAIL;
const password = 'fake-test-password-1';
const source = fs.readFileSync(require.resolve('../funnel-crawler-multiscreen'), 'utf8');

function internalFunction(name, nextName, context) {
  const start = source.indexOf('  async function ' + name + '(');
  const end = source.indexOf('  async function ' + nextName + '(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(source.slice(start, end) + '\n' + name, context);
}

test('each run starts with primary and can advance only once to the exact backup', () => {
  const run = createRunCredentials();
  assert.equal(run.currentRunEmail(), primary);
  assert.equal(run.advanceRunEmail(), backup);
  for (let i = 0; i < 10; i++) assert.equal(run.advanceRunEmail(), null);
  assert.equal(run.currentRunEmail(), backup);
  assert.equal(createRunCredentials().currentRunEmail(), primary);
});

test('password and email field metadata takes priority over mixed signup page text', () => {
  for (const info of [
    { type: 'password' }, { type: 'text', autocomplete: 'new-password' },
    { type: 'text', name: 'confirm-password' }, { type: 'text', label: 'Create password' }
  ]) assert.equal(genericFormFieldType(info, 'Enter your email'), 'password');
  assert.equal(genericFormFieldType({ type: 'email' }, 'Create password'), 'email');
  assert.equal(genericFormFieldType({ name: 'first-name' }, 'Email and password'), 'name');
});

test('only email/account rejection evidence qualifies, including domain rejection', () => {
  for (const text of [
    'This email is already registered', 'An account already exists',
    'Invalid email address', 'Email domain is not supported',
    'Please enter a valid email address', 'This email cannot be used'
  ]) assert.equal(isEmailRejection(text), true, text);
  for (const text of [
    '', 'Network timeout', 'Password is invalid', 'Please accept the terms',
    'Loading...', 'Your plan is ready', 'Something went wrong'
  ]) assert.equal(isEmailRejection(text), false, text);
});

test('crawler log formatter redacts passwords in text, objects and Playwright errors', () => {
  for (const args of [
    ['Filled %s', password], [{ field: password }],
    [new Error('locator.fill: ' + password)], [password + ' ' + password]
  ]) {
    const output = redactCrawlerLog(...args);
    assert.ok(!output.includes(password), 'password must never appear in logs');
    assert.ok(output.includes('[REDACTED]'));
  }
});

test('retry requires rejection of the actual primary field and stops after backup rejection', async () => {
  for (const rejected of [false, true]) {
    const run = createRunCredentials();
    const fills = [];
    let value = primary;
    const input = {
      inputValue: async () => value,
      fill: async next => { value = next; fills.push(next); },
      evaluate: async () => {}
    };
    const retry = internalFunction('retryWithNextEmailIfNeeded', 'handleGenericFormInput', {
      ...run, BASE_RUN_EMAIL: primary, emailRejectionDetected: async () => rejected,
      page: { waitForTimeout: async () => {} }, console: { log() {} }
    });
    assert.equal(await retry(input), rejected ? backup : null);
    assert.deepEqual(fills, rejected ? [backup] : []);
    assert.equal(await retry(input), null);
    assert.deepEqual(fills, rejected ? [backup] : []);
  }
  const run = createRunCredentials();
  const retry = internalFunction('retryWithNextEmailIfNeeded', 'handleGenericFormInput', {
    ...run, BASE_RUN_EMAIL: primary, emailRejectionDetected: async () => true
  });
  assert.equal(await retry({ inputValue: async () => '' }), null);
});

test('combined signup fills exact password and confirmation before its first submission', async () => {
  const fills = [];
  let submitted = false;
  const fields = [
    { type: 'email' }, { type: 'password' }, { type: 'text', autocomplete: 'new-password' }
  ].map((info, index) => ({
    isVisible: async () => true, isEnabled: async () => true, isEditable: async () => true,
    evaluate: async callback => callback.toString().includes('labelText') ? info :
      callback.toString().includes('validity') ? { value: primary, valid: true } : undefined,
    fill: async value => { fills[index] = value; },
    locator: () => ({ count: async () => 1, locator: () => ({
      first: () => ({ count: async () => 1, isVisible: async () => true, isEnabled: async () => true })
    }) })
  }));
  const handle = internalFunction('handleGenericFormInput', 'isLikelyBranchTransition', {
    getVisibleFormIntentText: async () => 'Enter your email and create a password',
    detectExplicitProfileIntent: async () => null,
    genericFormFieldType, RUN_PASSWORD: password, currentRunEmail: () => primary,
    page: { locator: () => ({ count: async () => fields.length, nth: i => fields[i] }),
      waitForTimeout: async () => {} },
    console: { log() {} }, handleRequiredAgreementCheckboxes: async () => ({ active: true }),
    inspectPage: async () => ({}), pageSignature: () => 'signup',
    safeCrawlerClick: async () => {
      assert.equal(fills[0], primary);
      assert.ok(fills[1] === password && fills[2] === password, 'fill fixed password and confirmation before submit');
      submitted = true;
      return true;
    },
    emailRejectionDetected: async () => false,
    waitForAdvancement: async () => true
  });
  const result = await handle({});
  assert.equal(submitted, true);
  assert.equal(result.advanced, true);
});

test('email rejection changing page text triggers backup instead of false advancement', async () => {
  const run = createRunCredentials();
  let value = '';
  let submissions = 0;
  const fills = [];
  const input = {
    isVisible: async () => true, isEnabled: async () => true, isEditable: async () => true,
    inputValue: async () => value,
    evaluate: async callback => callback.toString().includes('labelText') ? { type: 'email' } :
      callback.toString().includes('validity') ? { value, valid: true } : undefined,
    fill: async next => { value = next; fills.push(next); },
    locator: () => ({ count: async () => 1, locator: () => ({
      first: () => ({ count: async () => 1, isVisible: async () => true, isEnabled: async () => true })
    }) })
  };
  const context = {
    ...run, BASE_RUN_EMAIL: primary, RUN_PASSWORD: password, genericFormFieldType,
    getVisibleFormIntentText: async () => 'Enter your email',
    detectExplicitProfileIntent: async () => null, console: { log() {} },
    page: { locator: () => ({ count: async () => 1, nth: () => input }), waitForTimeout: async () => {} },
    handleRequiredAgreementCheckboxes: async () => ({ active: true }),
    inspectPage: async () => ({}), inspectPageNavigationSafe: async () => ({}), pageSignature: () => 'email',
    safeCrawlerClick: async () => { submissions++; return true; },
    waitForAdvancement: async () => true,
    emailRejectionDetected: async () => value === primary
  };
  context.retryWithNextEmailIfNeeded = internalFunction(
    'retryWithNextEmailIfNeeded', 'handleGenericFormInput', context);
  const handle = internalFunction('handleGenericFormInput', 'isLikelyBranchTransition', context);
  const result = await handle({});
  assert.equal(result.advanced, true);
  assert.equal(submissions, 2);
  assert.deepEqual([...new Set(fills)], [primary, backup]);
});
