const fs = require('fs');

const path = 'funnel-crawler-multiscreen.js';
let source = fs.readFileSync(path, 'utf8');

if (source.includes('// BLOCKING_MODAL_RECOVERY')) {
  console.log('Blocking-modal recovery is already applied.');
  process.exit(0);
}

const insertMarker = 'async function inspectPage() {';

const helper = `// BLOCKING_MODAL_RECOVERY
async function dismissBlockingConsentOverlay() {
  const overlaySelectors = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.cky-modal',
    '.cky-modal-open',
    '[class*="cookie"]',
    '[id*="cookie"]',
    '[class*="consent"]',
    '[id*="consent"]'
  ];

  const overlays = page.locator(overlaySelectors.join(','));
  const overlayCount = await overlays.count();

  const affirmativePatterns = [
    /^accept all$/i,
    /^accept$/i,
    /^allow all$/i,
    /^allow$/i,
    /^agree$/i,
    /^i agree$/i,
    /^consent$/i,
    /^ok$/i,
    /^okay$/i,
    /^got it$/i,
    /^tümünü kabul et$/i,
    /^kabul et$/i,
    /^hepsini kabul et$/i,
    /^izin ver$/i,
    /^aceptar todo$/i,
    /^aceptar$/i,
    /^aceitar tudo$/i,
    /^aceitar$/i,
    /^tout accepter$/i,
    /^accepter$/i,
    /^alle akzeptieren$/i,
    /^akzeptieren$/i,
    /^accetta tutto$/i,
    /^accetta$/i
  ];

  for (let i = 0; i < overlayCount; i++) {
    const overlay = overlays.nth(i);

    if (!(await overlay.isVisible().catch(() => false))) {
      continue;
    }

    const actions = overlay.locator(
      'button, [role="button"], input[type="button"], input[type="submit"], a'
    );

    const actionCount = await actions.count();

    for (let j = 0; j < actionCount; j++) {
      const action = actions.nth(j);

      if (!(await action.isVisible().catch(() => false))) {
        continue;
      }

      const text = (
        (await action.innerText().catch(() => '')) ||
        (await action.getAttribute('aria-label')) ||
        (await action.getAttribute('value')) ||
        ''
      )
        .trim()
        .replace(/\\s+/g, ' ');

      if (!affirmativePatterns.some(pattern => pattern.test(text))) {
        continue;
      }

      console.log('Blocking consent modal detected. Dismissing with:', text);

      try {
        await action.click({ timeout: 5000 });
      } catch {
        continue;
      }

      for (let attempt = 0; attempt < 10; attempt++) {
        await page.waitForTimeout(200);

        if (!(await overlay.isVisible().catch(() => false))) {
          console.log('Blocking consent modal dismissed.');
          return true;
        }
      }

      // The overlay may have been replaced by another DOM node after click.
      const stillBlocking = await page.locator(
        '[role="dialog"]:visible, [aria-modal="true"]:visible, .cky-modal-open:visible'
      ).count();

      if (stillBlocking === 0) {
        console.log('Blocking consent modal dismissed.');
        return true;
      }
    }
  }

  return false;
}

async function safeCrawlerClick(locator, description = 'target') {
  // Proactively clear cookie/privacy overlays that may appear after startup.
  await dismissBlockingConsentOverlay();

  try {
    await locator.click({ timeout: 7000 });
    return true;
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const blockedByOverlay =
      /intercepts pointer events/i.test(message) ||
      /another element/i.test(message);

    if (!blockedByOverlay) {
      throw error;
    }

    console.log('Click blocked while targeting:', description);

    const dismissed = await dismissBlockingConsentOverlay();

    if (!dismissed) {
      throw error;
    }

    console.log('Retrying original click after modal dismissal:', description);
    await locator.click({ timeout: 7000 });
    return true;
  }
}

`;

if (!source.includes(insertMarker)) {
  throw new Error('Could not find inspectPage insertion point.');
}

source = source.replace(insertMarker, helper + insertMarker);

// Answer-group clicks.
source = source.replace(
`      await page
        .locator(
          \`[data-auto-id="\${option.id}"]\`
        )
        .click();`,
`      await safeCrawlerClick(
        page.locator(
          \`[data-auto-id="\${option.id}"]\`
        ),
        option.text || 'answer option'
      );`
);

// CTA click after answer selection (appears in more than one handler).
source = source.replaceAll(
`          await page
            .locator(
              \`[data-auto-id="\${afterSelection.cta.id}"]\`
            )
            .click();`,
`          await safeCrawlerClick(
            page.locator(
              \`[data-auto-id="\${afterSelection.cta.id}"]\`
            ),
            afterSelection.cta.text || 'answer-group CTA'
          );`
);

// Page-level primary CTA.
source = source.replace(
`      await page
        .locator(
          \`[data-auto-id="\${state.cta.id}"]\`
        )
        .click();`,
`      await safeCrawlerClick(
        page.locator(
          \`[data-auto-id="\${state.cta.id}"]\`
        ),
        state.cta.text || 'primary CTA'
      );`
);

// Form submit controls.
source = source.replaceAll(
  '          await submit.click();',
  "          await safeCrawlerClick(submit, 'form submit control');"
);

source = source.replaceAll(
  '        await nearbyAction.locator.click();',
  "        await safeCrawlerClick(nearbyAction.locator, nearbyAction.text || 'bottom primary CTA');"
);

// Make the main loop recover from a late modal before inspection/capture too.
const settleMarker = '    await waitForVisualSettle();\n\n    const state = await inspectPage();';
const settleReplacement = `    await waitForVisualSettle();

    // Cookie/privacy overlays can appear after navigation or after a delay.
    // Clear them before classifying the next screen.
    await dismissBlockingConsentOverlay();

    const state = await inspectPage();`;

if (source.includes(settleMarker)) {
  source = source.replace(settleMarker, settleReplacement);
}

fs.writeFileSync(path, source);
console.log('Applied generic blocking cookie/privacy modal recovery.');
console.log('Meaningful clicks now retry once after dismissing a blocking consent overlay.');
