const test = require('node:test');
const assert = require('node:assert/strict');
const { getAgeQuestionEvidence } = require('../funnel-crawler-multiscreen');

const page = (pageText, labels) => ({
  pageText,
  group: labels.map(text => ({ text }))
});

test('bare numeric fitness ranges are not an age question', () => {
  const evidence = getAgeQuestionEvidence(page('How many push-ups can you do?', [
    '1-10', '11-20', '20+'
  ]));
  assert.deepEqual(evidence, { explicitAgeIntent: false, hasAgeLabeledChoices: false });
});

test('an explicit age question accepts bare numeric ranges', () => {
  const evidence = getAgeQuestionEvidence(page("What's your age?", [
    '18-24', '25-34', '35-44'
  ]));
  assert.equal(evidence.explicitAgeIntent, true);
});

test('age-labeled ranges identify an age question with a generic heading', () => {
  const evidence = getAgeQuestionEvidence(page('Select one option', [
    'Age 18-24', 'Age 25-34', 'Age 35-44'
  ]));
  assert.equal(evidence.hasAgeLabeledChoices, true);
});

test('a repeated nested age label does not turn unrelated numeric options into an age question', () => {
  const evidence = getAgeQuestionEvidence(page('How many sessions per week?', [
    'Age 20-29', 'Age 20-29', '1-2', '3-4', '5+'
  ]));
  assert.equal(evidence.hasAgeLabeledChoices, false);
});
