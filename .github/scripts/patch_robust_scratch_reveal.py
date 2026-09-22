from pathlib import Path

p = Path("funnel-crawler-multiscreen.js")
s = p.read_text()

start_marker = "  async function handleScratchReveal(screenNumber, state) {"
end_marker = "  async function handleEnglishLanguageChoice() {"

new_func = r'''  async function handleScratchReveal(screenNumber, state) {
    const probe = await page.evaluate(() => {
      const normalize = value => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body && document.body.innerText || '');
      const scratchWords = /\b(scratch|scratch to reveal|scratch here|reveal your|reveal discount|reveal offer|reveal prize|uncover|rub to reveal)\b/i;
      const pageSuggestsScratch = scratchWords.test(bodyText);
      const candidates = Array.from(document.querySelectorAll(
        'canvas, [class*="scratch" i], [id*="scratch" i], [aria-label*="scratch" i], ' +
        '[class*="reveal" i], [id*="reveal" i], [aria-label*="reveal" i], ' +
        '[class*="prize" i], [id*="prize" i]'
      ));
      const visible = candidates.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const ok = rect.width >= 120 && rect.height >= 70 &&
          rect.bottom > 0 && rect.right > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 && style.pointerEvents !== 'none';
        if (!ok) return null;
        const attrs = normalize([
          el.id,
          el.className && String(el.className),
          el.getAttribute('aria-label'),
          el.getAttribute('title')
        ].filter(Boolean).join(' '));
        let score = 0;
        if (scratchWords.test(attrs)) score += 120;
        if (el.tagName.toLowerCase() === 'canvas') score += 40;
        if (pageSuggestsScratch) score += 65;
        if (rect.width >= window.innerWidth * 0.45) score += 20;
        return { index, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);

      if (!visible.length || visible[0].score < 60) return null;
      const target = candidates[visible[0].index];
      const id = 'crawler-scratch-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      target.setAttribute('data-crawler-scratch-id', id);
      target.scrollIntoView({ block: 'center', inline: 'center' });
      return { id, score: visible[0].score };
    });

    if (!probe) return { handled: false, advanced: false };
    console.log('Scratch/reveal interaction detected. Attempting a full-coverage scratch.');

    const beforeState = state || await inspectPage();
    const beforeSignature = pageSignature(beforeState);
    const beforeUrl = sanitizeUrl(page.url());

    if (currentNumberedCaptureSignature && beforeSignature !== currentNumberedCaptureSignature) {
      console.log('Scratch/reveal page appeared after the current numbered screenshot. Deferring interaction so its closed state is captured on the next numbered screen.');
      return { handled: true, advanced: true };
    }

    const target = page.locator('[data-crawler-scratch-id="' + probe.id + '"]');
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(180);

    let box = await target.boundingBox().catch(() => null);
    if (!box) return { handled: true, advanced: false };

    const beforeVisual = await target.screenshot().catch(() => null);

    const scratchPass = async pass => {
      box = await target.boundingBox().catch(() => box);
      if (!box) return;
      const left = box.x + box.width * 0.05;
      const right = box.x + box.width * 0.95;
      const top = box.y + box.height * 0.06;
      const bottom = box.y + box.height * 0.94;

      const rows = pass === 0 ? 14 : 18;
      for (let row = 0; row < rows; row++) {
        const y = top + ((bottom - top) * row / Math.max(rows - 1, 1));
        const startX = row % 2 === 0 ? left : right;
        const endX = row % 2 === 0 ? right : left;
        await page.mouse.move(startX, y);
        await page.mouse.down();
        await page.mouse.move(endX, y, { steps: 28 });
        await page.mouse.up();
      }

      const columns = pass === 0 ? 7 : 10;
      for (let col = 0; col < columns; col++) {
        const x = left + ((right - left) * col / Math.max(columns - 1, 1));
        const startY = col % 2 === 0 ? top : bottom;
        const endY = col % 2 === 0 ? bottom : top;
        await page.mouse.move(x, startY);
        await page.mouse.down();
        await page.mouse.move(x, endY, { steps: 24 });
        await page.mouse.up();
      }

      if (pass > 0) {
        await page.mouse.move(left, top);
        await page.mouse.down();
        await page.mouse.move(right, bottom, { steps: 30 });
        await page.mouse.up();
        await page.mouse.move(right, top);
        await page.mouse.down();
        await page.mouse.move(left, bottom, { steps: 30 });
        await page.mouse.up();
      }
    };

    const clickScratchCompletionCTA = async () => {
      const id = await page.evaluate(() => {
        const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
        const positive = /^(?:continue|next|see|show|view|get|claim|unlock|reveal|open)(?:\s+.{0,55})?$/i;
        const visible = el => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
            r.top < window.innerHeight && r.left < window.innerWidth &&
            st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
            st.pointerEvents !== 'none';
        };
        const candidates = [];
        for (const el of Array.from(document.querySelectorAll('button, a, [role="button"], [onclick], [tabindex]'))) {
          if (!visible(el)) continue;
          const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
          if (!positive.test(text)) continue;
          if (/\b(back|previous|close|dismiss|no thanks|not now|buy|purchase|pay)\b/i.test(text)) continue;
          const r = el.getBoundingClientRect();
          candidates.push({ el, top: r.top, area: r.width * r.height, text });
        }
        candidates.sort((a, b) => b.top - a.top || b.area - a.area);
        if (!candidates.length) return null;
        const chosen = candidates[0];
        const id = 'crawler-scratch-complete-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
        chosen.el.setAttribute('data-crawler-scratch-complete-id', id);
        chosen.el.scrollIntoView({ block: 'center', inline: 'center' });
        return { id, text: chosen.text };
      }).catch(() => null);
      if (!id || !id.id) return false;
      console.log('Post-scratch CTA detected:', id.text || '(no text)');
      return await safeCrawlerClick(
        page.locator('[data-crawler-scratch-complete-id="' + id.id + '"]'),
        id.text || 'post-scratch CTA'
      );
    };

    let visualChanged = false;
    let afterState = beforeState;

    try {
      for (let pass = 0; pass < 3; pass++) {
        console.log('Scratch coverage pass ' + (pass + 1) + '/3.');
        await scratchPass(pass);
        await page.waitForTimeout(550);

        const currentVisual = await target.screenshot().catch(() => null);
        if (beforeVisual && currentVisual && !beforeVisual.equals(currentVisual)) visualChanged = true;

        afterState = await inspectPageNavigationSafe('post-scratch inspection').catch(() => beforeState);
        const signatureChanged = pageSignature(afterState) !== beforeSignature;
        const urlChanged = sanitizeUrl(page.url()) !== beforeUrl;
        const paywallState = await inspectPaywallState().catch(() => ({ isPagePaywall: false }));

        if (signatureChanged || urlChanged || paywallState.isPagePaywall) break;

        const ctaClicked = await clickScratchCompletionCTA();
        if (ctaClicked) {
          if (await waitForAdvancement(beforeSignature, 10000)) {
            afterState = await inspectPageNavigationSafe('post-scratch CTA landing').catch(() => afterState);
            break;
          }
        }
      }
    } catch (error) {
      console.log('Scratch gesture failed:', String(error && error.message || error).split('\n')[0]);
      return { handled: true, advanced: false };
    }

    await page.evaluate(() => {
      const selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
      const active = document.activeElement;
      if (active && typeof active.blur === 'function') active.blur();
    }).catch(() => {});

    await page.waitForTimeout(300);
    afterState = await inspectPageNavigationSafe('final scratch inspection').catch(() => afterState);
    let changed = pageSignature(afterState) !== beforeSignature || sanitizeUrl(page.url()) !== beforeUrl;
    let paywallState = await inspectPaywallState().catch(() => ({ isPagePaywall: false }));

    if (screenNumber !== null && (changed || visualChanged || paywallState.isPagePaywall)) {
      const revealFilename = path.join(OUTPUT_DIR, String(screenNumber).padStart(2, '0') + 'b.png');
      await page.screenshot({ path: revealFilename, fullPage: true });
      console.log('Captured scratch/reveal completed: ' + revealFilename);
      supplementalCounterByScreen.set(
        screenNumber,
        Math.max(supplementalCounterByScreen.get(screenNumber) || 0, 2)
      );
    }

    if (changed || paywallState.isPagePaywall) return { handled: true, advanced: true };

    const navigationResult = await clickStrongNavigation(afterState, 'post-scratch navigation CTA');
    if (navigationResult.handled) return navigationResult;

    const completionClicked = await clickScratchCompletionCTA();
    if (completionClicked && await waitForAdvancement(beforeSignature, 12000)) {
      return { handled: true, advanced: true };
    }

    if (visualChanged && box) {
      console.log('Scratch surface changed but no CTA/navigation was detected. Trying one center tap on the revealed card.');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      if (await waitForAdvancement(beforeSignature, 8000)) {
        return { handled: true, advanced: true };
      }
    }

    console.log(
      visualChanged
        ? 'Scratch surface was visibly altered, but the funnel still did not expose a safe route to the next page.'
        : 'Scratch surface did not visibly change after full-coverage gestures.'
    );
    return { handled: true, advanced: false };
  }

'''

if start_marker not in s or end_marker not in s:
    raise SystemExit("Could not find scratch handler boundaries.")

start = s.index(start_marker)
end = s.index(end_marker, start)
s = s[:start] + new_func + s[end:]

p.write_text(s)
print("Patched robust full-coverage scratch interaction.")
