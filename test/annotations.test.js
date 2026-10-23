import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAnnotations, parseTime } from '../public/annotations.js';

const near = new Date(2026, 9, 22, 18, 0).getTime();
const at = (month, day, h, m, year = 2026) => new Date(year, month, day, h, m).getTime();

test('times as written in the records read back in local time', () => {
  assert.equal(parseTime('Thu 22 Oct 18:40', near), at(9, 22, 18, 40));
  assert.equal(parseTime('Fri 23 Oct 0:05', near), at(9, 23, 0, 5));
  // Across the new year, the year nearest the review.
  assert.equal(parseTime('Thu 1 Jan 01:00', new Date(2026, 11, 31, 23).getTime()), at(0, 1, 1, 0, 2027));
  assert.equal(parseTime('18:40', near), null);
  assert.equal(parseTime(undefined, near), null);
});

test('the annotations block is taken out of the review and becomes numbered marks', () => {
  const review = '**Verdict**: Under-corrected (1).\n\n```annotations\n'
    + '[{"at": "Thu 22 Oct 18:40", "until": "Thu 22 Oct 19:30", "kind": "under", "text": "UAM late"},'
    + ' {"at": "Thu 22 Oct 20:10", "kind": "bad", "text": "Pizza"}, {"at": "soon", "kind": "ok", "text": "x"}]\n```\n';
  const { markdown, annotations } = extractAnnotations(review, near);
  assert.equal(markdown, '**Verdict**: Under-corrected (1).');
  assert.deepEqual(annotations, [
    { n: 1, from: at(9, 22, 18, 40), to: at(9, 22, 19, 30), kind: 'under', text: 'UAM late' },
    { n: 2, from: at(9, 22, 20, 10), to: at(9, 22, 20, 10), kind: 'note', text: 'Pizza' },
  ]);
});

test('a block still streaming is hidden and has no marks yet', () => {
  assert.deepEqual(extractAnnotations('Text\n\n```annotations\n[{"at": "Thu 22', near), { markdown: 'Text', annotations: [] });
  assert.deepEqual(extractAnnotations('Text without marks', near), { markdown: 'Text without marks', annotations: [] });
  assert.deepEqual(extractAnnotations('Text\n```annotations\nnot json\n```', near), { markdown: 'Text', annotations: [] });
});
