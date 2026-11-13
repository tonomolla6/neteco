import { execFileSync } from 'node:child_process'

/** Fail closed outside a real checkout. No environment override or dirty-tree claim. */
export function readBuildCommit(projectRoot: string): string {
  const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('build_commit_invalid')
  return commit
}

export function buildCommitDefinitions(commit: string = 'dev') {
  if (commit !== 'dev' && !/^[0-9a-f]{40}$/.test(commit)) throw new Error('build_commit_invalid')
  return { __NETECO_BUILD_COMMIT__: JSON.stringify(commit) }
}
