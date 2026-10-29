/** Wrangler resolves this alias to the isolated, generated Nitro output.
 * No generated bundle is committed or imported by unit tests. */
declare module '#neteco/nitro-renderer' {
  const renderer: {
    fetch(request: Request, env: CloudflareEnv, context: ExecutionContext): Promise<Response>
  }
  export default renderer
}
