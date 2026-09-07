const root = new URL('.', import.meta.url).pathname
const server = Bun.serve({
  port: 8731,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const file = Bun.file(`${root}${path === '/' ? '/smoke.html' : path}`)
    return (await file.exists())
      ? new Response(file)
      : new Response('not found', { status: 404 })
  },
})
console.log(`e2 browser smoke test: http://localhost:${server.port}/`)
