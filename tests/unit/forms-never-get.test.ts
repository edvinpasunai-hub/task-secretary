// A <form> without a method is submitted with GET when the browser submits it natively (before the
// scripts have loaded, or with scripts off): every field would end up in the URL. Every <form> in the app must
// therefore say method="post" or be a Server Action form (action={...}, which React renders as POST).
// This guards against a new form forgetting it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : files(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

// The opening tag of every real <form ...> element: from "<form" to the ">" that is not inside { } braces.
function formTags(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/^\s*\/\/.*$/gm, (m) => " ".repeat(m.length));
  const tags: string[] = [];
  const open = /<form(?=[\s>])/g;
  for (let match = open.exec(code); match; match = open.exec(code)) {
    let depth = 0;
    let end = match.index;
    for (; end < code.length; end++) {
      const char = code[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    tags.push(code.slice(match.index, end + 1));
  }
  return tags;
}

describe("every form in the app", () => {
  const all = files(SRC).flatMap((file) => formTags(readFileSync(file, "utf8")).map((tag) => ({ file: file.replace(SRC, "src"), tag })));

  it("finds the app's forms (so this guard cannot silently pass on nothing)", () => {
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.some((f) => f.file.includes("login-form"))).toBe(true);
    expect(all.some((f) => f.file.includes("task-form"))).toBe(true);
  });

  it("is POST or a Server Action form, never the default GET", () => {
    for (const { file, tag } of all) {
      const post = /method\s*=\s*["']post["']/i.test(tag);
      const serverAction = /\saction\s*=\s*\{/.test(tag);
      expect(post || serverAction, `${file}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`).toBe(true);
      expect(/method\s*=\s*["']get["']/i.test(tag), file).toBe(false);
    }
  });
});
