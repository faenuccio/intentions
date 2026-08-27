import { getIssueItem, setStatus, clearExpiry, clearNote } from '../github/projects.js'
import { getAssignees, unassign, comment } from '../github/issues.js'
import { type Deps, requireOption } from './deps.js'

/**
 * Handle `disclaim`: release a claim you hold. Removes only the actor (claimant-only).
 *
 * On a co-held registration (several assignees), a disclaim is one participant stepping back:
 * the task stays registered to the others with its expiry and note intact. Only the last holder
 * leaving releases the task back to Unclaimed and clears the board fields.
 */
export async function handleDisclaim(deps: Deps): Promise<void> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps

  const item = await getIssueItem(octokit, owner, repo, issueNumber, ctx)
  if (!item) return // not on the board; nothing to do

  const assignees = await getAssignees(repoOctokit, owner, repo, issueNumber)
  if (!assignees.includes(actor)) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} you're not the current claimant of this task, so there's nothing to disclaim.`)
    return
  }

  const remaining = assignees.filter((a) => a !== actor)
  if (remaining.length > 0) {
    await unassign(repoOctokit, owner, repo, issueNumber, actor)
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} you've stepped back from this task — it stays registered to ${remaining.map((a) => `@${a}`).join(', ')}.`)
    return
  }

  const unclaimedId = requireOption(ctx, cfg.statusUnclaimed)
  await setStatus(octokit, ctx, item.itemId, unclaimedId)
  await clearExpiry(octokit, ctx, item.itemId)
  await clearNote(octokit, ctx, item.itemId)
  await unassign(repoOctokit, owner, repo, issueNumber, actor)
  await comment(repoOctokit, owner, repo, issueNumber,
    `@${actor} you've released this task — it's available again.`)
}
