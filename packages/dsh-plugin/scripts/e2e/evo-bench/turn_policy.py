#!/usr/bin/env python3
"""Round 37 evo bench: what run.sh does after a turn, and how a run's stop is classified.

    turn_policy.py after-turn <rc> <stop|continue> <has-session 0|1> <turn>
        prints "<action> <stop-reason or ->"; action = continue | continue-after-timeout | stop

Before round 37 run.sh appended the next changelog item to the same DSH session after a
turn timeout (rc 124), so one stuck turn turned every later turn into "finish the old goal
and the new one" (42274076026 fold: 15 / 15 started turns timed out). The default policy is
now "stop": the session and workspace are left as they are for diagnosis. "continue" keeps
the old behaviour and flags every such turn (turns.jsonl continued_after_timeout) so the
report can say the trajectory after it is contaminated.

Stop classes (analyze.py): completed, turn-timeout, turn-failed, cost-cap, deadline, infra,
unknown. A green Actions job only means the pipeline ran; these classes say how the model's
run ended.
"""
import sys

POLICIES = ("stop", "continue")
TIMEOUT_RCS = (124, 137)  # `timeout` exit / its SIGKILL after -k


def after_turn(rc, policy, has_session, turn=0):
    """(action, stop_reason) after a turn ended with exit code rc."""
    if policy not in POLICIES:
        raise ValueError(f"on-timeout policy must be one of {POLICIES}, got {policy!r}")
    rc = int(rc)
    if not has_session:
        return ("stop", f"infra-no-session-turn-{turn}")
    if rc == 0:
        return ("continue", None)
    if rc in TIMEOUT_RCS:
        if policy == "continue":
            return ("continue-after-timeout", None)
        return ("stop", f"turn-timeout-turn-{turn}")
    return ("stop", f"turn-failed-rc{rc}-turn-{turn}")


def stop_class(stop):
    if not stop:
        return "unknown"
    if stop == "done":
        return "completed"
    for prefix, cls in (
        ("turn-timeout", "turn-timeout"),
        ("turn-failed", "turn-failed"),
        ("cost-cap", "cost-cap"),
        ("deadline", "deadline"),
        ("infra", "infra"),
        ("no-session", "infra"),
    ):
        if stop.startswith(prefix):
            return cls
    return "unknown"


def main(argv):
    if len(argv) == 6 and argv[1] == "after-turn":
        action, reason = after_turn(argv[2], argv[3], argv[4] == "1", int(argv[5]))
        print(f"{action} {reason or '-'}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
