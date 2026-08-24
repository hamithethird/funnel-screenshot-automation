const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];

  if (!url) {
    console.error('Please provide a URL.');
    process.exit(1);
  }

  const browser = await chromium.launch();

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }
  });

  await page.goto(url, {
    waitUntil: 'networkidle'
  });

  // Screenshot before doing anything
  await page.screenshot({
    path: 'step-before.png',
    fullPage: true
  });

  const analysis = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const all = Array.from(document.querySelectorAll('*'));

    const clickable = all
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < vh &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');

        const interactive =
          tag === 'button' ||
          tag === 'a' ||
          tag === 'label' ||
          tag === 'input' ||
          role === 'button' ||
          role === 'radio' ||
          role === 'checkbox' ||
          el.hasAttribute('onclick') ||
          el.tabIndex >= 0 ||
          style.cursor === 'pointer';

        if (!visible || !interactive) return null;

        const id = `auto-${index}`;
        el.setAttribute('data-auto-id', id);

        return {
          id,
          parent: el.parentElement,
          text: (el.innerText || el.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80),
          tag,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left
        };
      })
      .filter(Boolean);

    // ------------------------------------------------
    // 1. LOOK FOR A GROUP OF SIMILAR ANSWER OPTIONS
    // ------------------------------------------------

    const parents = new Map();

    for (const item of clickable) {
      if (!item.parent) continue;

      if (!parents.has(item.parent)) {
        parents.set(item.parent, []);
      }

      parents.get(item.parent).push(item);
    }

    let bestGroup = null;

    for (const items of parents.values()) {
      if (items.length < 3 || items.length > 8) continue;

      const widths = items.map(x => x.width);
      const heights = items.map(x => x.height);

      const avgWidth =
        widths.reduce((a, b) => a + b, 0) / widths.length;

      const avgHeight =
        heights.reduce((a, b) => a + b, 0) / heights.length;

      const similarSizes = items.every(item =>
        Math.abs(item.width - avgWidth) <= avgWidth * 0.35 &&
        Math.abs(item.height - avgHeight) <= avgHeight * 0.35
      );

      if (!similarSizes) continue;

      const usableSize =
        avgWidth >= 35 &&
        avgHeight >= 28;

      if (!usableSize) continue;

      const groupTop = Math.min(...items.map(x => x.top));
      const groupBottom = Math.max(...items.map(x => x.bottom));

      // Ignore groups that look like top navigation
      if (groupBottom < vh * 0.2) continue;

      const score =
        50 +
        Math.min(items.length * 5, 30);

      if (!bestGroup || score > bestGroup.score) {
        bestGroup = {
          score,
          items
        };
      }
    }

    if (bestGroup) {
      const middleIndex =
        Math.floor(bestGroup.items.length / 2);

      return {
        type: 'answer-group',
        target: bestGroup.items[middleIndex],
        options: bestGroup.items.map(x => x.text)
      };
    }

    // ------------------------------------------------
    // 2. OTHERWISE LOOK FOR A PRIMARY CTA
    // ------------------------------------------------

    let bestCTA = null;

    for (const item of clickable) {
      let score = 0;

      const centerY =
        item.top + item.height / 2;

      const widthRatio =
        item.width / vw;

      // Near bottom of screen
      if (centerY > vh * 0.65) {
        score += 40;
      } else if (centerY > vh * 0.5) {
        score += 20;
      }

      // Wide
      if (widthRatio >= 0.75) {
        score += 30;
      } else if (widthRatio >= 0.5) {
        score += 20;
      }

      // Typical CTA height
      if (item.height >= 40 && item.height <= 90) {
        score += 20;
      }

      // Not tiny
      if (item.width < 80 || item.height < 25) {
        score -= 30;
      }

      if (!bestCTA || score > bestCTA.score) {
        bestCTA = {
          ...item,
          score
        };
      }
    }

    if (bestCTA && bestCTA.score >= 50) {
      return {
        type: 'primary-cta',
        target: bestCTA
      };
    }

    return {
      type: 'nothing-found'
    };
  });

  console.log('\nDetected interaction:');
  console.log(analysis);

  if (analysis.target) {
    await page
      .locator(`[data-auto-id="${analysis.target.id}"]`)
      .click();

    await page.waitForTimeout(1200);

    await page.screenshot({
      path: 'step-after.png',
      fullPage: true
    });

    console.log(
      `Clicked: ${analysis.type}`
    );
  } else {
    console.log('No safe interaction detected.');
  }

  await browser.close();
})();