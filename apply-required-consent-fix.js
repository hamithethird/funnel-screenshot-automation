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
    let legalFound = false;
    let allLegalActive = true;

    for (let i = 0; i < count; i++) {
      const checkbox = candidates.nth(i);

      if (!(await checkbox.isVisible())) {
        continue;
      }

      const getInfo = async () =>
        await checkbox.evaluate(el => {
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

          // For custom checkbox components, only inherit text from a local
          // container containing this checkbox and no sibling checkbox.
          if (!labelText) {
            let ancestor = el.parentElement;
            let depth = 0;

            while (ancestor && depth < 5) {
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
                text.length <= 350
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
              .slice(0, 350),
            checked:
              el.checked === true ||
              el.getAttribute('aria-checked') === 'true',
            required:
              el.required === true ||
              el.getAttribute('required') !== null ||
              el.getAttribute('aria-required') === 'true'
          };
        });

      let info = await getInfo();

      if (!info.text) {
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

      legalFound = true;

      if (!info.checked) {
        console.log(
          'Required legal agreement checkbox detected:',
          info.text
        );
      }

      // Do not merely click once and assume success. Keep verifying the
      // actual checked/aria-checked state because custom UI components may
      // swallow a click or briefly reset their state.
      for (let attempt = 1; attempt <= 3 && !info.checked; attempt++) {
        try {
          const tag = await checkbox.evaluate(el => el.tagName.toLowerCase());
          const type = (
            (await checkbox.getAttribute('type')) ||
            ''
          ).toLowerCase();

          if (tag === 'input' && type === 'checkbox') {
            await checkbox.check({ force: attempt > 1 });
          } else {
            await checkbox.click({ force: attempt > 1 });
          }
        } catch {
          // If the checkbox itself is visually covered by a custom control,
          // use its associated/parent label as the fallback click target.
          const clickedLabel = await checkbox.evaluate(el => {
            let label = null;

            if (el.id) {
              label = document.querySelector(
                \`label[for="\${CSS.escape(el.id)}"]\`
              );
            }

            label = label || el.closest('label');

            if (!label) {
              return false;
            }

            label.click();
            return true;
          });

          if (!clickedLabel) {
            await checkbox.click({ force: true }).catch(() => {});
          }
        }

        await page.waitForTimeout(450);
        info = await getInfo();
      }

      if (!info.checked) {
        allLegalActive = false;
        console.log(
          'Required legal agreement is still NOT active:',
          info.text
        );
      } else {
        console.log(
          'Required legal agreement is active:',
          info.text
        );
      }
    }

    if (legalFound) {
      await input.evaluate(el => el.blur());
      await page.waitForTimeout(700);
    }

    return {
      found: legalFound,
      active: !legalFound || allLegalActive
    };
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

// Make sure legal terms are active immediately after filling the field.
const oldConsentCall =
  '      await handleRequiredAgreementCheckboxes(input);';
const verifiedConsentCall = `      const agreementState =
        await handleRequiredAgreementCheckboxes(input);

      if (!agreementState.active) {
        console.log(
          'Required terms/privacy agreement could not be activated.'
        );
        return { recognized: true, advanced: false };
      }`;

if (source.includes(oldConsentCall)) {
  source = source.replace(
    oldConsentCall,
    verifiedConsentCall
  );
} else if (!source.includes('const agreementState =')) {
  const fillMarker =
    `      await page.waitForTimeout(500);\n\n      const beforeSubmitState = await inspectPage();`;

  const fillReplacement =
    `      await page.waitForTimeout(500);\n\n      // Required legal terms/privacy must be active before submission.\n      const agreementState =\n        await handleRequiredAgreementCheckboxes(input);\n\n      if (!agreementState.active) {\n        console.log(\n          'Required terms/privacy agreement could not be activated.'\n        );\n        return { recognized: true, advanced: false };\n      }\n\n      const beforeSubmitState = await inspectPage();`;

  if (!source.includes(fillMarker)) {
    throw new Error('Could not find post-fill insertion point.');
  }

  source = source.replace(
    fillMarker,
    fillReplacement
  );
}

// Re-verify terms immediately before every submission path. This makes the
// invariant explicit: if a page contains a required legal agreement, it must
// still be active at the moment the crawler tries to continue.
if (!source.includes('// RECHECK_REQUIRED_TERMS_BEFORE_FORM_SUBMIT')) {
  const submitClickMarker =
    `          console.log(\n            \`Submitting \${fieldType} using form submit control.\`\n          );\n\n          await submit.click();`;

  const submitClickReplacement =
    `          console.log(\n            \`Submitting \${fieldType} using form submit control.\`\n          );\n\n          // RECHECK_REQUIRED_TERMS_BEFORE_FORM_SUBMIT\n          const termsBeforeSubmit =\n            await handleRequiredAgreementCheckboxes(input);\n\n          if (!termsBeforeSubmit.active) {\n            return { recognized: true, advanced: false };\n          }\n\n          await submit.click();`;

  if (source.includes(submitClickMarker)) {
    source = source.replace(
      submitClickMarker,
      submitClickReplacement
    );
  }
}

if (!source.includes('// RECHECK_REQUIRED_TERMS_BEFORE_NEARBY_ACTION')) {
  const nearbyMarker =
    `      const nearbyAction =\n        await findSafeFormActionNearInput(input);`;

  const nearbyReplacement =
    `      // RECHECK_REQUIRED_TERMS_BEFORE_NEARBY_ACTION\n      const termsBeforeNearbyAction =\n        await handleRequiredAgreementCheckboxes(input);\n\n      if (!termsBeforeNearbyAction.active) {\n        return { recognized: true, advanced: false };\n      }\n\n      const nearbyAction =\n        await findSafeFormActionNearInput(input);`;

  if (source.includes(nearbyMarker)) {
    source = source.replace(
      nearbyMarker,
      nearbyReplacement
    );
  }
}

if (!source.includes('// RECHECK_REQUIRED_TERMS_BEFORE_ENTER')) {
  const enterMarker =
    `      console.log(\`Trying Enter for \${fieldType} input.\`);\n      await input.press('Enter');`;

  const enterReplacement =
    `      // RECHECK_REQUIRED_TERMS_BEFORE_ENTER\n      const termsBeforeEnter =\n        await handleRequiredAgreementCheckboxes(input);\n\n      if (!termsBeforeEnter.active) {\n        return { recognized: true, advanced: false };\n      }\n\n      console.log(\`Trying Enter for \${fieldType} input.\`);\n      await input.press('Enter');`;

  if (source.includes(enterMarker)) {
    source = source.replace(
      enterMarker,
      enterReplacement
    );
  }
}

fs.writeFileSync(path, source);

console.log('Applied crawler form updates.');
console.log('Each run uses a fresh lowercase a-z Gmail address.');
console.log('Optional marketing/newsletter checkboxes are skipped.');
console.log('Required legal terms/privacy checkboxes are verified ACTIVE before continuing.');
