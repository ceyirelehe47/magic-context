#!/usr/bin/env python3
"""Round 26 (P1-4) soak trend check: soak-check.py <soak.csv> <summary.md>

Judges the CSV soak.sh wrote over every segment. Mock rows carry the trends;
real-model rows are a sample of the key path. Thresholds (exit 1 on any FAIL):

  K1  mock runs: >= 99.5 % exit 0, and no circuit-breaker stop
  K2  no leftover dsh process after any run
  K3  residue after runs: live lease / historian in-progress flag / unsettled
      outbox row / open-lock file left in <= 1 % of runs, and none after the last run
  K4  max RSS: median of the last 10 % of mock runs <= 1.25 x the first 10 %
  K5  wall time: median of the last 10 % of mock runs <= 1.5 x the first 10 %
  K6  WAL <= 64 MiB at every sample; DB growth per run in the second half
      <= 1.5 x the first half (no acceleration); DB <= 512 MiB
  K7  historian failures <= 5 % of historian runs (new ones during the soak)
  K8  no mock request over the enforced window
  K9  real-model samples (when any): >= 80 % exit 0 (model / provider noise)
"""
import csv
import statistics
import sys
from pathlib import Path


def main(path: str, out: str) -> int:
    rows = list(csv.DictReader(open(path)))
    num = lambda r, k: float(r.get(k) or 0)
    mock = [r for r in rows if r["kind"] == "mock"]
    real = [r for r in rows if r["kind"] == "real"]
    res = []

    def add(cid, ok, what, detail):
        res.append((cid, "PASS" if ok else "FAIL", what, detail))

    if not mock:
        add("K0", False, "soak produced mock rows", "none")
    else:
        ok_rc = sum(1 for r in mock if r["rc"] == "0")
        breaker = Path(path).with_name("breaker.txt")
        add("K1", ok_rc / len(mock) >= 0.995 and not breaker.exists(), "mock runs exit 0 (>= 99.5 %), no breaker stop",
            f"{ok_rc}/{len(mock)}; breaker={breaker.read_text().strip() if breaker.exists() else 'no'}")
        left = max(int(num(r, "leftover")) for r in rows)
        add("K2", left == 0, "no leftover dsh process after a run", f"max {left}")
        resid = [r for r in rows if num(r, "live_leases") > 0 or num(r, "in_progress") > 0 or num(r, "outbox_open") > 0 or num(r, "open_lock") > 0]
        last = rows[-1]
        last_resid = num(last, "live_leases") + num(last, "in_progress") + num(last, "outbox_open") + num(last, "open_lock")
        add("K3", len(resid) <= max(1, 0.01 * len(rows)) and last_resid == 0, "residue (lease / in-progress / outbox / open lock) <= 1 % of runs, none at the end",
            f"{len(resid)} of {len(rows)} runs; last={int(last_resid)}; first={[r['iter'] for r in resid[:5]]}")
        warm = mock[5:] if len(mock) > 20 else mock
        n = max(3, len(warm) // 10)
        head, tail = warm[:n], warm[-n:]
        med = lambda rs, k: statistics.median(num(r, k) for r in rs)
        r0, r1 = med(head, "rss_kb"), med(tail, "rss_kb")
        add("K4", r1 <= 1.25 * r0, "max RSS: last 10 % median <= 1.25 x first 10 %", f"{int(r0)} KB -> {int(r1)} KB ({r1 / r0 if r0 else 0:.2f}x, n={n})")
        t0, t1 = med(head, "elapsed_s"), med(tail, "elapsed_s")
        add("K5", t1 <= 1.5 * t0, "wall time: last 10 % median <= 1.5 x first 10 %", f"{t0:.2f}s -> {t1:.2f}s ({t1 / t0 if t0 else 0:.2f}x)")
        wal = max(num(r, "wal_bytes") for r in rows)
        half = len(mock) // 2
        g1 = (num(mock[half], "db_bytes") - num(mock[0], "db_bytes")) / max(1, half)
        g2 = (num(mock[-1], "db_bytes") - num(mock[half], "db_bytes")) / max(1, len(mock) - 1 - half)
        dbmax = max(num(r, "db_bytes") for r in rows)
        add("K6", wal <= 64 * 2**20 and g2 <= 1.5 * max(g1, 4096) and dbmax <= 512 * 2**20,
            "WAL <= 64 MiB; DB growth per run not accelerating (2nd half <= 1.5 x 1st); DB <= 512 MiB",
            f"wal max {int(wal)}; growth/run {int(g1)} -> {int(g2)} B; db {int(num(mock[0], 'db_bytes'))} -> {int(dbmax)} B")
        hr = num(rows[-1], "historian_runs") - num(rows[0], "historian_runs")
        hf = num(rows[-1], "historian_failed") - num(rows[0], "historian_failed")
        add("K7", hf <= 0.05 * max(hr, 1), "historian failures <= 5 % of historian runs during the soak", f"{int(hf)} failed of {int(hr)}")
        over = int(num(rows[-1], "over_window"))
        add("K8", over == 0, "no mock request over the enforced window", over)
    if real:
        ok_real = sum(1 for r in real if r["rc"] == "0")
        add("K9", ok_real / len(real) >= 0.8, "real-model samples exit 0 (>= 80 %)", f"{ok_real}/{len(real)}")
    hours = (num(rows[-1], "ts") - num(rows[0], "ts")) / 3600 if rows else 0
    lines = [f"# DSH soak ({hours:.2f} h, {len(mock)} mock + {len(real)} real runs, {len(set(r['segment'] for r in rows))} segment(s))", "",
             "| check | result | what | detail |", "|---|---|---|---|"]
    lines += [f"| {c} | {s} | {w} | {str(d).replace('|', '/')} |" for c, s, w, d in res]
    Path(out).write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 1 if any(s == "FAIL" for _, s, _, _ in res) else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
