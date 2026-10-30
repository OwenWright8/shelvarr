# Contributing

Bug reports, ideas and pull requests are welcome.

**Reporting a bug:** [open an issue](https://github.com/OwenWright8/shelvarr/issues/new/choose) with your Shelvarr and Audiobookshelf versions, what you expected, and what happened. A file name that got sorted wrong is especially useful: every naming rule comes from a real one. Remove API keys before pasting logs.

**Making a change:**

```sh
npm ci
npx playwright install chromium   # once, for the UI smoke test
npm run dev:mock                  # fake Audiobookshelf and a messy demo library
npm run dev                       # API on :8687, UI on http://localhost:5173
```

Before opening a pull request:

```sh
npm run typecheck
npm test
npm run build && npm run screenshots
```

A few house rules:

- **Protect people's files.** Every disk change goes through `server/files.ts`: never overwrite, verify before removing, record it for undo. A change that risks audio needs a test proving it doesn't.
- **New naming rules come with the real name** that needed them, in `test/naming.test.ts`.
- **If the fake and real Audiobookshelf disagree, the fake is wrong.** Fix `scripts/mock-abs.ts` too.
- **Migrations are append-only.** Never edit one that has shipped.
- **Write UI text for the person using it.** Plain words, and say what will happen.

Label your pull request `feature`, `fix`, `self-hosting` or `breaking`. By contributing, you agree it's released under the [MIT License](LICENSE).
