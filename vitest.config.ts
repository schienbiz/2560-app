import { defineConfig, configDefaults } from "vitest/config"

export default defineConfig({
  test: {
    // Claude Code worktrees live in .claude/worktrees/<name>/ — full copies of
    // the repo, tests included. Without this, `npm test` in the main checkout
    // also ran every worktree's (possibly stale) tests: measured 2026-10-14 as
    // 1173 tests = 391 × 3 with two worktrees present.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
})
