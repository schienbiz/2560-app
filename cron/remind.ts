/**
 * Daily reminder dispatcher — runs every morning via GitHub Actions.
 * Finds all RemindMe records due today and sends the notification.
 */

import { db } from "../src/db.js"
import { pushLine, pushTelegram } from "./notify.js"

export async function runRemind() {
  // Use Taipei date as the boundary so reminders fire on the correct Taiwan day
  const taipeiDateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" })
  const today = new Date(taipeiDateStr)       // UTC midnight of today's Taipei date
  const tomorrow = new Date(taipeiDateStr)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)

  const due = await db.remindMe.findMany({
    where: {
      sent: false,
      remind_date: { gte: today, lt: tomorrow },
    },
  })

  console.log(`Sending ${due.length} reminders...`)

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
