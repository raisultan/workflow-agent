/**
 * Labelled review cases for `pnpm eval:review` (`P16`, `T16.8`): a plan, follow-ups and a diff the clean-context review reads,
 * with what it should conclude. Synthetic, on the `eval/repos/orders-python` promo-code service; the owner's trial adds its own
 * cases from a JSON file (`--cases`), in the same shape, kept out of the repository.
 *
 * - `expect`: the verdict the change deserves (`any` when a case only checks what must not be claimed).
 * - `issues`: what a good review finds; each is caught when a finding (blocking or a note) mentions one of `match`. `must`: the
 *   verdict is wrong without it.
 * - `forbid`: claims a review must not make as a blocking finding (the trial's false failures).
 */

export interface ReviewIssue { readonly id: string; readonly must: boolean; readonly match: readonly string[]; readonly note: string }
export interface ReviewCase {
  readonly id: string
  readonly title: string
  readonly planText: string
  readonly followUps: readonly string[]
  readonly diff: string
  readonly expect: 'pass' | 'changes' | 'any'
  readonly issues: readonly ReviewIssue[]
  readonly forbid: readonly { readonly id: string; readonly match: readonly string[]; readonly note: string }[]
  /** How many times to run it (the verdict is not stable on the same input); default the script's `--runs`. */
  readonly runs?: number
}

const PLAN_LIST = `### 📋 Технический план (PROMO-12)
#### 1. Причина и контекст
**Требования**
1. GET /promo-codes отдаёт коды по сроку действия, от поздних к ранним — из задачи
2. limit: 1–100, по умолчанию 20 — @lead
#### 2. Изменения по файлам
- src/orders/catalog.py: PromoCodeStore.list(limit) — SELECT … ORDER BY expires_at_ms DESC LIMIT %s.
- src/orders/api.py: GET /promo-codes с параметром limit (1–100, по умолчанию 20); иначе ошибка INVALID_LIMIT.
#### 3. План тестирования
- без limit возвращается не больше 20 кодов (создать 25);
- limit=100 принимается, limit=0 и limit=101 — INVALID_LIMIT.
`

/** A shared constant every route uses, changed for one of them. */
const SHARED: ReviewCase = {
  id: 'E', title: 'A change to a shared error map, made for one route, changes the others', expect: 'changes', followUps: [],
  planText: `### 📋 Технический план (PROMO-13)
#### 1. Причина и контекст
**Требования**
1. POST /promo-codes/apply отдаёт 410 для истёкшего кода — из задачи
#### 2. Изменения по файлам
- src/orders/api.py: в apply — 410 EXPIRED для истёкшего кода.
#### 3. План тестирования
- истёкший код → 410 EXPIRED.
`,
  diff: `diff --git a/src/orders/api.py b/src/orders/api.py
--- a/src/orders/api.py
+++ b/src/orders/api.py
@@ -10,11 +10,12 @@ from orders.pricing import apply_promo
 ERRORS: dict[int, dict[str, object]] = {
     400: {"model": ErrorOut},
     404: {"model": ErrorOut},
+    410: {"model": ErrorOut},
 }


 @app.post("/promo-codes/apply", responses=ERRORS)
 def apply(body: ApplyIn) -> ApplyOut:
     rule = store.get(body.code)
     if rule is None:
         raise NotFound("UNKNOWN_CODE", body.code)
+    if rule.expires_at_ms <= now_ms():
+        raise Gone("EXPIRED", body.code)
     return apply_promo(rule, body.order)
@@ -30,6 +31,6 @@ def apply(body: ApplyIn) -> ApplyOut:
 @app.get("/promo-codes/{code}", responses=ERRORS)
 def get_code(code: str) -> PromoCodeOut:
     return PromoCodeOut.from_rule(store.get(code))
diff --git a/tests/test_api.py b/tests/test_api.py
--- a/tests/test_api.py
+++ b/tests/test_api.py
@@ -40,3 +40,9 @@ def test_unknown_code_is_not_found(client):
     assert client.post("/promo-codes/apply", json={"code": "NOPE", "order": ORDER}).status_code == 404
+
+
+def test_expired_code_is_gone(client, store):
+    store.upsert(rule(code="OLD", expires_at_ms=1))
+    response = client.post("/promo-codes/apply", json={"code": "OLD", "order": ORDER})
+    assert response.status_code == 410 and response.json()["error"] == "EXPIRED"
`,
  issues: [{ id: 'shared-410', must: true, match: ['ERRORS', 'get_code', 'other route', 'shared'], note: '410 in the shared ERRORS documents GET /promo-codes/{code} as returning 410' }],
  forbid: [],
}

/** A test named for a boundary whose data never reaches it, and a boundary the plan lists with no test. */
const BOUNDARY: ReviewCase = {
  id: 'F', title: 'The default-cap test makes 3 codes, so it never reaches the cap; no limit=100 test', expect: 'changes', followUps: [],
  planText: PLAN_LIST,
  diff: `diff --git a/src/orders/catalog.py b/src/orders/catalog.py
--- a/src/orders/catalog.py
+++ b/src/orders/catalog.py
@@ -48,3 +48,10 @@ class PromoCodeStore:
             (code.strip().upper(),),
         )
         return cursor.rowcount == 1
+
+    def list(self, limit: int) -> list[PromoCodeRule]:
+        with self._conn.cursor(row_factory=class_row(PromoCodeRule)) as cursor:
+            cursor.execute(
+                "SELECT code, kind, value, expires_at_ms, max_uses, used_count, min_order_cents FROM promo_codes ORDER BY expires_at_ms DESC LIMIT %s", (limit,),
+            )
+            return cursor.fetchall()
diff --git a/src/orders/api.py b/src/orders/api.py
--- a/src/orders/api.py
+++ b/src/orders/api.py
@@ -30,3 +30,10 @@ def apply(body: ApplyIn) -> ApplyOut:
 @app.get("/promo-codes/{code}", responses=ERRORS)
 def get_code(code: str) -> PromoCodeOut:
     return PromoCodeOut.from_rule(store.get(code))
+
+
+@app.get("/promo-codes")
+def list_codes(limit: int = 20) -> list[PromoCodeOut]:
+    if not 1 <= limit <= 100:
+        raise BadRequest("INVALID_LIMIT", str(limit))
+    return [PromoCodeOut.from_rule(rule) for rule in store.list(limit)]
diff --git a/tests/test_api.py b/tests/test_api.py
--- a/tests/test_api.py
+++ b/tests/test_api.py
@@ -40,3 +40,17 @@ def test_unknown_code_is_not_found(client):
     assert client.post("/promo-codes/apply", json={"code": "NOPE", "order": ORDER}).status_code == 404
+
+
+def test_listing_defaults_to_twenty(client, store):
+    for n in range(3):
+        store.upsert(rule(code=f"C{n}"))
+    assert len(client.get("/promo-codes").json()) == 3
+
+
+def test_listing_rejects_bad_limits(client):
+    assert client.get("/promo-codes", params={"limit": 0}).json()["error"] == "INVALID_LIMIT"
+    assert client.get("/promo-codes", params={"limit": 101}).json()["error"] == "INVALID_LIMIT"
`,
  issues: [
    { id: 'default-cap', must: true, match: ['twenty', '20', '25', 'cap'], note: 'the defaults test creates 3 codes; the plan asks for 25' },
    { id: 'limit-100', must: false, match: ['limit=100', '100 is accepted', 'limit 100'], note: 'the plan lists limit=100 accepted; no test' },
  ],
  forbid: [],
}

/** A revision that removes what an earlier one added: the diff against the base is just the final state, which is right. */
const ROLLBACK: ReviewCase = {
  id: 'G', title: 'A revision written as "remove the code filter" judged on the whole diff: the final state is right', expect: 'pass',
  followUps: [],
  planText: `### 📋 Технический план (PROMO-12)
#### 1. Причина и контекст
В рабочей копии уже есть фильтр по коду из предыдущей ревизии; одобряющий его отклонил.
**Требования**
1. GET /promo-codes отдаёт коды по сроку действия, от поздних к ранним, limit 1–100 (по умолчанию 20) — @lead
2. фильтра по коду нет — @lead
#### 2. Изменения по файлам
- src/orders/api.py: убрать параметр code у GET /promo-codes.
- tests/test_api.py: удалить тест фильтра по коду.
#### 3. План тестирования
- без limit — не больше 20 (создать 25); limit=0 и limit=101 — INVALID_LIMIT.
exempt deleted-test tests/test_api.py: фильтр по коду отменён
`,
  diff: BOUNDARY.diff.replace(`    for n in range(3):
+        store.upsert(rule(code=f"C{n}"))
+    assert len(client.get("/promo-codes").json()) == 3`, `    for n in range(25):
+        store.upsert(rule(code=f"C{n}"))
+    assert len(client.get("/promo-codes").json()) == 20`),
  issues: [],
  forbid: [
    { id: 'not-the-rollback', match: ['from scratch', 're-implement', 'instead of removing', 'does not remove'], note: 'judges the delta plan against the whole diff' },
    { id: 'invented-filter', match: ['still accepts code', 'code parameter remains'], note: 'claims the filter is still there' },
  ],
}

/** A small, correct change with its test: nothing to find. */
const CLEAN: ReviewCase = {
  id: 'H', title: 'A clean change with its test', expect: 'pass', followUps: [],
  planText: `### 📋 Технический план (PROMO-14)
#### 1. Причина и контекст
**Требования**
1. код промо нечувствителен к пробелам по краям при применении — из задачи
#### 2. Изменения по файлам
- src/orders/pricing.py: apply_promo нормализует код через strip().upper().
#### 3. План тестирования
- код " save10 " применяется как SAVE10.
`,
  diff: `diff --git a/src/orders/pricing.py b/src/orders/pricing.py
--- a/src/orders/pricing.py
+++ b/src/orders/pricing.py
@@ -20,7 +20,8 @@ def apply_promo(rule: PromoCodeRule, order: Order, code: str) -> Priced:
-    if code != rule.code:
+    normalized = code.strip().upper()
+    if normalized != rule.code:
         raise PromoError("CODE_MISMATCH", code)
     return price(order, rule)
diff --git a/tests/test_pricing.py b/tests/test_pricing.py
--- a/tests/test_pricing.py
+++ b/tests/test_pricing.py
@@ -12,3 +12,8 @@ def test_percent_discount():
     assert apply_promo(PERCENT_10, ORDER, "SAVE10").total_cents == 9_000
+
+
+def test_code_is_trimmed_and_upper_cased():
+    assert apply_promo(PERCENT_10, ORDER, " save10 ").total_cents == 9_000
`,
  issues: [],
  forbid: [],
}

export const REVIEW_CASES: readonly ReviewCase[] = [SHARED, BOUNDARY, ROLLBACK, CLEAN]
