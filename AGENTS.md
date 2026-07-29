# Development workflow

Before telling the user to restart OpenCode for local testing:

1. Run `bun run opencode:local`.
2. Verify `~/.config/opencode/opencode.json` points to the repository's `src/index.ts` with a fresh `?v=` token.
3. Tell the user to restart OpenCode and open a fresh chat because tool schemas are initialized per chat.

After publishing a release:

1. Run `bun run opencode:install`.
2. Verify the config contains the exact published npm version, not `@latest` or the local path.
3. Tell the user to restart OpenCode and open a fresh chat.
