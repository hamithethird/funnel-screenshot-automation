const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const source = fs.readFileSync(`${__dirname}/funnel-crawler-multiscreen.js`, 'utf8');
    const start = source.indexOf('  async function inspectPage() {');
    const end = source.indexOf('\n  function pageSignature(', start);
    const inspect = vm.runInNewContext(`(${source.slice(start,end)})`, {page});
    const render = async (question, cards) => {
      await page.setContent(`<style>body{margin:20px}.row{margin-top:12px}.card{cursor:pointer;width:330px;height:70px;background:#f8f9ff;display:flex;align-items:center}</style><h1>${question}</h1>${cards.map(text=>`<div class="row"><div class="card">${text}</div></div>`).join('')}`);
      return await inspect();
    };
    const two = await render('How do you feel about constructive feedback?', ['I take it as an opportunity','Makes me feel bad']);
    assert.deepEqual(two.group.map(item=>item.text), ['I take it as an opportunity','Makes me feel bad']);
    assert.equal((await render('Resources', ['Help center','Contact us'])).group.length,0);
    assert.equal((await render('What do you prefer?', ['One','Two','Three'])).group.length,3);
    assert.equal((await render('What do you prefer?', ['Continue','Next'])).group.length,0);
    console.log('4 real Chromium spatial-answer regression cases passed.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
