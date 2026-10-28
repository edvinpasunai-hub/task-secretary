// Creates a Task Secretary account. Public registration is disabled in
// version 1.0, so this command is the only way to add a user.
//
// Usage:  npm run user:create
//
// The password is typed without being shown and is never printed or logged.
// Better Auth hashes it exactly like its own sign-up would.

import { createInterface } from "node:readline/promises";

import { auth, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../src/lib/auth";
import { prisma } from "../src/lib/db";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class CancelledError extends Error {}

// Reads one line from the terminal while hiding what is typed.
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";

    const finish = (callback: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      callback();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === "\u0003") return finish(() => reject(new CancelledError())); // Ctrl+C
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1); // Backspace
        else value += char;
      }
    };

    process.stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function askVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// When input is piped instead of typed (used by automated tests), answers are
// read line by line in the same order as the questions.
async function readPipedAnswers(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

async function main() {
  const interactive = Boolean(process.stdin.isTTY);
  const piped = interactive ? [] : await readPipedAnswers();
  const ask = async (question: string, hidden = false) => {
    if (!interactive) return (piped.shift() ?? "").trim();
    return hidden ? askHidden(question) : askVisible(question);
  };

  console.log("Create a Task Secretary account\n");

  const name = await ask("Display name: ");
  if (!name) throw new Error("A display name is required.");

  const email = (await ask("Email: ")).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error("Please enter a valid email address.");

  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new Error("An account with this email already exists. No changes were made.");
  }

  const password = await ask(`Password (${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters, hidden): `, true);
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`The password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters long.`);
  }
  if ((await ask("Repeat password: ", true)) !== password) {
    throw new Error("The passwords do not match. No changes were made.");
  }

  // Same steps as Better Auth's own sign-up: hash, create the user, store the hash.
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  const user = await ctx.internalAdapter.createUser(
    { name, email, emailVerified: false },
    { method: "email-password" },
  );
  try {
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: hash,
    });
  } catch (error) {
    // Never leave behind a user who cannot log in.
    await prisma.user.delete({ where: { id: user.id } });
    throw error;
  }

  console.log(`\nAccount created for ${email}. You can now log in.`);
}

main()
  .catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof CancelledError) console.error("\nCancelled. No changes were made.");
    else console.error(`\nError: ${error instanceof Error ? error.message : "Could not create the account."}`);
  })
  .finally(() => prisma.$disconnect());
