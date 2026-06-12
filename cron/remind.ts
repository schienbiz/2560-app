/**
 * Daily reminder dispatcher — runs via GitHub Actions on a market-aware schedule.
 * Finds all RemindMe records due today and sends the notification.
 * Optional `markets` filter: only send for the specified market buckets.
 *   "tw"     = Taiwan/HK stocks (sent at 8:30 AM Taipei before TW open)
 *   "crypto" = crypto (sent at 8:30 AM Taipei after daily candle settles)
 *   "us"     = US stocks (sent at 9:00 PM Taipei before US market opens)
 */

import { db } from "../src/db.js"
import { pushLine, pushTelegram } from "./notify.js"

type Market = "tw" | "us" | "crypto"

function getMarket(assetType: string, symbol: string): Market {
  if (assetType === "crypto") return "crypto"
  if (/\.(TWO?|HK)$/i.test(symbol) || /^\d{4}$/.test(symbol)) return "tw"
  return "us"
}

export async function runRemind(markets?: Market[]) {
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

  await Promise.allSettled(due.map(async r => {
    try {
      const msg = `🔔 提醒：${r.symbol}${r.note ? `\n${r.note}` : ""}`
      if (r.platform === "line") {
        await pushLine(r.user_id, msg)
      } else {
        await pushTelegram(r.user_id, msg)
      }
      await db.remindMe.update({ where: { id: r.id }, data: { sent: true } })
      console.log(`  ✓ reminded ${r.user_id} about ${r.symbol}`)
    } catch (err) {
      console.error(`  ✗ reminder ${r.id}:`, err)
    }
  }))

  console.log("Reminders sent.")
}
