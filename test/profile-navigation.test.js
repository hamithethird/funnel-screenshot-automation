const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldFollowProfileContinue } = require('../funnel-crawler-multiscreen');

test('informational weight-loss page with Continue does not enter the hidden profile-input fallback', () => {
  const state = {
    pageText: 'Weight loss in weeks! Target weight 180 lbs',
    cta: { text: 'CONTINUE' },
    group: []
  };
  assert.equal(shouldFollowProfileContinue(state, 0), true);
});

test('a visible goal-weight field stays on the profile form path', () => {
  assert.equal(shouldFollowProfileContinue({ cta: { text: 'CONTINUE' } }, 1), false);
});

test('a custom form without navigation remains eligible for semantic input discovery', () => {
  assert.equal(shouldFollowProfileContinue({ cta: null }, 0), false);
});
