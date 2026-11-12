/**
 * Reading the MiniMax secret out of the Host credential store.
 *
 * The credential reference is the only thing that ever appears in
 * configuration. The secret itself stays in the Host and is handed to
 * `fetch` as a header, never returned to the browser and never logged.
 */

/**
 * Read the credential a MiniMax route authenticates with.
 *
 * @param ctx - Host context carrying the credential seam.
 * @param ref - credential reference to resolve.
 * @returns the secret, or undefined when the reference resolves to nothing.
 */
export async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const hit = await credentials.resolve(ref)
  const value = hit?.value
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
