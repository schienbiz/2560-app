/**
 * A/E (actual vs expected) experience report — read-only signal-layer pull.
 *
 *   npx tsx scripts/ae-report.ts
 *
 * Purpose: the one-command "manual A/E table" that gates the Phase 1 decision
 * (assumption register + quarterly memo automation — see TODOS.md). Prints:
 *   §1 pipeline coverage, PER HORIZON — proves outcomes/benchmarks are actually
 *      accruing (if this section looks broken, fix the pipeline before §2)
 *   §2 hit rates per cell vs the backtested expected, with power-aware verdicts
 *   §3 re-trigger status — whether it is time to revisit the Phase 1 decision
 *
 * Hit definition matches the backtest's precision convention: golden hit =
 * raw return > 0, death hit = raw return < 0 (ties are misses). The excess
 * column re-judges against the market benchmark (golden: beat the index,
 * death: fell more than the index) — it separates "the signal worked" from
 * "the whole market moved", but has no backtested expected yet.
 */

import { db } from "../src/db.js"
import { cellVerdict, wilsonLB, powerReport } from "../src/utils/ae-stats.js"
import { coverageMatureDays, STALE_AGE_DAYS, WINDOW_CAL_DAYS } from "../src/utils/outcome-math.js"

// ── Expected bases (mini assumption register — update sources when re-based) ──
// 5d raw-precision expecteds only: that is what was actually backtested.
// 10d/20d and excess columns are report-only until an expected basis exists.
const EXPECTED_5D: Record<string, { p: number; source: string }> = {
  "death 5/5": { p: 0.83, source: "backtest 2026-07-08, 16sym×9y, n=23, Wilson LB 63%" },
  "death ≥4/5": { p: 0.72, source: "same backtest, n=67, test-period 78%" },
  "death all":  { p: 0.52, source: "588-signal outcome-definition measurement 2026-07-08" },
  "golden all": { p: 0.54, source: "same measurement" },
}
/**
 * A/E band the report calls "out of line". Symmetric — which, as ae-stats
 * explains, cannot fit a cell whose expected is high: 0.83 × 1.3 > 1.
 */
const BAND_LO = 0.7, BAND_HI = 1.3

/**
 * Phase 1 was decided NO-GO on 2026-09-09. The old re-trigger was "n ≥ 20
 * matured crosses", which measurement showed is unreachable for the only two
 * tiers carrying a quoted statistic: at the observed rate `death ≥4/5` needs
 * ~87 months and `death 5/5` has an accrual rate of zero. A milestone that
 * cannot be reached is a gate that never rings.
 *
 * So the re-trigger is a date, OR the event that would actually change
 * something: the first strong-death 5/5 ever firing. That is the moment the
 * 「回測5日精準度83%」 line gets sent to a user for the first time, quoting a
 * number with zero live samples behind it.
 */
const RETRIGGER_DATE = new Date("2026-12-15T00:00:00Z")

interface Row {
  symbol: string
  signal: string
  strong_passed: number | null
  strong_applicable: number | null
  outcome_5d: number | null
  outcome_10d: number | null
  outcome_20d: number | null
  benchmark_5d: number | null
  benchmark_10d: number | null
  benchmark_20d: number | null
  outcome_computed_at: Date | null
  signal_date: Date
}

const isHit = (signal: string, ret: number | null): boolean | null =>
  ret == null ? null : signal === "golden_cross" ? ret > 0 : ret < 0
const isExcessHit = (signal: string, ret: number | null, bench: number | null): boolean | null =>
  ret == null || bench == null ? null : signal === "golden_cross" ? ret > bench : ret < bench

function cellStats(rows: Row[], label: string) {
  const pick = (fn: (r: Row) => boolean | null) => {
    const judged = rows.map(fn).filter((v): v is boolean => v != null)
    return { n: judged.length, hits: judged.filter(Boolean).length }
  }
  const raw5 = pick(r => isHit(r.signal, r.outcome_5d))
  const raw20 = pick(r => isHit(r.signal, r.outcome_20d))
  const exc20 = pick(r => isExcessHit(r.signal, r.outcome_20d, r.benchmark_20d))

  const fmtRate = (s: { n: number; hits: number }) =>
    s.n === 0 ? "—" : `${(s.hits / s.n * 100).toFixed(0)}% (${s.hits}/${s.n}, WLB ${(wilsonLB(s.hits, s.n) * 100).toFixed(0)}%)`

  const expected = EXPECTED_5D[label]
  const judgement = expected
    ? cellVerdict(raw5.hits, raw5.n, expected.p, BAND_LO, BAND_HI).text
    : "報告用（無期望基準）"

  return {
    cell: label,
    "列數": rows.length,
    // The judgement is driven by the 5d denominator, so print THAT too — they
    // differ (a recent cross has no 5d value yet), and showing only the row
    // count made the verdict look better-evidenced than it was.
    "5d n": raw5.n,
    "5d raw": fmtRate(raw5),
    "20d raw": fmtRate(raw20),
    "20d excess": fmtRate(exc20),
    "expected 5d": expected ? `${(expected.p * 100).toFixed(0)}%` : "—",
    判定: judgement,
  }
}

async function main() {
  const rows: Row[] = await db.signalHistory.findMany({
    where: { signal: { in: ["golden_cross", "death_cross"] } },
    select: {
      // `symbol` is selected so the §1 gap list can name the offending rows —
      // a bare count tells you something is wrong but not what to go and look
      // at, which is how the 2026-09-02 warning got waved through.
      symbol: true,
      signal: true, strong_passed: true, strong_applicable: true,
      outcome_5d: true, outcome_10d: true, outcome_20d: true,
      benchmark_5d: true, benchmark_10d: true, benchmark_20d: true,
      outcome_computed_at: true, signal_date: true,
    },
    orderBy: { signal_date: "asc" },
  })

  const ageDays = (r: { signal_date: Date }) => (Date.now() - r.signal_date.getTime()) / 86_400_000

  // ── §1 pipeline coverage, PER HORIZON ───────────────────────────────────
  //
  // Every horizon is now checked, not just 20d. The §2 「資料不足」 gate is
  // driven by the *5d* denominator, so verifying only 20d meant the field that
  // decides the verdict was never the field that got verified. Coverage was in
  // fact clean at every horizon on 2026-09-09 — but that was luck, not a check.
  //
  // Maturity comes from coverageMatureDays(), which allows the weekend/holiday
  // slack the fill actually needs. The old flat `> 28` for 20d would flag rows
  // aged 29–33 days that simply had no bar yet.
  const horizons = [
    { key: "5d"  as const, k: "d5"  as const, outcome: (r: Row) => r.outcome_5d,  bench: (r: Row) => r.benchmark_5d  },
    { key: "10d" as const, k: "d10" as const, outcome: (r: Row) => r.outcome_10d, bench: (r: Row) => r.benchmark_10d },
    { key: "20d" as const, k: "d20" as const, outcome: (r: Row) => r.outcome_20d, bench: (r: Row) => r.benchmark_20d },
  ]

  console.log("§1 管道覆蓋（每個 horizon 各自到期規則；先確認數據真的在累積，再看 §2）")
  const covTable = []
  const faults: string[] = []
  for (const h of horizons) {
    const matureAt = coverageMatureDays(h.k)
    // A row past STALE_AGE_DAYS has been abandoned by the cron on purpose;
    // counting it as a live fault would make the warning permanent and
    // therefore ignorable.
    const mature = rows.filter(r => ageDays(r) > matureAt && ageDays(r) <= STALE_AGE_DAYS)
    const abandoned = rows.filter(r => ageDays(r) > STALE_AGE_DAYS && (h.outcome(r) == null || h.bench(r) == null))
    const missO = mature.filter(r => h.outcome(r) == null)
    const missB = mature.filter(r => h.bench(r) == null)
    covTable.push({
      horizon: h.key,
      "名目窗口": `+${WINDOW_CAL_DAYS[h.k]}d`,
      "視為到期": `>${matureAt}d`,
      "已到期": mature.length,
      "有outcome": mature.length - missO.length,
      "有benchmark": mature.length - missB.length,
      "缺": missO.length + missB.length,
      "已放棄(>120d)": abandoned.length,
    })
    for (const r of new Set([...missO, ...missB])) {
      faults.push(`   ${h.key} ${r.symbol} ${r.signal} ${r.signal_date.toISOString().slice(0, 10)}` +
        ` (${Math.floor(ageDays(r))}d, outcome=${h.outcome(r) == null ? "—" : "✓"} benchmark=${h.bench(r) == null ? "—" : "✓"})`)
    }
  }
  console.table(covTable)
  if (faults.length) {
    console.log(`⚠️ 視窗已到期但仍缺值 ${faults.length} 筆 — 先查 outcome cron 再解讀下表`)
    for (const f of faults) console.log(f)
    console.log("")
  } else {
    console.log("✅ 覆蓋乾淨：5d／10d／20d 所有已到期訊號都有 outcome 與 benchmark\n")
  }

  // ── §2 A/E cells ────────────────────────────────────────────────────────
  const death = rows.filter(r => r.signal === "death_cross")
  const strong55 = death.filter(r => r.strong_passed === 5 && r.strong_applicable === 5)
  console.log("§2 A/E 經驗表（hit：金叉漲=對/死叉跌=對；excess 對大盤）")
  console.table([
    cellStats(strong55, "death 5/5"),
    cellStats(death.filter(r => (r.strong_passed ?? 0) >= 4), "death ≥4/5"),
    cellStats(death, "death all"),
    cellStats(rows.filter(r => r.signal === "golden_cross"), "golden all"),
  ])
  console.log("期望值出處：")
  for (const [k, v] of Object.entries(EXPECTED_5D)) {
    const { highN, lowN } = powerReport(v.p, BAND_LO, BAND_HI)
    const power = highN == null
      ? `高側不可達（${(v.p * 100).toFixed(0)}%×${BAND_HI}>100%），低側需 n≈${lowN ?? "—"}`
      : `偵測帶邊需 n≈${highN}`
    console.log(`  ${k}: ${(v.p * 100).toFixed(0)}% — ${v.source}｜${power}`)
  }

  // ── §3 re-trigger ───────────────────────────────────────────────────────
  console.log("\n§3 Phase 1 重新檢視觸發（2026-09-09 已決策 NO-GO）")
  const dateReached = Date.now() >= RETRIGGER_DATE.getTime()
  const fired55 = strong55.length > 0
  const maxTier = death.reduce((m, r) => Math.max(m, r.strong_passed ?? 0), 0)
  console.log(`  日期 ${RETRIGGER_DATE.toISOString().slice(0, 10)}：${dateReached ? "✅ 已到" : "尚未到"}`)
  console.log(`  強確認死叉 5/5 首次出現：${fired55 ? `✅ 已出現（n=${strong55.length}）` : "尚未出現（n=0）"}`)
  console.log(`  （目前死叉強確認分上限 ${maxTier}/5，共 ${death.length} 次死叉）`)
  console.log(dateReached || fired55
    ? "  ⏰ 觸發條件已達成 — 重新走一次 TODOS 的 go/no-go 判準"
    : "  尚未觸發 — 維持 NO-GO，不需動作")
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
