/**
 * A/E (actual vs expected) experience report — read-only signal-layer pull.
 *
 *   npx tsx scripts/ae-report.ts
 *
 * Purpose: the one-command "manual A/E table" that gates the Phase 1 decision
 * (assumption register + quarterly memo automation — see TODOS.md). Prints:
 *   1. pipeline coverage — proves outcomes/benchmarks are actually accruing
 *      (if this section looks broken, fix the pipeline before reading §2)
 *   2. hit rates per cell vs the backtested expected, with Wilson 95% lower
 *      bounds; cells with n < MIN_CELL_N get 資料不足 instead of a judgement
 *      (small-n cells breach any band by luck alone)
 *
 * Hit definition matches the backtest's precision convention: golden hit =
 * raw return > 0, death hit = raw return < 0 (ties are misses). The excess
 * column re-judges against the market benchmark (golden: beat the index,
 * death: fell more than the index) — it separates "the signal worked" from
 * "the whole market moved", but has no backtested expected yet.
 */

import { db } from "../src/db.js"

// ── Expected bases (mini assumption register — update sources when re-based) ──
// 5d raw-precision expecteds only: that is what was actually backtested.
// 10d/20d and excess columns are report-only until an expected basis exists.
const EXPECTED_5D: Record<string, { p: number; source: string }> = {
  "death 5/5": { p: 0.83, source: "backtest 2026-07-08, 16sym×9y, n=23, Wilson LB 63%" },
  "death ≥4/5": { p: 0.72, source: "same backtest, n=67, test-period 78%" },
  "death all":  { p: 0.52, source: "588-signal outcome-definition measurement 2026-07-08" },
  "golden all": { p: 0.54, source: "same measurement" },
}
const MIN_CELL_N = 20

/** Wilson 95% lower bound for a binomial proportion. */
function wilsonLB(hits: number, n: number): number {
  if (n === 0) return 0
  const z = 1.96, p = hits / n
  const denom = 1 + z * z / n
  const centre = p + z * z / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
  return (centre - margin) / denom
}

interface Row {
  signal: string
  strong_passed: number | null
  strong_applicable: number | null
  outcome_5d: number | null
  outcome_20d: number | null
  benchmark_5d: number | null
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
  let judgement = "報告用（無期望基準）"
  if (expected) {
    if (raw5.n < MIN_CELL_N) judgement = `資料不足（n=${raw5.n}<${MIN_CELL_N}，不出 A/E 判定）`
    else {
      const ae = raw5.hits / raw5.n / expected.p
      judgement = `A/E=${ae.toFixed(2)}${ae < 0.7 || ae > 1.3 ? " ⚠️出界[0.7,1.3]" : " ✓"}`
    }
  }
  return {
    cell: label,
    n: rows.length,
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
      signal: true, strong_passed: true, strong_applicable: true,
      outcome_5d: true, outcome_20d: true, benchmark_5d: true, benchmark_20d: true,
      outcome_computed_at: true, signal_date: true,
    },
    orderBy: { signal_date: "asc" },
  })

  // ── §1 pipeline coverage ────────────────────────────────────────────────
  const matured = rows.filter(r => Date.now() - r.signal_date.getTime() > 10 * 86_400_000)
  console.log("§1 管道覆蓋（先確認數據真的在累積，再看 §2）")
  console.table([{
    "交叉總數": rows.length,
    "已成熟(>10d)": matured.length,
    "有20d outcome": matured.filter(r => r.outcome_20d != null).length,
    "有20d benchmark": matured.filter(r => r.benchmark_20d != null).length,
    "死叉有強確認分": rows.filter(r => r.signal === "death_cross" && r.strong_passed != null).length
      + "/" + rows.filter(r => r.signal === "death_cross").length,
    "最早訊號": rows[0]?.signal_date.toISOString().slice(0, 10) ?? "—",
  }])
  const gap = matured.filter(r => r.outcome_20d == null || r.benchmark_20d == null).length
  if (gap > 0) console.log(`⚠️ ${gap} 筆成熟訊號缺 20d outcome/benchmark — 先查 outcome cron 再解讀下表\n`)

  // ── §2 A/E cells ────────────────────────────────────────────────────────
  const death = rows.filter(r => r.signal === "death_cross")
  console.log("§2 A/E 經驗表（hit：金叉漲=對/死叉跌=對；excess 對大盤）")
  console.table([
    cellStats(death.filter(r => r.strong_passed === 5 && r.strong_applicable === 5), "death 5/5"),
    cellStats(death.filter(r => (r.strong_passed ?? 0) >= 4), "death ≥4/5"),
    cellStats(death, "death all"),
    cellStats(rows.filter(r => r.signal === "golden_cross"), "golden all"),
  ])
  console.log("期望值出處：")
  for (const [k, v] of Object.entries(EXPECTED_5D)) console.log(`  ${k}: ${(v.p * 100).toFixed(0)}% — ${v.source}`)
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
