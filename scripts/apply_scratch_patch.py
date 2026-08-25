from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

anchor = "  async function handleEnglishLanguageChoice() {"
insert = r'''  async function handleScratchReveal(screenNumber, state) {
    const probe = await page.evaluate(() => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body.innerText || '');
      const scratchWords = /\b(scratch|scratch to reveal|scratch here|reveal your|reveal discount|reveal offer|reveal prize|uncover|rub to reveal)\b/i;
      const pageSuggestsScratch = scratchWords.test(bodyText);
      const candidates = Array.from(document.querySelectorAll('canvas, [class*="scratch" i], [id*="scratch" i], [aria-label*="scratch" i], [class*="reveal" i], [id*="reveal" i], [aria-label*="reveal" i], [class*="prize" i], [id*="prize" i]'));
      const visible = candidates.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const ok = rect.width >= 120 && rect.height >= 70 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        if (!ok) return null;
        const attrs = normalize([el.id, el.className && String(el.className), el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '));
        let score = 0;
        if (scratchWords.test(attrs)) score += 120;
        if (el.tagName.toLowerCase() === 'canvas') score += 35;
        if (pageSuggestsScratch) score += 60;
        if (rect.width >= window.innerWidth * 0.45) score += 20;
        return { index, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      if (!visible.length || visible[0].score < 60) return null;
      const target = candidates[visible[0].index];
      const id = `crawler-scratch-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      target.setAttribute('data-crawler-scratch-id', id);
      return { id, score: visible[0].score };
    });

    if (!probe) return { handled: false, advanced: false };
    console.log('Scratch/reveal interaction detected. Attempting to uncover the hidden offer.');

    const beforeState = state || await inspectPage();
    const beforeSignature = pageSignature(beforeState);
    const target = page.locator(`[data-crawler-scratch-id="${probe.id}"]`);
    const box = await target.boundingBox().catch(() => null);
    if (!box) return { handled: true, advanced: false };

    const left = box.x + box.width * 0.12;
    const right = box.x + box.width * 0.88;
    const top = box.y + box.height * 0.18;
    const bottom = box.y + box.height * 0.82;
    const rows = 7;

    try {
      for (let row = 0; row < rows; row++) {
        const y = top + ((bottom - top) * row / Math.max(rows - 1, 1));
        const startX = row % 2 === 0 ? left : right;
        const endX = row % 2 === 0 ? right : left;
        await page.mouse.move(startX, y);
        await page.mouse.down();
        await page.mouse.move(endX, y, { steps: 18 });
        await page.mouse.up();
        await page.waitForTimeout(80);
      }
    } catch (error) {
      console.log('Scratch gesture failed:', String(error?.message || error).split('\n')[0]);
      return { handled: true, advanced: false };
    }

    await page.waitForTimeout(900);
    await waitForScreenshotReady({ minimumWaitMs: 700, maxWaitMs: 2600, pollMs: 250 });
    const afterState = await inspectPage();
    const changed = pageSignature(afterState) !== beforeSignature;

    if (screenNumber !== null && changed) {
      await captureSupplementalState(screenNumber, afterState, 'scratch/reveal completed', [], 0.99);
    }

    const navigationResult = await clickStrongNavigation(afterState, 'post-scratch navigation CTA');
    if (navigationResult.handled) return navigationResult;
    return { handled: true, advanced: changed };
  }

'''

if 'async function handleScratchReveal' not in s:
    if anchor not in s:
        raise SystemExit('Could not find handler insertion anchor')
    s = s.replace(anchor, insert + anchor, 1)

old = "    const skippedOptionalInput = await handleSkippableInputRequirement(state);\n    if (skippedOptionalInput) return true;\n\n    const navigationResult = await clickStrongNavigation(state);"
new = "    const skippedOptionalInput = await handleSkippableInputRequirement(state);\n    if (skippedOptionalInput) return true;\n\n    const scratchResult = await handleScratchReveal(screenNumber, state);\n    if (scratchResult.handled) return scratchResult.advanced;\n\n    const navigationResult = await clickStrongNavigation(state);"
if 'const scratchResult = await handleScratchReveal' not in s:
    if old not in s:
        raise SystemExit('Could not find advanceOneScreen insertion anchor')
    s = s.replace(old, new, 1)

p.write_text(s)
