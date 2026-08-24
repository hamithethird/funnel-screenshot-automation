const fs = require('fs');

const path = 'funnel-crawler-multiscreen.js';
let source = fs.readFileSync(path, 'utf8');

if (source.includes('// EMAIL_FORM_DEBUG_DIAGNOSTICS')) {
  console.log('Email diagnostics are already applied.');
  process.exit(0);
}

const marker = `      console.log(\`Detected \${fieldType} input.\`);\n\n      await input.fill(value);`;

const replacement = `      console.log(\`Detected \${fieldType} input.\`);\n\n      await input.fill(value);\n\n      // EMAIL_FORM_DEBUG_DIAGNOSTICS\n      if (fieldType === 'email') {\n        const actualEmailState = await input.evaluate(el => ({\n          value: el.value,\n          type: el.getAttribute('type') || '',\n          valid: el.validity ? el.validity.valid : null,\n          typeMismatch: el.validity ? el.validity.typeMismatch : null,\n          valueMissing: el.validity ? el.validity.valueMissing : null,\n          patternMismatch: el.validity ? el.validity.patternMismatch : null,\n          validationMessage: el.validationMessage || ''\n        }));\n\n        console.log('EMAIL DEBUG - intended value:', value);\n        console.log('EMAIL DEBUG - actual field value:', actualEmailState.value);\n        console.log('EMAIL DEBUG - browser validity:', {\n          valid: actualEmailState.valid,\n          typeMismatch: actualEmailState.typeMismatch,\n          valueMissing: actualEmailState.valueMissing,\n          patternMismatch: actualEmailState.patternMismatch,\n          validationMessage: actualEmailState.validationMessage\n        });\n      }`;

if (!source.includes(marker)) {
  throw new Error('Could not find email fill location in crawler.');
}

source = source.replace(marker, replacement);

const agreementMarker = `      if (!agreementState.active) {\n        console.log(\n          'Required terms/privacy agreement could not be activated.'\n        );\n        return { recognized: true, advanced: false };\n      }`;

const agreementReplacement = `      if (!agreementState.active) {\n        console.log(\n          'Required terms/privacy agreement could not be activated.'\n        );\n        return { recognized: true, advanced: false };\n      }\n\n      if (fieldType === 'email') {\n        const emailDiagnostics = await input.evaluate(el => ({\n          value: el.value,\n          valid: el.validity ? el.validity.valid : null,\n          validationMessage: el.validationMessage || ''\n        }));\n\n        const visibleActions = await page.evaluate(() => {\n          const selectors = [\n            'button',\n            '[role=\"button\"]',\n            'input[type=\"submit\"]',\n            'input[type=\"button\"]'\n          ];\n\n          return Array.from(document.querySelectorAll(selectors.join(',')))\n            .map(el => {\n              const rect = el.getBoundingClientRect();\n              const style = getComputedStyle(el);\n              const visible =\n                rect.width > 0 &&\n                rect.height > 0 &&\n                style.display !== 'none' &&\n                style.visibility !== 'hidden' &&\n                Number(style.opacity) > 0;\n\n              if (!visible) return null;\n\n              return {\n                text: (\n                  el.innerText ||\n                  el.value ||\n                  el.getAttribute('aria-label') ||\n                  ''\n                ).trim().replace(/\\s+/g, ' ').slice(0, 120),\n                tag: el.tagName.toLowerCase(),\n                type: el.getAttribute('type') || '',\n                disabled:\n                  el.disabled === true ||\n                  el.getAttribute('aria-disabled') === 'true',\n                width: Math.round(rect.width),\n                height: Math.round(rect.height)\n              };\n            })\n            .filter(Boolean);\n        });\n\n        console.log('EMAIL DEBUG - final field value before submit:', emailDiagnostics.value);\n        console.log('EMAIL DEBUG - valid before submit:', emailDiagnostics.valid);\n        console.log('EMAIL DEBUG - validation message:', emailDiagnostics.validationMessage || '(none)');\n        console.log('EMAIL DEBUG - visible button-like controls:', visibleActions);\n\n        await page.screenshot({\n          path: 'email-debug.png',\n          fullPage: true\n        });\n        console.log('EMAIL DEBUG - saved email-debug.png');\n      }`;

if (source.includes(agreementMarker)) {
  source = source.replace(agreementMarker, agreementReplacement);
} else {
  console.log('Warning: verified agreement block not found; basic email logging was still added.');
}

fs.writeFileSync(path, source);
console.log('Applied email diagnostics to funnel-crawler-multiscreen.js');
