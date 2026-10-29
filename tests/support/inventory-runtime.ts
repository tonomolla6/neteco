// Isolated workerd entrypoint: expose only the production Durable Object class.
// The source module also exports constants/helpers, which are not Worker exports.
import canary from '../../workers/canary'
export { InventoryCoordinator } from '../../workers/inventory-coordinator'

export default {
  async queue(batch: MessageBatch, env: CloudflareEnv) {
    await canary.queue(batch, env)
    // Test-only completion marker: the audit waits for all duplicate handlers,
    // not just the first row appearing in the inbox.
    await env.DB.prepare('UPDATE audit_queue_completion SET handled = handled + ?1').bind(batch.messages.length).run()
  }
}
