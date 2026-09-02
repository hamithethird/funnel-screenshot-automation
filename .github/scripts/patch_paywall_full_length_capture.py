from pathlib import Path

path = Path('funnel-crawler-multiscreen.js')
source = path.read_text()

start_marker = '  async function captureHighResolutionFullPage(filename, scaleFactor = 2) {'
end_marker = '  const MAX_SCREENS = 100;'

start = source.find(start_marker)
end = source.find(end_marker, start)
if start == -1 or end == -1:
    raise SystemExit('Could not find the paywall capture helper block safely.')

replacement = r'''  async function measurePaywallCaptureGeometry() {
    return await page.evaluate(() => {
      const viewportWidth = Math.max(1, window.innerWidth || 390);
      const viewportHeight = Math.max(1, window.innerHeight || 844);
      const rootHeight = Math.max(
        viewportHeight,
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      );

      let best = null;
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width < viewportWidth * 0.62 || rect.height < viewportHeight * 0.28) continue;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        if (el.scrollHeight <= el.clientHeight + 80) continue;
        const overflowY = style.overflowY;
        const explicitlyScrollable = /auto|scroll|overlay/i.test(overflowY);
        const fillsViewport = rect.height >= viewportHeight * 0.65;
        if (!explicitlyScrollable && !fillsViewport) continue;

        const score = el.scrollHeight * Math.min(1, rect.width / viewportWidth);
        if (!best || score > best.score) best = { el, score, rect };
      }

      if (best) {
        const marker = `crawler-paywall-scroll-root-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        best.el.setAttribute('data-crawler-paywall-scroll-root', marker);
        return {
          viewportWidth,
          viewportHeight,
          rootHeight,
          internalScrollHeight: best.el.scrollHeight,
          internalClientHeight: best.el.clientHeight,
          internalTop: Math.max(0, best.rect.top),
          marker,
          captureHeight: Math.min(12000, Math.max(rootHeight, best.el.scrollHeight + Math.max(0, best.rect.top) + 24))
        };
      }

      return {
        viewportWidth,
        viewportHeight,
        rootHeight,
        internalScrollHeight: 0,
        internalClientHeight: 0,
        internalTop: 0,
        marker: '',
        captureHeight: Math.min(12000, rootHeight)
      };
    });
  }

  async function primePaywallLazyContent(geometry) {
    if (!geometry?.marker || !geometry.internalScrollHeight) return;
    const step = Math.max(350, Math.floor((geometry.internalClientHeight || geometry.viewportHeight || 844) * 0.72));
    for (let y = 0; y < geometry.internalScrollHeight; y += step) {
      await page.evaluate(({ marker, y }) => {
        const el = document.querySelector(`[data-crawler-paywall-scroll-root="${CSS.escape(marker)}"]`);
        if (el) el.scrollTop = y;
      }, { marker: geometry.marker, y }).catch(() => {});
      await page.waitForTimeout(140);
    }
    await page.evaluate((marker) => {
      const el = document.querySelector(`[data-crawler-paywall-scroll-root="${CSS.escape(marker)}"]`);
      if (el) el.scrollTop = 0;
    }, geometry.marker).catch(() => {});
    await page.waitForTimeout(350);
  }

  async function unclipPaywallScrollContainer(geometry) {
    if (!geometry?.marker) return;
    await page.evaluate((marker) => {
      const el = document.querySelector(`[data-crawler-paywall-scroll-root="${CSS.escape(marker)}"]`);
      if (!el) return;

      const contentHeight = Math.max(el.scrollHeight, el.clientHeight);
      el.style.setProperty('height', `${contentHeight}px`, 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('overflow', 'visible', 'important');

      let parent = el.parentElement;
      let hops = 0;
      while (parent && parent !== document.body && hops < 6) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        const clipsVertically = /hidden|clip|auto|scroll|overlay/i.test(style.overflowY || style.overflow || '');
        const heightBound = rect.height > 0 && rect.height < contentHeight - 40;
        if (clipsVertically || heightBound) {
          parent.style.setProperty('max-height', 'none', 'important');
          parent.style.setProperty('height', 'auto', 'important');
          parent.style.setProperty('overflow-y', 'visible', 'important');
          parent.style.setProperty('overflow', 'visible', 'important');
        }
        parent = parent.parentElement;
        hops++;
      }

      document.documentElement.style.setProperty('overflow-y', 'visible', 'important');
      document.body.style.setProperty('overflow-y', 'visible', 'important');
      document.body.style.setProperty('height', 'auto', 'important');
      document.body.style.setProperty('max-height', 'none', 'important');
    }, geometry.marker).catch(() => {});
  }

  async function captureHighResolutionFullPage(filename, scaleFactor = 2) {
    // Paywalls often keep the document itself at one viewport tall and put the
    // pricing content inside a nested scroll container. Playwright fullPage only
    // expands the document, so those pages otherwise produce a 390x844 viewport
    // screenshot even though much more paywall content exists below it.
    const originalViewport = page.viewportSize() || { width: 390, height: 844 };
    let cdp = null;
    try {
      let geometry = await measurePaywallCaptureGeometry();
      await primePaywallLazyContent(geometry);

      const initialCaptureHeight = Math.max(
        originalViewport.height,
        Math.ceil(geometry.captureHeight || geometry.rootHeight || originalViewport.height)
      );

      if (geometry.marker) {
        console.log(`Paywall uses an internal scroll container (${geometry.internalClientHeight}px visible / ${geometry.internalScrollHeight}px total). Expanding it for a complete capture.`);
      } else {
        console.log(`Paywall document height detected: ${initialCaptureHeight}px.`);
      }

      cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: originalViewport.width,
        height: Math.min(initialCaptureHeight, 12000),
        deviceScaleFactor: scaleFactor,
        mobile: false,
        screenWidth: originalViewport.width,
        screenHeight: Math.min(initialCaptureHeight, 12000)
      });

      await page.waitForTimeout(450);
      await unclipPaywallScrollContainer(geometry);
      await page.waitForTimeout(500);
      await prepareFullPageCapture();

      // Re-measure after the tall viewport and unclipping pass. Some SPAs switch
      // from an 844px shell to their real content height only after this reflow.
      const finalHeight = await page.evaluate(() => Math.max(
        window.innerHeight,
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
        ...Array.from(document.querySelectorAll('[data-crawler-paywall-scroll-root]')).map(el => el.scrollHeight + Math.max(0, el.getBoundingClientRect().top))
      )).catch(() => initialCaptureHeight);

      const boundedFinalHeight = Math.min(12000, Math.max(initialCaptureHeight, Math.ceil(finalHeight)));
      if (boundedFinalHeight > initialCaptureHeight + 20) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: originalViewport.width,
          height: boundedFinalHeight,
          deviceScaleFactor: scaleFactor,
          mobile: false,
          screenWidth: originalViewport.width,
          screenHeight: boundedFinalHeight
        });
        await page.waitForTimeout(350);
      }

      await page.screenshot({ path: filename, fullPage: true, scale: 'device' });
      console.log(`Re-captured complete paywall at ${scaleFactor}x device resolution (${originalViewport.width}px CSS width, up to ${boundedFinalHeight}px CSS height): ${filename}`);
      return true;
    } catch (error) {
      console.log('High-resolution full-length paywall capture failed; keeping the normal screenshot:', error?.message || error);
      return false;
    } finally {
      if (cdp) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }

'''

source = source[:start] + replacement + source[end:]
path.write_text(source)
print('Applied full-length paywall capture patch.')
