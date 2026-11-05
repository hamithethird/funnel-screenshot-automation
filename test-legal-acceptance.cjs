const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cookies = require('./cookie-consent');
const source = fs.readFileSync(`${__dirname}/funnel-crawler-multiscreen.js`, 'utf8');
const start = source.indexOf('  async function handleLegalAcceptanceButton(state) {');
const end = source.indexOf('\n  async function advanceOneScreen(', start);
const handler = source.slice(start, end);

async function run({text = 'I agree', context = 'Please agree to our Terms of Use and Privacy Policy.', disabled = false, hidden = false, extra = false, consentActive = true, advanced = true} = {}) {
  const attrs = {};
  const container = {innerText: context, parentElement: null};
  const button = {innerText: text, disabled, parentElement: container,
    getBoundingClientRect: () => ({width: 200, height: 50}),
    getAttribute: name => attrs[name] || null,
    setAttribute: (name, value) => { attrs[name] = value; }};
  const clicks = [];
  const sandbox = {
    document: {body: container, querySelectorAll: () => extra ? [button, button] : [button]},
    getComputedStyle: () => ({display: hidden ? 'none' : 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto'}),
    page: {evaluate: fn => fn(), locator: selector => selector},
    handleRequiredPageConsentCheckboxes: async () => ({found:true,active:consentActive}),
    pageSignature: () => 'before', console: {log() {}},
    safeCrawlerClick: async (...args) => { clicks.push(args);return true; },
    waitForAdvancement: async () => advanced,
  };
  const result = await vm.runInNewContext(`(${handler})({pageText:'before'})`, sandbox);
  return {handled: result.handled, advanced: result.advanced, clicks: clicks.length};
}

(async () => {
  for (const text of ['I agree', 'Accept terms', 'Agree and continue', 'Accept and continue', 'I accept the Privacy Policy']) {
    assert.deepEqual(await run({text}), {handled:true,advanced:true,clicks:1}, text);
  }
  for (const options of [
    {text:'Continue'}, {text:'Terms of Use'}, {text:'Accept all cookies'},
    {context:'Accept cookies. Terms of Use'}, {context:'Accept our newsletter. Terms of Use'},
    {context:'Accept Terms and start your subscription for $9.99'},
    {context:'Choose your favorite color'}, {disabled:true}, {hidden:true}, {extra:true},
  ]) assert.deepEqual(await run(options), {handled:false,advanced:false,clicks:0}, JSON.stringify(options));
  assert.deepEqual(await run({consentActive:false}), {handled:true,advanced:false,clicks:0});
  assert.deepEqual(await run({advanced:false}), {handled:true,advanced:false,clicks:1});
  for (const text of ['Disable Optional Cookies', 'Disable Non-Essential Cookies', 'Reject all', 'Necessary cookies only']) assert(cookies.isCookieRejectionText(text), text);
  for (const text of ['Accept all', 'I agree', 'Disable account']) assert(!cookies.isCookieRejectionText(text), text);
  console.log('24 consent cases passed (legal acceptance, cookie rejection, payment, marketing, ambiguity, state verification).');
})().catch(error => { console.error(error);process.exitCode = 1; });
