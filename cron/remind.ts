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

  const allDue = await db.remindMe.findMany({
    where: {
      sent: false,
      remind_date: { gte: today, lt: tomorrow },
    },
  })

  const due = markets
    ? allDue.filter(r => markets.includes(getMarket(r.asset_type, r.symbol)))
    : allDue

  const marketLabel = markets ? ` [${markets.join(",")}]` : ""
  console.log(`Sending ${due.length}/${allDue.length} reminders${marketLabel}...`)

  let sent = 0
  let failed = 0
  const deactivated: string[] = []

  await Promise.allSettled(due.map(async r => {
    try {
      const msg = `🔔 提醒：${r.symbol}${r.note ? `\n${r.note}` : ""}`
      const outcome = await deliver(r.platform, r.user_id, msg)
      if (outcome === "deactivated") {
        // Unreachable for good. Mark the reminder done so it stops being
        // retried every day for someone who can never see it.
        await db.remindMe.update({ where: { id: r.id }, data: { sent: true } })
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

  console.log(`Reminders complete. due=${due.length} sent=${sent} failed=${failed}` +
              (deactivated.length ? ` deactivated=${deactivated.join(",")}` : ""))
  return { due: due.length, sent, failed, deactivated }
}
