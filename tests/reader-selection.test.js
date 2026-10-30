import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../assets/style.css', import.meta.url), 'utf8');

test('reader control clusters suppress native selection without suppressing readable content', () => {
  const rule = css.match(/\.reader button, \.reader-toolbar, \.reader-footer, \.reader \.slideshow-tools\s*\{([^}]+)\}/);
  assert.ok(rule, 'buttons, zoom counters, pager and fullscreen tools share the rule');
  assert.match(rule[1], /-webkit-user-select:\s*none/);
  assert.match(rule[1], /(?:^|;)\s*user-select:\s*none/);
  assert.match(css, /\.reader \.page-control input\s*\{[^}]*-webkit-user-select:\s*text;[^}]*user-select:\s*text;/);
  assert.match(css, /\.reader-note-text\s*\{[^}]*user-select:\s*text/);
  assert.doesNotMatch(css, /(?:^|\})\s*(?:body|\.reader|\.reader-header|\.reader-heading|\.reader-stage)\s*\{[^}]*user-select:\s*none/);
});
