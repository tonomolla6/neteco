// Playwright's CLI observes close but does not consume a pipe on its own.
// Reading EOF lets its existing graceful close handler release the server.
process.stdin.resume()
process.stdin.once('end', () => {
  process.stdin.destroy()
  // EOF can arrive before the CLI registers its listener during startup.
  setTimeout(() => process.exit(0), 5000).unref()
})
