from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = """  async function inspectPageNavigationSafe(label = 'page inspection', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await inspectPage();
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached|target page, context or browser has been closed/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }
"""
new = """  async function inspectPageNavigationSafe(label = 'page inspection', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await inspectPage();
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }

  async function evaluateNavigationSafe(pageFunction, label = 'page evaluation', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await page.evaluate(pageFunction);
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }

  async function screenshotBufferNavigationSafe(label = 'branch screenshot', attempts = 4) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await page.screenshot({ fullPage: true });
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const navigationRace = /execution context was destroyed|cannot find context|most likely because of a navigation|frame was detached|navigation/i.test(message);
        if (!navigationRace || attempt === attempts) throw error;
        console.log(`Navigation was still settling during ${label}. Waiting before retry ${attempt + 1}/${attempts}.`);
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(350 * attempt);
      }
    }
    throw lastError;
  }
"""
if old not in s:
    raise SystemExit('inspectPageNavigationSafe block not found')
s = s.replace(old, new, 1)

s = s.replace("const backCandidate = await page.evaluate(() => {", "const backCandidate = await evaluateNavigationSafe(() => {", 1)

old2 = """      await waitForScreenshotReady({ minimumWaitMs: 2200, maxWaitMs: 5800 });
      const landingState = await inspectPage();
      const fingerprint = normalizeContextText(landingState.pageText);
      if (!fingerprint) return { ok: false, reason: 'no-fingerprint' };
      const screenshotBuffer = await page.screenshot({ fullPage: true });
"""
new2 = """      await waitForScreenshotReady({ minimumWaitMs: 2200, maxWaitMs: 5800 });
      const landingState = await inspectPageNavigationSafe('branch outcome inspection');
      const fingerprint = normalizeContextText(landingState.pageText);
      if (!fingerprint) return { ok: false, reason: 'no-fingerprint' };
      const screenshotBuffer = await screenshotBufferNavigationSafe('branch outcome screenshot');
"""
if old2 not in s:
    raise SystemExit('recordOutcome landing block not found')
s = s.replace(old2, new2, 1)

p.write_text(s)
