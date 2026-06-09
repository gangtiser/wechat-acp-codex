import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdown, maybeStrip } from "../src/text/strip-markdown.js";

test("strips bold, italic, inline code, headings, bullets", () => {
  assert.equal(stripMarkdown("**bold**"), "bold");
  assert.equal(stripMarkdown("*it*"), "it");
  assert.equal(stripMarkdown("`code`"), "code");
  assert.equal(stripMarkdown("# Title"), "Title");
  assert.equal(stripMarkdown("- item"), "• item");
});

test("unwraps fenced code blocks keeping content", () => {
  assert.equal(stripMarkdown("```js\nconst x = 1;\n```"), "const x = 1;");
});

test("plain text is unchanged", () => {
  assert.equal(stripMarkdown("hello world"), "hello world");
});

test("maybeStrip respects the enabled flag", () => {
  assert.equal(maybeStrip("**x**", true), "x");
  assert.equal(maybeStrip("**x**", false), "**x**");
});
