'use strict';

function validateHint(hint) {
  if (!hint || typeof hint.anchor !== 'string' || !['same_line', 'next_line'].includes(hint.placement)) throw new Error('Choose a source label beside or above the value.');
  const anchor = hint.anchor.trim().replace(/[ \t]+/g, ' ');
  if (!anchor || anchor.length > 100 || /[\r\n\0]/.test(anchor)) throw new Error('Source labels must be one line of at most 100 characters.');
  return { anchor, placement: hint.placement };
}

function labelMatches(pages, hint) {
  const rule = validateHint(hint);
  // Only literal labels are learned. Document examples never become executable expressions.
  const literal = rule.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ \\t]+');
  const boundary = /[\p{L}\p{N}_]$/u.test(rule.anchor) ? '(?=$|[ \\t:=])' : '';
  const pattern = new RegExp(`(?:^|[ \\t]{2,})${literal}${boundary}[ \\t]*(?::|=)?[ \\t]*`, 'giu');
  const matches = [];
  for (const page of pages) {
    const lines = (page.text || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(lines[index]))) {
        const after = lines[index].slice(match.index + match[0].length);
        let value = '';
        if (rule.placement === 'same_line') value = after.split(/\t+| {2,}/)[0].trim();
        else if (!after.trim()) {
          for (let next = index + 1; next < Math.min(index + 5, lines.length); next++) {
            if (!lines[next].trim()) continue;
            const candidate = lines[next].trim();
            if (!/^[\p{L}][^:]{0,100}:/u.test(candidate)) value = candidate.split(/\t+| {2,}/)[0].trim();
            break;
          }
        }
        if (value && value.length <= 10000) matches.push({ value, page: page.number ?? page.pageNum ?? 1 });
      }
    }
  }
  return matches;
}

const comparable = value => value.trim().replace(/\s+/g, ' ');

function inferAnchor(pages, example) {
  if (!example.trim() || /[\r\n]/.test(example.trim())) return '';
  const candidates = new Set();
  for (const page of pages) {
    const lines = (page.text || '').split(/\r?\n/);
    lines.forEach((line, index) => {
      const position = line.indexOf(example.trim());
      if (position < 0) return;
      const prefix = line.slice(0, position);
      const label = /(?:^|\t+| {2,})([\p{L}][\p{L}\p{N} /_.#()%–-]{0,98})[ \t]*(?::|=|#)[ \t]*$/u.exec(prefix);
      if (label) candidates.add(prefix.trim().endsWith('#') ? `${label[1].trim()} #` : label[1].trim());
      else if (!prefix.trim()) {
        for (let prior = index - 1; prior >= Math.max(0, index - 4); prior--) {
          if (!lines[prior].trim()) continue;
          const above = lines[prior].trim().replace(/[:=]$/, '').trim();
          if (/^[\p{L}][\p{L}\p{N} /_.#()%–-]{0,98}$/u.test(above)) candidates.add(above);
          break;
        }
      }
    });
  }
  return candidates.size === 1 ? [...candidates][0] : '';
}

function previewTeaching(pages, example, anchor = '') {
  if (typeof example !== 'string' || example.length > 10000 || !example.trim()) throw new Error('Enter an example of at most 10,000 characters to check a reusable source label.');
  if (typeof anchor !== 'string') throw new Error('Enter a source label.');
  anchor = anchor.trim() || inferAnchor(pages, example);
  if (!anchor) return { usable: false, anchor: '', count: 0, message: 'Enter the source label immediately beside or above the example, then check again. Unlabeled values can be saved for this document.' };
  const candidates = ['same_line', 'next_line'].map(placement => {
    const hint = validateHint({ anchor, placement });
    return { hint, matches: labelMatches(pages, hint) };
  });
  const matching = candidates.filter(candidate => candidate.matches.length === 1 && comparable(candidate.matches[0].value) === comparable(example));
  // If the same label appears in both arrangements, its meaning is ambiguous.
  const total = candidates.reduce((count, candidate) => count + candidate.matches.length, 0);
  if (matching.length === 1 && total === 1) return { usable: true, anchor, hint: matching[0].hint, count: 1, match: matching[0].matches[0], message: 'One source match agrees with your example. This label can be reused on later documents.' };
  return { usable: false, anchor, count: total, message: total > 1 ? 'This label has multiple matches. Use a more specific source label or save this document only.' : total ? 'The source value differs from your example. Check the label or save this document only.' : 'No value was found beside or below that label. Check the label or save this document only.' };
}

function applyHints(pages, fields) {
  const values = {}; const results = [];
  for (const field of fields.filter(field => field.hint)) {
    const matches = labelMatches(pages, field.hint);
    // Count both arrangements to avoid silently taking a different instance of the label.
    const other = labelMatches(pages, { ...field.hint, placement: field.hint.placement === 'same_line' ? 'next_line' : 'same_line' });
    const count = matches.length + other.length;
    const matched = matches.length === 1 && count === 1;
    values[field.name] = matched ? matches[0].value : '';
    results.push({ field: field.name, label: field.label, status: matched ? 'matched' : count > 1 ? 'ambiguous' : 'not_found', count, anchor: field.hint.anchor });
  }
  return { values, results };
}

module.exports = { validateHint, labelMatches, previewTeaching, applyHints };
