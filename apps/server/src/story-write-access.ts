/**
 * Who may change stories through MCP (mcp-route.ts enforces it on every tools/call before any story code runs).
 *  - External token clients have no user, so they never write stories.
 *  - Guests (no account) keep their device-scoped stories; in production guests can't start stories.
 *  - Any signed-in account may start and continue its own stories. The owner comes from the verified session, so a
 *    listener only reaches their own stories. Publishing is still admin-only (story approval), and submitting for review
 *    still needs a creator role (user-stories-route.ts).
 */
export async function authorizeStoryWrite(
  user: { sub: string } | undefined,
  _tool: string,
  external: boolean,
  production: boolean,
): Promise<boolean> {
  if (external) return false;
  if (!user) return !production;
  return true;
}
