const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2] || `${__dirname}/funnel-crawler-multiscreen.js`, 'utf8');
const start = source.indexOf('  function isOptionalMarketingPrompt(state) {');
const end = source.indexOf('  async function handleLegalAcceptanceButton(state) {', start);
assert(start >= 0 && end > start, 'Marketing handler is present');
const code = source.slice(start,end);

async function run(pageText, labels, group = []) {
  let clicked = null;
  const sandbox = {
    page: {getByText(pattern) {
      const label = labels.find(text => pattern.test(text));
      return {first: () => ({isVisible: async () => !!label, innerText: async () => label, label})};
    }},
    console: {log() {}}, pageSignature: () => 'before',
    safeCrawlerClick: async target => {clicked = target.label;return true;},
    waitForAdvancement: async () => true,
  };
  const handler = vm.runInNewContext(`${code}\nhandleOptionalMarketingPrompt`, sandbox);
  const result = await handler({pageText,group});
  return {handled:result.handled, advanced:result.advanced,clicked};
}

(async () => {
  const prompt = 'Do you want to receive emails with self-growth tips, updates on our products, and special offers?';
  for (const negative of ["I don't want to receive tips or updates", 'I don’t want to receive tips or updates']) {
    assert.deepEqual(await run(prompt,['Sure, I’m in!',negative]),{handled:true,advanced:true,clicked:negative});
  }
  assert.deepEqual(await run(prompt.replace('emails','e-mails'),['Yes','No thanks']),{handled:true,advanced:true,clicked:'No thanks'});
  assert.deepEqual(await run(prompt,['Sure, I’m in!']),{handled:true,advanced:false,clicked:null});
  assert.deepEqual(await run('How do you feel about feedback?',['I take it as an opportunity','Makes me feel bad']),{handled:false,advanced:false,clicked:null});
  assert.deepEqual(await run('I agree to the Terms of Use and Privacy Policy',['I agree']),{handled:false,advanced:false,clicked:null});
  assert.deepEqual(await run('', ['Sure, I’m in!', 'I don’t want to receive tips or updates'], [{text:'I don’t want to receive tips or updates'}]),{handled:true,advanced:true,clicked:'I don’t want to receive tips or updates'});
  console.log('7 optional-marketing regression cases passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
