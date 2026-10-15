'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateHint, labelMatches, previewTeaching } = require('../src/core/teaching.cjs');
const { analyzeDocument } = require('../src/core/analysis.cjs');
const { validateFields } = require('../src/core/extraction.cjs');

test('teaching infers literal labels beside and above selected examples', () => {
  const beside = previewTeaching([{ number: 2, text: 'Vendor: Example\nInternal ref #: REF-001' }], 'REF-001');
  assert.equal(beside.usable, true); assert.equal(beside.hint.anchor, 'Internal ref #');
  assert.equal(beside.hint.placement, 'same_line'); assert.equal(beside.match.page, 2);
  const below = previewTeaching([{ text: 'Delivery reference:\n\nABC-42\nTotal: $10.00' }], 'ABC-42');
  assert.equal(below.usable, true); assert.equal(below.hint.anchor, 'Delivery reference'); assert.equal(below.hint.placement, 'next_line');
  assert.equal(previewTeaching([{ text: 'Unlabeled example' }], 'example').usable, false);
});

test('saved labels are literal, bounded, and do not match parts of other labels', () => {
  const hint = { anchor: 'Ref. (PO) #', placement: 'same_line' };
  assert.deepEqual(labelMatches([{ text: 'RefX (PO) # WRONG\nRef. (PO) # REAL-1' }], hint).map(item => item.value), ['REAL-1']);
  assert.deepEqual(labelMatches([{ text: 'POLICY: WRONG\nPO: RIGHT' }], { anchor: 'PO', placement: 'same_line' }).map(item => item.value), ['RIGHT']);
  assert.deepEqual(labelMatches([{ text: 'Reference:\nTotal: $5' }], { anchor: 'Reference', placement: 'next_line' }), []);
  assert.throws(() => validateHint({ anchor: 'bad\nlabel', placement: 'same_line' }));
  assert.throws(() => validateHint({ anchor: 'x'.repeat(101), placement: 'same_line' }));
  assert.throws(() => validateHint({ anchor: 'Label', placement: 'anywhere' }));
  assert.throws(() => previewTeaching([], ''));
});

test('preview refuses multiple matches, a mismatched example, and mixed label arrangements', () => {
  for (const text of ['PO: A1\nPO: A2', 'PO: A1    PO: A2', 'PO: A1\nPO:\nA2']) {
    const preview = previewTeaching([{ text }], 'A1', 'PO'); assert.equal(preview.usable, false); assert.equal(preview.count, 2);
  }
  const mismatch = previewTeaching([{ text: 'PO: REAL' }], 'WRONG', 'PO'); assert.equal(mismatch.usable, false); assert.equal(mismatch.count, 1);
});

test('taught rules extract new values in both profiles and flag missing or ambiguous matches', () => {
  const fields = validateFields([{ name: 'purchase_order', label: 'Purchase order', pattern: '', required: false, hint: { anchor: 'Reference', placement: 'same_line' } }]);
  for (const mode of ['standard', 'high']) {
    const result = analyzeDocument([{ text: 'Reference: NEW-987' }], fields, mode);
    assert.equal(result.values.purchase_order, 'NEW-987'); assert.equal(result.analysis.taughtFields[0].status, 'matched');
    const missing = analyzeDocument([{ text: 'No reference here' }], fields, mode);
    assert.equal(missing.values.purchase_order, ''); assert.equal(missing.analysis.taughtFields[0].status, 'not_found');
    const ambiguous = analyzeDocument([{ text: 'Reference: A\nReference: B' }], fields, mode);
    assert.equal(ambiguous.values.purchase_order, ''); assert.equal(ambiguous.analysis.taughtFields[0].status, 'ambiguous'); assert.match(ambiguous.analysis.warnings[0], /multiple matches/);
  }
});
