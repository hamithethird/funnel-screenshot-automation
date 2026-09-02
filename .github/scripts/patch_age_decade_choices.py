from pathlib import Path

path = Path('funnel-crawler-multiscreen.js')
source = path.read_text()

old_age_range_block = r'''    const ageRangeOptions = (state?.group || []).map(option => {
      const raw = (option.text || '').trim();
      const normalized = raw.replace(/[–—]/g, '-');
      const range = normalized.match(/(?:age\s*:\s*)?(\d{1,3})\s*-\s*(\d{1,3})/i);
      const plus = normalized.match(/(?:age\s*:\s*)?(\d{1,3})\s*\+/i);
      if (range) return { option, min: Number(range[1]), max: Number(range[2]), raw };
      if (plus) return { option, min: Number(plus[1]), max: Infinity, raw };
      return null;
    }).filter(Boolean);

    if (ageRangeOptions.length >= 2 && ageRangeOptions.length >= Math.ceil((state?.group?.length || 0) * 0.6)) {
      const targetAge = 25;
      const chosen = ageRangeOptions.find(item => targetAge >= item.min && targetAge <= item.max) || ageRangeOptions[0];
      console.log(`Age-range choice page detected from answer options. Choosing the range containing age ${targetAge}:`, chosen.raw);
'''

new_age_range_block = r'''    const ageRangeOptions = (state?.group || []).map(option => {
      const raw = (option.text || '').trim();
      const normalized = raw.replace(/[–—]/g, '-');
      const range = normalized.match(/(?:age\s*:\s*)?(\d{1,3})\s*-\s*(\d{1,3})/i);
      const plus = normalized.match(/(?:age\s*:\s*)?(\d{1,3})\s*\+/i);
      const decade = normalized.match(/(?:age\s*:\s*)?(\d{2})\s*'?s\b/i);
      const symbolicUnder = normalized.match(/^\s*<\s*(\d{1,3})\s*$/i);
      const symbolicOver = normalized.match(/^\s*>\s*(\d{1,3})\s*$/i);
      const wordUnder = normalized.match(/(?:under|below|less than)\s*(\d{1,3})/i);
      const wordOver = normalized.match(/(?:over|above|older than)\s*(\d{1,3})/i);
      if (range) return { option, min: Number(range[1]), max: Number(range[2]), raw };
      if (plus) return { option, min: Number(plus[1]), max: Infinity, raw };
      if (decade) {
        const start = Number(decade[1]);
        return { option, min: start, max: start + 9, raw };
      }
      if (symbolicUnder || wordUnder) {
        const limit = Number((symbolicUnder || wordUnder)[1]);
        return { option, min: -Infinity, max: limit - 1, raw };
      }
      if (symbolicOver || wordOver) {
        const limit = Number((symbolicOver || wordOver)[1]);
        return { option, min: limit + 1, max: Infinity, raw };
      }
      return null;
    }).filter(Boolean);

    if (ageRangeOptions.length >= 2 && ageRangeOptions.length >= Math.ceil((state?.group?.length || 0) * 0.6)) {
      const targetAge = 25;
      const ageDistance = item => {
        if (targetAge >= item.min && targetAge <= item.max) return 0;
        if (targetAge < item.min) return item.min - targetAge;
        return targetAge - item.max;
      };
      const chosen = ageRangeOptions
        .slice()
        .sort((a, b) => ageDistance(a) - ageDistance(b))[0];
      const exactBucket = ageDistance(chosen) === 0;
      console.log(
        exactBucket
          ? `Age-range choice page detected from answer options. Choosing the bucket containing age ${targetAge}:`
          : `Age-range choice page detected from answer options. No bucket contains age ${targetAge}; choosing the nearest bucket instead:`,
        chosen.raw
      );
'''

if old_age_range_block in source:
    source = source.replace(old_age_range_block, new_age_range_block, 1)
elif "const decade = normalized.match(/(?:age\\s*:\\s*)?(\\d{2})\\s*'?s\\b/i);" not in source:
    raise SystemExit('Could not find the primary age-range parsing block to patch safely.')

old_contains_block = r'''        const plus = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\s*\+/i);
        if (plus) return targetAge >= Number(plus[1]);
        const under = t.match(/(?:under|below|less than)\s*(\d{1,3})/i);
        if (under) return targetAge < Number(under[1]);
        const over = t.match(/(?:over|above|older than)\s*(\d{1,3})/i);
        if (over) return targetAge > Number(over[1]);
        const exact = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\b/i);
        return !!exact && Number(exact[1]) === targetAge;
      };
      const looksLikeAgeChoice = text => /(?:age\s*[:\-]?\s*)?\d{1,3}\s*(?:[-–—]\s*\d{1,3}|\+)?|(?:under|below|over|above|older than|less than)\s*\d{1,3}/i.test(normalize(text));
'''

new_contains_block = r'''        const plus = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\s*\+/i);
        if (plus) return targetAge >= Number(plus[1]);
        const decade = t.match(/(?:age\s*[:\-]?\s*)?(\d{2})\s*'?s\b/i);
        if (decade) {
          const start = Number(decade[1]);
          return targetAge >= start && targetAge <= start + 9;
        }
        const symbolicUnder = t.match(/^\s*<\s*(\d{1,3})\s*$/i);
        if (symbolicUnder) return targetAge < Number(symbolicUnder[1]);
        const symbolicOver = t.match(/^\s*>\s*(\d{1,3})\s*$/i);
        if (symbolicOver) return targetAge > Number(symbolicOver[1]);
        const under = t.match(/(?:under|below|less than)\s*(\d{1,3})/i);
        if (under) return targetAge < Number(under[1]);
        const over = t.match(/(?:over|above|older than)\s*(\d{1,3})/i);
        if (over) return targetAge > Number(over[1]);
        const exact = t.match(/(?:age\s*[:\-]?\s*)?(\d{1,3})\b/i);
        return !!exact && Number(exact[1]) === targetAge;
      };
      const looksLikeAgeChoice = text => /(?:age\s*[:\-]?\s*)?\d{1,3}\s*(?:[-–—]\s*\d{1,3}|\+|'?s\b)?|^[<>]\s*\d{1,3}$|(?:under|below|over|above|older than|less than)\s*\d{1,3}/i.test(normalize(text));
'''

if old_contains_block in source:
    source = source.replace(old_contains_block, new_contains_block, 1)
elif "const symbolicUnder = t.match(/^\\s*<\\s*(\\d{1,3})\\s*$/i);" not in source:
    raise SystemExit('Could not find the DOM age-choice parsing block to patch safely.')

path.write_text(source)
print('Applied decade/symbolic age-choice patch.')
