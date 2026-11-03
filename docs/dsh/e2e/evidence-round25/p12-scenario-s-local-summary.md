# DSH e2e (CI)
| check | result | what | detail |
|---|---|---|---|
| ST1 | PASS | all 20 runs (5 sessions x 4 parallel rounds, each a restart) exit 0 and finish their plan | {"bad": {}} |
| ST2 | PASS | no duplicate / overlapping / gapped compartments, no duplicate tag numbers, integrity ok | {"sessions": 5, "issues": {}, "integrity": "ok"} |
| ST3 | PASS | no residue after the runs: no live lease, no compartment-in-progress flag, no open outbox op, no process left | {"residue": {}, "procs": []} |
| ST4 | PASS | no abnormal growth: DB(+WAL) growth per round bounded, max RSS and median wall time of round 4 within bounds of round 1 | {"dbBytes": [1626112, 1662976, 1699840, 1740800], "rssKb": [null, null], "medianSec": [null, null], "rows": {"tags": 451, "compartments": 44, "memories": 5, "historian_runs": 153, "dsh_context_outbox": 230, "pending_ops": 21, "message_history_index": 12, "compartment_events": 0}, "pages": {"pageSize… |
| ST5 | PASS | the stress exercised the historian: compartments were published under concurrency | {"compartments": {"session-808ea370-0eb2-4d24-9716-66223dda8605": 3, "session-95dc69de-450a-49c3-99da-99c11cc40ace": 1, "session-eaf33432-d81d-462a-8f9a-d457e7c490a4": 0, "session-69b29b5b-ba44-46f8-9c0a-0a2d0b11f618": 0, "session-b996a422-237c-452e-8882-fbc28c3b9f4e": 0}, "historianRuns": {"session… |
