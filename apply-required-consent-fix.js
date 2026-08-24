const fs = require('fs');

const path = 'funnel-crawler-multiscreen.js';
let source = fs.readFileSync(path, 'utf8');

// ------------------------------------------------------------
// 1. Generate one fresh ASCII-only Gmail address per crawler run
// ------------------------------------------------------------
const randomHelper = `function generateRandomAsciiString(length = 16) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += alphabet[
      Math.floor(Math.random() * alphabet.length)
    ];
  }

  return result;
}

const RUN_EMAIL =
  \`${'${generateRandomAsciiString(16)}'}@gmail.com\`;

`;

if (!source.includes('const RUN_EMAIL =')) {
  const iifeMarker = '(async () => {';

  if (!source.includes(iifeMarker)) {
    throw new Error('Could not find crawler startup insertion point.');
  }

  source = source.replace(
    iifeMarker,
    randomHelper + iifeMarker
  );
}

source = source.replace(
  /value\s*=\s*['\"]alex@example\.com['\"];?/g,
  'value = RUN_EMAIL;'
);

// ------------------------------------------------------------
// 2. Required legal consent checkbox handling
// ------------------------------------------------------------
const helperMarker = '  async function handleGenericFormInput(state) {';
const helper = `  async function handleRequiredAgreementCheckboxes(input) {
    const legalPattern = /\\b(terms?|conditions?|privacy|policy|legal|agreement)\\b/i;
    const acceptancePattern = /\\b(accept|agree|consent)\\b/i;
    const marketingPattern = /\\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?)\\b/i;

    const candidates = page.locator(
      'input[type="checkbox"], [role="checkbox"]'
    );

    const count = await candidates.count();
    let handled = false;

    for (let i = 0; i < count; i++) {
      const checkbox = candidates.nth(i);

      if (!(await checkbox.isVisible())) {
        continue;
      }

      const info = await checkbox.evaluate(el => {
        let labelText = '';

        if (el.id) {
          const label = document.querySelector(
            \`label[for="\${CSS.escape(el.id)}"]\`
          );

          if (label) {
            labelText =
              label.innerText ||
              label.textContent ||
              '';
          }
        }

        if (!labelText) {
          const parentLabel = el.closest('label');

          if (parentLabel) {
            labelText =
              parentLabel.innerText ||
              parentLabel.textContent ||
              '';
          }
        }

        if (!labelText) {
          labelText = el.getAttribute('aria-label') || '';
        }

        // For custom checkbox components, walk only through small local
        // containers that contain this checkbox and no other checkbox.
        // This prevents one checkbox from inheriting the text of a nearby
        // sibling checkbox (for example, a newsletter opt-in beside terms).
        if (!labelText) {
          let ancestor = el.parentElement;
          let depth = 0;

          while (ancestor && depth < 4) {
            const checkboxCount = ancestor.querySelectorAll(
              'input[type="checkbox"], [role="checkbox"]'
            ).length;

            const text = (
              ancestor.innerText ||
              ancestor.textContent ||
              ''
            )
              .trim()
              .replace(/\\s+/g, ' ');

            if (
              checkboxCount === 1 &&
              text.length > 0 &&
              text.length <= 300
            ) {
              labelText = text;
              break;
            }

            ancestor = ancestor.parentElement;
            depth++;
          }
        }

        return {
          text: labelText
            .trim()
            .replace(/\\s+/g, ' ')
            .slice(0, 300),
          checked:
            el.checked === true ||
            el.getAttribute('aria-checked') === 'true',
          required:
            el.required === true ||
            el.getAttribute('required') !== null ||
            el.getAttribute('aria-required') === 'true'
        };
      });

      if (info.checked || !info.text) {
        continue;
      }

      const isLegalAgreement =
        legalPattern.test(info.text) &&
        (
          acceptancePattern.test(info.text) ||
          info.required
        );

      const isMarketingOnly =
        marketingPattern.test(info.text) &&
        !legalPattern.test(info.text);

      if (!isLegalAgreement || isMarketingOnly) {
        continue;
      }

      console.log(
        'Required legal agreement checkbox detected:',
        info.text
      );

      try {
        await checkbox.check({ force: false });
      } catch {
        await checkbox.click();
      }

      await page.waitForTimeout(350);
      handled = true;
    }

    if (handled) {
      await input.evaluate(el => el.blur());
      await page.waitForTimeout(700);
    }

    return handled;
  }

`;

const helperStart =
  '  async function handleRequiredAgreementCheckboxes(input) {';

if (source.includes(helperStart)) {
  const start = source.indexOf(helperStart);
  const end = source.indexOf(helperMarker, start);

  if (end === -1) {
    throw new Error('Could not find the end of the existing consent helper.');
  }

  source =
    source.slice(0, start) +
    helper +
    source.slice(end);
} else {
  if (!source.includes(helperMarker)) {
    throw new Error('Could not find form-handler insertion point.');
  }

  source = source.replace(
    helperMarker,
    helper + helperMarker
  );
}

const consentCall =
  '      await handleRequiredAgreementCheckboxes(input);';

if (!source.includes(consentCall)) {
  const fillMarker =
    `      await page.waitForTimeout(500);\n\n      const beforeSubmitState = await inspectPage();`;

  const fillReplacement =
    `      await page.waitForTimeout(500);\n\n      // Handle required legal acceptance before looking for the submit CTA.\n      // Optional newsletter/marketing consent is intentionally skipped.\n      await handleRequiredAgreementCheckboxes(input);\n\n      const beforeSubmitState = await inspectPage();`;

  if (!source.includes(fillMarker)) {
    throw new Error('Could not find post-fill insertion point.');
  }

  source = source.replace(
    fillMarker,
    fillReplacement
  );
}

fs.writeFileSync(path, source);

console.log('Applied crawler form updates.');
console.log('Each run now uses a fresh lowercase a-z Gmail address.');
console.log('Optional marketing/newsletter checkboxes are skipped.');
console.log('Required legal terms/privacy agreement checkboxes are accepted.');
