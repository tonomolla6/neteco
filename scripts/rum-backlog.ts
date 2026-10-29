import { readFile } from 'node:fs/promises'
import { buildRumBacklog, rumBacklogMarkdown } from '../shared/rum-backlog'

// Usage: tsx scripts/rum-backlog.ts <samples.json>  ({vitals:[], queues:[], lab?:[]})
const path = process.argv[2]
if (!path) {
  process.stderr.write('Usage: tsx scripts/rum-backlog.ts <samples.json>\n')
  process.exitCode = 2
} else {
  const input = JSON.parse(await readFile(path, 'utf8')) as Parameters<typeof buildRumBacklog>[0]
  process.stdout.write(rumBacklogMarkdown(buildRumBacklog(input)))
}
