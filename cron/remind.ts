/**
 * Daily reminder dispatcher — runs via GitHub Actions on a market-aware schedule.
 * Finds all RemindMe records due today and sends the notification.
 * Optional `markets` filter: only send for the specified market buckets.
 *   "tw"     = Taiwan/HK stocks (sent at 8:30 AM Taipei before TW open)
 *   "crypto" = crypto (sent at 8:30 AM Taipei after daily candle settles)
 *   "us"     = US stocks (sent at 9:00 PM Taipei before US market opens)
 */

import { db } from "../src/db.js"
import { deliver, maskRecipient } from "./notify.js"

type Market = "tw" | "us" | "crypto"

/**
 * How late a reminder may be and still be worth sending.
 *
 * Three days covers a cron outage or a weekend of failed pushes — late is
 * better than never. Beyond that, delivering a reminder to "check X" is noise
 * rather than help, so it is expired instead. Four rows from April 2026 were
 * still pending five months on, which is what this bounds.
 */
const GRACE_DAYS = 3

function getMarket(assetType: string, symbol: string): Market {
  if (assetType === "crypto") return "crypto"
  if (/\.(TWO?|HK)$/i.test(symbol) || /^\d{4}$/.test(symbol)) return "tw"
  return "us"
}

export interface RemindRunResult {
  /** Reminders due today in the requested market buckets. */
  due: number
  /** Reminders delivered and marked sent. */
  sent: number
  /**
   * Reminders whose push threw.
   *
   * They stay `sent: false`, but the query below only looks at TODAY, so
   * nothing retries them and nothing expires them — a failed reminder simply
   * disappears. Reporting the count is the minimum fix: the workflow now fails
   * instead of going green over a reminder the user never received.
   */
  failed: number
  /**
   * Reminders abandoned this run: past the grace window, or addressed to a
   * recipient who can never receive again. Recorded as `expired_at`, never as
   * `sent`, so an undelivered reminder is never mistaken for a delivered one.
   */
  expired: number
  /**
   * Recipients switched off this run because they can never receive again
   * (blocked the bot, or an id that is not addressable at all). Reported but
   * deliberately NOT counted as a failure — see cron/notify.ts::deliver.
   */
  deactivated: string[]
}

export async function runRemind(markets?: Market[]): Promise<RemindRunResult> {
  // Use Taipei date as the boundary so reminders fire on the correct Taiwan day
  const taipeiDateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" })
  const today = new Date(taipeiDateStr)       // UTC midnight of today's Taipei date
  const tomorrow = new Date(taipeiDateStr)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)

  // Everything still outstanding up to and including today — not just today.
  // The old `gte today` made a miss permanent and silent: one day the cron did
  // not run (or one failed push) and the row stayed sent=false forever, never
  // retried, never expired, still shown as pending in the app. Four rows had
  // been in that state since April 2026.
  const graceStart = new Date(today)
  graceStart.setUTCDate(graceStart.getUTCDate() - GRACE_DAYS)

  const outstanding = await db.remindMe.findMany({
    where: {
      sent: false,
      expired_at: null,
      remind_date: { lt: tomorrow },
    },
  })

  const mine = markets
    ? outstanding.filter(r => markets.includes(getMarket(r.asset_type, r.symbol)))
    : outstanding

  // Late but still useful vs. so old that delivering it would just be noise.
  // Both halves are scoped to this run's market filter, so a tw/crypto run can
  // never expire a US reminder that remind-us has not had its turn at yet.
  const due     = mine.filter(r => r.remind_date >= graceStart)
  const tooOld  = mine.filter(r => r.remind_date <  graceStart)

  const marketLabel = markets ? ` [${markets.join(",")}]` : ""
  console.log(`Sending ${due.length}/${outstanding.length} reminders${marketLabel}` +
              (tooOld.length ? `, expiring ${tooOld.length} past the ${GRACE_DAYS}-day grace window` : "") + "...")

  let sent = 0
  let failed = 0
  const deactivated: string[] = []

  // Abandon the ones past the window, in a state that does not claim delivery.
  let expired = 0
  if (tooOld.length > 0) {
    const res = await db.remindMe.updateMany({
      where: { id: { in: tooOld.map(r => r.id) } },
      data: { expired_at: new Date() },
    })
    expired = res.count
    for (const r of tooOld) {
      console.warn(`  ⚠ expired reminder ${r.symbol} (due ${r.remind_date.toISOString().slice(0, 10)})` +
                   ` for ${r.platform}:${maskRecipient(r.user_id)} — past the ${GRACE_DAYS}-day grace window`)
    }
  }

  await Promise.allSettled(due.map(async r => {
    try {
      // A late one says so, rather than looking like it was scheduled for today.
      const dueStr = r.remind_date.toISOString().slice(0, 10)
      const late   = r.remind_date < today ? `（原訂 ${dueStr}，補送）` : ""
      const msg = `🔔 提醒：${r.symbol}${late}${r.note ? `\n${r.note}` : ""}`
      const outcome = await deliver(r.platform, r.user_id, msg)
      if (outcome === "deactivated") {
        // Unreachable for good — expired, NOT marked sent. It was never
        // delivered and the record has to keep saying so.
        await db.remindMe.update({ where: { id: r.id }, data: { expired_at: new Date() } })
        expired++
        deactivated.push(`${r.platform}:${maskRecipient(r.user_id)}`)
        return
      }
      await db.remindMe.update({ where: { id: r.id }, data: { sent: true } })
      sent++
      console.log(`  ✓ reminded ${r.user_id} about ${r.symbol}`)
    } catch (err) {
      failed++
      console.error(`  ✗ reminder ${r.id}:`, err)
    }
  }))

  console.log(`Reminders complete. due=${due.length} sent=${sent} failed=${failed} expired=${expired}` +
              (deactivated.length ? ` deactivated=${deactivated.join(",")}` : ""))
  return { due: due.length, sent, failed, expired, deactivated }
}
