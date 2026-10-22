# Publishing FireTales (open-source mini challenge)

FireTales stays inside Haunt at `packages/firetales`. To publish it as its own repository, export a clean copy:

```bash
node scripts/export-firetales.mjs
```

This writes `build/firetales/` (git-ignored) with:
- `src/`, `test/`, `examples/`, `README.md` and `LICENSE` (Apache-2.0)
- a standalone `package.json` (no workspace links; adds `tsx`, `typescript` and `@types/node` for tests)
- a `tsconfig.json` with Haunt's shared base settings inlined
- `.gitignore` and `.env.example`

It contains no secrets, Haunt configuration or generated files.

**Checked on Oct 17:** a copy outside the Haunt folder installs from npm, passes 26 tests and the typecheck, and runs the offline CLI example (`npm run example:cli`).

## Dependency licenses

| Package | License | Used for |
| --- | --- | --- |
| zod | MIT | Scene schema and validation |
| @anthropic-ai/sdk | MIT | Claude provider |
| @aws-sdk/client-bedrock-runtime | Apache-2.0 | Converse provider |
| @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb | Apache-2.0 | DynamoDB store |
| @anthropic-ai/bedrock-sdk (dev only) | MIT | Example provider |

All are compatible with Apache-2.0. The engine contains no third-party assets.

## Steps for you (not done: these publish code)

1. Create an empty public GitHub repository named `firetales`. Don't add a README; the export has one.
2. In `build/firetales/package.json`, replace `OWNER` in `repository.url` with your GitHub username.
3. Publish it:
   ```bash
   cd build/firetales && git init && git add . && git commit -m "FireTales: open-source engine for interactive voice stories" && git branch -M main && git remote add origin https://github.com/<you>/firetales.git && git push -u origin main
   ```
4. On GitHub, check that **Apache-2.0** shows in the About sidebar. The hackathon requires a visible license.
5. Optional: add the topics `interactive-fiction`, `amazon-bedrock`, `alexa` and `mcp`.

## For the Devpost "Open Source" fields

- **Contribution URL:** `https://github.com/<you>/firetales`
- **What you did:** a new open-source engine for voice-first interactive stories. It keeps the story consistent (world, characters, facts, choices, dramatic arc), validates every model reply against a schema, and pre-writes the next scene for each suggested answer, so matching answers continue instantly. It exports finished stories as narrator-only episodes and has pluggable providers (Claude API, Bedrock Anthropic endpoint, Bedrock Converse API, offline mock), storage (memory, files, DynamoDB) and scene artwork.
- **Why it matters:** anyone building a voice or TV storytelling app gets state, continuity and fast branching without writing an LLM pipeline from scratch. The same engine runs Haunt's horror stories and a bedtime-story example.
