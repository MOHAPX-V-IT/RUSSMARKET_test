# QA review

Scope: contract and behavior tests for `processor/engine.js`. Browser integration is checked by the main agent and is outside this review.

## Checks

- Runtime: Node v24.11.1 (contract requires Node 22+).
- `node --check tests/engine.test.js` passed.
- Previous final before the latest cases: 36 tests passed, 0 failed.
- Baseline before the strict delivery-assertion fix: 40 tests ran; 36 passed and 4 failed.
- Final `node --test` after all delivery fixes and adjacent cases: 42 tests passed, 0 failed.
- Baseline for кадровое continuation, reported damage, and ETA boundaries: 52 tests ran; 46 passed and 6 failed.
- Final `node --test` after those fixes: 52 tests passed, 0 failed.
- Test coverage is authored against `CONTRACT.md`: original record order and outcomes; separate CRM/chat evidence; Moscow snapshot timing and the no-guaranteed-13:00 boundary; confirmed acceptance; empty input; malformed input; duplicate IDs; unavailable sources; unknown/negative chat phrasing and suffixes; duplicate messages; hostile message text; deterministic output and input immutability.
- Regression cases replace only the first message text in a clone of the original snapshot. They cover P-09 discrepancy and shortage messages, negative or uncertain receipt statements, P-08 delay statements and adjacent negation variants, a delayed P-08 message with a 13:00 estimate, and denial of an awaiting-cards state.
- Latest additions cover active S-24 cancellation and active S-17 foreign-document suffixes, rejected/quoted damage claims, and P-08 estimates before, at, and after the CRM deadline.
- Duplicate semantics were confirmed with the main agent: repeated record IDs and repeated message IDs within a record are invalid; same text with distinct message IDs remains valid and must not multiply actions.
- An unresolved acceptance conflict and unavailable sources must produce `review` with `needsAction: true`.

## Findings

- Earlier P-09 discrepancy and P-08 urgency failures were fixed by processing: discrepancy messages and unresolved continuations no longer produce `clear`; negated delay messages no longer attribute a delay to the courier; and a delayed P-08 with a separate question remains urgent.
- The P-09 question-only message and the explicit statement that quantity was not checked correctly remained non-clear in the baseline.
- Added an overdue P-08 case with unknown chat text; it remains urgent and sets `requiresManualReview: true`.
- Confirmed accepted delivery without `dueAt` remains covered, matching P-09 in the source task.
- The кадровые baseline failures were fixed: S-17 with CRM `ready` and the original message plus “Документы чужие.”, and S-24 with CRM `confirmed` and the original message plus “Подтверждение отозвано.” now require manual review. Positive controls using the original message without the suffix remain `clear`.
- The final negative-phrasing fixes resolve the baseline failures: “Не опоздаю, приеду вовремя” and “Задержек нет, приеду вовремя” no longer produce positive delay claims; “Задержка не подтверждена, еду по плану” requires manual review; and “Карты получили, количество проверили. Расхождений нет” does not recommend recording a discrepancy. The mixed message adding “но не хватает пяти карт” remains actionable.
- Latest negative-phrasing baseline failures: “Задержка не выявлена, еду по плану” and “Не могу подтвердить задержку” generated positive delay claims; “Недостачи не обнаружено” and “Несоответствий нет” generated a positive discrepancy interpretation and a discrepancy-recording action.
- The latest baseline failures were fixed: active S-24 plus “Увольнение отменено” and active S-17 plus “Документы чужие” now require manual review; rejected or imperative P-09 damage claims no longer trigger a discrepancy action; and P-08 due at noon plus “Приеду после 08:00” no longer becomes a delay or deadline-risk claim. Positive controls and other ETA boundary cases pass.
- Final adjacent checks pass: “Карты ждать не надо” does not assert cards are still pending; “Вовремя не приеду” remains urgent and is either correctly interpreted or sent for manual review.
- An interim run during concurrent engine edits returned a transient `TypeError` in `processor/engine.js`; it was not counted as the baseline or final result.
- Latest baseline for active P-08 continuations: the focused run executed 5 tests, with 1 pass and 4 failures. The two positive controls (the original delay message and exactly “Задерживаюсь”) passed. The failures were the in-message contradiction “Не задерживаюсь. Задерживаюсь”, denial followed by “Карты потеряны”, delay followed by “Везу карты на другую точку” at the overdue deadline, and denial followed by the same route continuation; each returned `requiresManualReview: false` where the test requires a manual check. No full suite was run during the pending engine change.
- Final independent check after the continuation fixes: `node --check tests/engine.test.js` passed and `node --test` passed 58/58. The added cases verify manual review for within-message conflict and unclassified continuations, retention of route/card context in the explanation, overdue urgency, future-deadline handling, conflict across two courier messages without timestamps, and positive delay controls. Browser integration remains outside QA scope.
- Browser integration has not been checked by QA; the main agent owns that verification.
