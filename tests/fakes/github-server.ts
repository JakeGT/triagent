// The fake GitHub (tests/fakes/github.ts) as a process of its own, for the end-to-end tests: it listens on
// FAKE_GITHUB_PORT and is seeded over /_fake/*.

import { FakeGitHub } from "./github.ts";

const fake = await new FakeGitHub({ admin: true }).start(Number(process.env.FAKE_GITHUB_PORT ?? 0));
console.log(`Fake GitHub at ${fake.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void fake.stop().finally(() => process.exit(0)));
