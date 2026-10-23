import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

test('markdown renders headings from h4, paragraphs and inline markup', () => {
  assert.equal(renderMarkdown('## Verdict\n**Under-corrected**: ISF *too weak*, see `smbmaxminutes`.'),
    '<h5>Verdict</h5>\n<p><strong>Under-corrected</strong>: ISF <em>too weak</em>, see <code>smbmaxminutes</code>.</p>');
});

test('markdown escapes html so a review cannot inject markup', () => {
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)> & `<b>`'),
    '<p>&lt;img src=x onerror=alert(1)&gt; &amp; <code>&lt;b&gt;</code></p>');
});

test('markdown renders bullet and numbered lists with continued items', () => {
  assert.equal(renderMarkdown('- 14:05 BG 180\n  rising\n- 14:10 SMB 0.4 U\n\n1. one\n2. two'),
    '<ul><li>14:05 BG 180 rising</li><li>14:10 SMB 0.4 U</li></ul>\n<ol><li>one</li><li>two</li></ol>');
});

test('markdown renders tables', () => {
  assert.equal(renderMarkdown('| Time | BG |\n|---|--:|\n| 14:05 | 180 |'),
    '<table><thead><tr><th>Time</th><th>BG</th></tr></thead><tbody><tr><td>14:05</td><td>180</td></tr></tbody></table>');
});

test('markdown keeps only http links and leaves underscores in words alone', () => {
  assert.equal(renderMarkdown('[guide](https://example.com/a) [x](javascript:alert(1)) max_iob'),
    '<p><a href="https://example.com/a" target="_blank" rel="noopener">guide</a> [x](javascript:alert(1)) max_iob</p>');
});

test('markdown renders a half-streamed text as far as it goes', () => {
  assert.equal(renderMarkdown('**Verdict**: Mi'), '<p><strong>Verdict</strong>: Mi</p>');
  assert.equal(renderMarkdown('```\ncode'), '<pre><code>code</code></pre>');
});
