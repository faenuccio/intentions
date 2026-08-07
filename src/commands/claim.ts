import { expiryEnabled } from '../config.js'
import { resolveExpiry, toStorage, formatExpiry } from '../ttl.js'
import { getIssueItem, setStatus, setExpiry } from '../github/projects.js'
import { getAssignees, getIssueBody, assign, comment } from '../github/issues.js'
import { type Deps, optionId, requireOption, isTerminal } from './deps.js'
import { writeNote } from './note.js'
import { readFormField, parseParticipants } from '../issueForm.js'

/**
 * Handle `claim [expiry]` plus an optional freeform note (the lines following the command).
 *
 * Resolution order (Codex hardening): load item + assignees + status FIRST, then branch.
 * If the actor already holds the claim, treat this as a renew/extend; otherwise require an
 * Unclaimed item with no assignees — except that a co-participant listed in the issue form may
 * join a held task (see tryJoinAsParticipant). Writes are ordered to fail closed: status +
 * expiry are set before assignment, so the sweep never sees a Claimed item with a missing expiry.
 */
export async function handleClaim(deps: Deps, expiryArg: string, note: string): Promise<void> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps
  const now = new Date()

  const item = await getIssueItem(octokit, owner, repo, issueNumber, ctx)
  if (!item) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this issue isn't on the **${cfg.projectTitle}** board yet, so it can't be claimed. A maintainer needs to add it first.`)
    return
  }

  const assignees = await getAssignees(repoOctokit, owner, repo, issueNumber)
  const statusName = item.statusOptionId ? ctx.statusNameById.get(item.statusOptionId) ?? null : null
  const claimedId = requireOption(ctx, cfg.statusClaimed)
  const unclaimedId = requireOption(ctx, cfg.statusUnclaimed)
  const inProgressId = optionId(ctx, cfg.statusInProgress)
  const actorHolds =
    assignees.includes(actor) &&
    (item.statusOptionId === claimedId || (inProgressId !== null && item.statusOptionId === inProgressId))

  // ---- Renew / extend path -------------------------------------------------
  if (actorHolds) {
    if (!expiryEnabled(cfg)) {
      // No TTL to extend, but the holder can still attach/update a note.
      const updatedNote = Boolean(note.trim()) && Boolean(ctx.noteFieldId)
      await writeNote(deps, item.itemId, note)
      await comment(repoOctokit, owner, repo, issueNumber, updatedNote
        ? `@${actor} note updated.`
        : `@${actor} you already hold this claim. Expiry is disabled for this project, so there's nothing to renew.`)
      return
    }
    const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
    if (!res.ok) {
      await comment(repoOctokit, owner, repo, issueNumber, `@${actor} ${res.reason}`)
      return
    }
    await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
    await writeNote(deps, item.itemId, note)
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} claim renewed — now expires **${formatExpiry(res.expiry)}**.`)
    return
  }

  // ---- Fresh claim path: enforce guardrails --------------------------------
  if (isTerminal(cfg, statusName)) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this task is **${statusName}**, so there's nothing to claim.`)
    return
  }
  if (item.statusOptionId !== unclaimedId || assignees.length > 0) {
    // A held task refuses new claimants — unless the actor is on the registration's invitation
    // list, in which case `claim` means "join" rather than "take over".
    if (await tryJoinAsParticipant(deps, item, assignees, expiryArg, note)) return
    const who = assignees.length ? assignees.map((a) => `@${a}`).join(', ') : 'someone'
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this task isn't available — it's currently **${statusName ?? 'not Unclaimed'}** (held by ${who}). It will free up if the claim is disclaimed or expires.`)
    return
  }

  // Expiry disabled for the project: behave like the classic TTL-less bot.
  if (!expiryEnabled(cfg)) {
    await setStatus(octokit, ctx, item.itemId, claimedId)
    await assign(repoOctokit, owner, repo, issueNumber, actor)
    await writeNote(deps, item.itemId, note, true)
    const suffix = expiryArg.trim() ? ' (expiry ignored: this project doesn\'t track claim expiry)' : ''
    await comment(repoOctokit, owner, repo, issueNumber, `@${actor} you've claimed this task.${suffix}`)
    return
  }

  const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
  if (!res.ok) {
    await comment(repoOctokit, owner, repo, issueNumber, `@${actor} ${res.reason}`)
    return
  }

  // Fail-closed order: write the expiry BEFORE flipping to Claimed, so the item is never
  // observable as Claimed-with-empty-expiry (which a sweep could misread as a legacy claim).
  // Then status, then assignment, then the human comment.
  await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
  await setStatus(octokit, ctx, item.itemId, claimedId)
  await assign(repoOctokit, owner, repo, issueNumber, actor)
  await writeNote(deps, item.itemId, note, true)

  const lines = [`@${actor} you've claimed this task — it expires **${formatExpiry(res.expiry)}**.`]
  if (res.usedDefault) {
    lines.push(`That's the project default. To set your own, comment e.g. \`claim 2w\`, \`claim 5 hours\`, or \`claim 2026-08-01\` — and \`claim <when>\` again any time to extend.`)
  }
  await comment(repoOctokit, owner, repo, issueNumber, lines.join('\n\n'))
}

/**
 * Join an active registration as a listed co-participant.
 *
 * The issue form's participants field (`claim-participants-field`) is the author's explicit
 * invitation list, so someone named there who comments `claim` on a held task joins it as a
 * co-holder instead of being refused. This is also the self-service path for participants the
 * auto-claim couldn't assign: by commenting they've just made themselves assignable, so the
 * assignment that failed on open succeeds now. Joining leaves status and note untouched; a
 * joiner who gave an expiry renews the shared one, exactly as any holder could a moment later.
 *
 * Returns true when the comment was handled here (joined, or failed with its own diagnostic);
 * false hands back to the ordinary refusal.
 */
async function tryJoinAsParticipant(
  deps: Deps,
  item: { itemId: string; statusOptionId: string | null },
  assignees: string[],
  expiryArg: string,
  note: string,
): Promise<boolean> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps
  if (!cfg.claimParticipantsField) return false
  const claimedId = requireOption(ctx, cfg.statusClaimed)
  const inProgressId = optionId(ctx, cfg.statusInProgress)
  const active = item.statusOptionId === claimedId || (inProgressId !== null && item.statusOptionId === inProgressId)
  if (!active || assignees.length === 0) return false
  if (assignees.some((a) => a.toLowerCase() === actor.toLowerCase())) return false

  const body = await getIssueBody(repoOctokit, owner, repo, issueNumber)
  const listed = parseParticipants(readFormField(body, cfg.claimParticipantsField))
  if (!listed.some((p) => p.toLowerCase() === actor.toLowerCase())) return false

  // Confirm the assignment stuck (GitHub silently drops assignees it won't accept). The actor
  // just commented, so they're normally assignable; the cap of ten is the realistic failure.
  await assign(repoOctokit, owner, repo, issueNumber, actor)
  const after = await getAssignees(repoOctokit, owner, repo, issueNumber)
  if (!after.some((a) => a.toLowerCase() === actor.toLowerCase())) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} you're listed as a participant here, but GitHub didn't accept the assignment, so I couldn't register you on this task.`)
    return true
  }

  const holders = assignees.map((a) => `@${a}`).join(', ')
  let line = `@${actor} you've joined this registration alongside ${holders}.`
  if (expiryEnabled(cfg) && expiryArg.trim()) {
    const res = resolveExpiry(expiryArg, new Date(), cfg.defaultTtl, cfg.maxTtlMs)
    if (res.ok) {
      await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
      line += ` The registration now expires **${formatExpiry(res.expiry)}**.`
    } else {
      // Forgiving like auto-claim: the join stands, only the expiry change is declined.
      line += ` I've left the shared expiry unchanged, though — ${res.reason}`
    }
  }
  await writeNote(deps, item.itemId, note)
  await comment(repoOctokit, owner, repo, issueNumber, line)
  return true
}
