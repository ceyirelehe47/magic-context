"""Offline-tested admission ledger, NOT a billing proxy or a dollar guarantee.

Every upstream attempt must acquire a reservation before dispatch, including
retries, title, historian, dreamer, summarizer and embedding calls. Reservations
with uncertain outcomes remain charged at the verified worst-case bound. Missing
usage halts new admission. This module cannot prove exclusive network routing,
provider prices, or provider-enforced token ceilings; live.py intentionally refuses
paid execution until that separate integration exists.
"""
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import json
import math
from pathlib import Path
import threading
import time


class StopRun(RuntimeError):
    pass


def amount(value):
    if isinstance(value, bool):
        raise ValueError("boolean is not an amount")
    try:
        value = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("invalid amount") from exc
    if not value.is_finite() or value < 0:
        raise ValueError("amount must be finite and nonnegative")
    return value


def integer(value, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"expected integer >= {minimum}")
    return value


class Ledger:
    """One serializable ledger for the ENTIRE paired experiment, not each arm.

    The append-only journal is fsynced BEFORE permission to dispatch is returned.
    Never resume this ledger after a gateway restart: an uncertain prior attempt
    must not be replayed. A fresh run needs new, explicit budget authorization.
    """

    def __init__(self, journal, *, dollars, max_calls, seconds, clock=time.monotonic):
        self.limit = amount(dollars)
        if not 0 < self.limit <= Decimal("10"):
            raise ValueError("this experiment is authorized for at most USD 10 total")
        self.max_calls = integer(max_calls, 1)
        if self.max_calls > 1000:
            raise ValueError("max_calls exceeds reviewed limit 1000")
        if isinstance(seconds, bool) or not math.isfinite(seconds) or not 0 < seconds <= 7200:
            raise ValueError("seconds must be finite and in (0, 7200]")
        self.clock, self.deadline = clock, clock() + seconds
        self.records, self.charged, self.stopped = {}, Decimal(0), None
        self.lock = threading.RLock()
        self.journal = Path(journal)
        self.journal.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation: never silently start a fresh budget over old evidence.
        self.file = self.journal.open("x", encoding="utf-8")
        self._write({"event": "start", "limit_usd": str(self.limit),
                     "max_calls": self.max_calls, "seconds": seconds})

    def _write(self, event):
        import os
        try:
            self.file.write(json.dumps(event, sort_keys=True) + "\n")
            self.file.flush()
            os.fsync(self.file.fileno())
        except Exception:
            self.stopped = "journal write failed; no new dispatch allowed"
            raise

    def _halt(self, reason):
        self.stopped = reason
        self._write({"event": "stop", "reason": reason})
        raise StopRun(reason)

    def admit(self, *, arm, kind, model, input_ceiling, output_ceiling,
              input_usd_per_million, output_usd_per_million, fixed_fee_usd=0):
        """Ceilings/rates must already be externally verified, never estimated.

        Cache is priced as a miss. Output ceiling must include hidden reasoning.
        Prices must cover the actual intermediary, taxes and every billed unit.
        Unknown kinds remain accounted: labels are not an exemption.
        """
        with self.lock:
            if self.stopped:
                raise StopRun(self.stopped)
            if self.clock() >= self.deadline:
                self._halt("elapsed-time limit")
            if len(self.records) >= self.max_calls:
                self._halt("call limit")
            if arm not in ("baseline", "plugin") or not kind or not model:
                raise ValueError("arm, kind and model are required")
            inp, out = integer(input_ceiling), integer(output_ceiling)
            ir, outr = amount(input_usd_per_million), amount(output_usd_per_million)
            if ir == 0 or outr == 0:
                raise ValueError("zero/unknown model prices cannot authorize a paid request")
            fee = amount(fixed_fee_usd)
            reserve = ((inp * ir + out * outr) / 1_000_000 + fee).quantize(
                Decimal("0.000000001"), rounding=ROUND_CEILING)
            if self.charged + reserve > self.limit:
                self._halt("insufficient remaining worst-case budget")
            rid = len(self.records) + 1
            rec = {"id": rid, "arm": arm, "kind": kind, "model": model,
                   "input_ceiling": inp, "output_ceiling": out,
                   "reserve_usd": str(reserve), "state": "reserved"}
            self._write({"event": "admit", **rec})
            self.records[rid] = {**rec, "input_rate": ir, "output_rate": outr, "fee": fee}
            self.charged += reserve
            return rid

    def settle(self, rid, *, input_tokens=None, output_tokens=None,
               provider_usage=None, complete=True):
        with self.lock:
            rec = self.records[rid]
            if rec["state"] != "reserved":
                raise ValueError("attempt already settled")
            # Missing/aborted responses may have been billed: retain the entire
            # reservation and stop, instead of releasing it or guessing zero.
            if not complete or input_tokens is None or output_tokens is None or not isinstance(provider_usage, dict):
                rec["state"] = "uncertain"
                self._write({"event": "uncertain", "id": rid,
                             "charged_usd": rec["reserve_usd"]})
                self._halt("unknown usage or incomplete response")
            try:
                inp, out = integer(input_tokens), integer(output_tokens)
            except ValueError:
                rec["state"] = "uncertain"
                self._halt("invalid usage")
            if inp > rec["input_ceiling"] or out > rec["output_ceiling"]:
                rec["state"] = "ceiling_violation"
                self._halt("provider violated verified token ceiling; dollar guarantee invalid")
            cost = ((inp * rec["input_rate"] + out * rec["output_rate"]) / 1_000_000 + rec["fee"]).quantize(
                Decimal("0.000000001"), rounding=ROUND_CEILING)
            self._write({"event": "settle", "id": rid, "input_tokens": inp,
                         "output_tokens": out, "upper_cost_usd": str(cost),
                         "provider_usage": provider_usage})
            self.charged += cost - Decimal(rec["reserve_usd"])
            rec.update(state="settled", input_tokens=inp, output_tokens=out, upper_cost_usd=str(cost))

    def snapshot(self):
        with self.lock:
            return {"calls": len(self.records), "charged_upper_usd": str(self.charged),
                    "limit_usd": str(self.limit), "stopped": self.stopped,
                    "unsettled": sum(r["state"] != "settled" for r in self.records.values())}

    def close(self):
        self.file.close()
