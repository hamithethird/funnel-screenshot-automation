const test = require('node:test');
const assert = require('node:assert/strict');
const { rejectCookieOverlays, isCookieRejectionText, isCookieAcceptanceText, hasCookieContext } = require('../cookie-consent');

function fakePage(frameSpecs) {
  const clicked = [];
  const frames = frameSpecs.map(specs => {
    const actions = specs.map(spec => ({
      isVisible: async () => !spec.hidden,
      isEnabled: async () => true,
      innerText: async () => spec.text,
      getAttribute: async () => null,
      evaluate: async () => ({ visible: !spec.hidden && !spec.transparent, ancestors: spec.ancestors }),
      click: async () => { clicked.push(spec.text); spec.hidden = !spec.staysOpen; },
      waitFor: async () => { if (!spec.hidden) throw new Error('still visible'); }
    }));
    return { locator: () => ({ count: async () => actions.length, nth: i => actions[i] }) };
  });
  return { frames: () => frames, waitForTimeout: async () => {}, clicked };
}

const banner = [{ id: 'kurabiye-banner', text: 'We value your privacy', className: '' }];

test('AILearna banner rejects all even when Accept All is listed first', async () => {
  const page = fakePage([[{ text: 'Accept All', ancestors: banner }, { text: 'Reject All', ancestors: banner }]]);
  assert.equal(await rejectCookieOverlays(page, { log: () => {} }), true);
  assert.deepEqual(page.clicked, ['Reject All']);
});

test('cookie text detects a banner with arbitrary CSS names', () => {
  assert.equal(hasCookieContext([{ id: 'notice', text: 'We use cookies to enhance your browsing experience.' }]), true);
  assert.equal(isCookieRejectionText('  Reject   All  '), true);
  assert.equal(isCookieRejectionText('Tümünü reddet'), true);
  assert.equal(isCookieRejectionText('Accept All'), false);
  assert.equal(isCookieAcceptanceText('Accept All'), true);
  assert.equal(isCookieAcceptanceText('Reject All'), false);
  assert.equal(isCookieAcceptanceText('Continue'), false);
});

test('a genuine funnel answer is untouched and an iframe cookie banner is rejected', async () => {
  const page = fakePage([
    [{ text: 'No thanks', ancestors: [{ id: 'question', text: 'Would you like reminders? No thanks' }] }],
    [{ text: 'Reject All', ancestors: banner }]
  ]);
  assert.equal(await rejectCookieOverlays(page, { log: () => {} }), true);
  assert.deepEqual(page.clicked, ['Reject All']);
});

test('an accept-only banner is never accepted as a fallback', async () => {
  const page = fakePage([[{ text: 'Accept All', ancestors: banner }]]);
  assert.equal(await rejectCookieOverlays(page, { log: () => {} }), false);
  assert.deepEqual(page.clicked, []);
});

test('a banner that remains open is not reported as dismissed', async () => {
  const page = fakePage([[{ text: 'Reject All', ancestors: banner, staysOpen: true }]]);
  assert.equal(await rejectCookieOverlays(page, { log: () => {} }), false);
});

test('transparent cookie controls retained in the DOM are left alone', async () => {
  const page = fakePage([[{ text: 'Reject All', ancestors: banner, transparent: true }]]);
  assert.equal(await rejectCookieOverlays(page, { log: () => {} }), false);
  assert.deepEqual(page.clicked, []);
});
