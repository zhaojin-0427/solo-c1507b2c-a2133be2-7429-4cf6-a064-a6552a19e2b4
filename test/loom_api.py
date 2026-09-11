#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上机工艺单 API 端到端测试（Flask test_client + 临时 SQLite）：
  冻结建立 → 列表进度 → 顺序确认 / 倒序撤回 → 复制新版（原单不改写、失效标记）→ 删除。
直接运行：python3 test/loom_api.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402


def make_snapshot(ends=16, picks=16, shafts=4, treadles=4):
    return {
        "shafts": shafts, "treadles": treadles, "ends": ends, "picks": picks,
        "maxFloat": 3,
        "threading": [e % shafts for e in range(ends)],
        "treadling": [p % treadles for p in range(picks)],
        "tieup": [[(s == t or s == (t + 1) % 4) for t in range(treadles)] for s in range(shafts)],
        "warpColor": [0] * ends, "weftColor": [1] * picks,
        "palette": [{"name": "白", "hex": "#fff"}, {"name": "蓝", "hex": "#274060"}],
    }


def make_params(width=40.0):
    return {
        "finishWidth": width, "finishLength": 200,
        "warpShrink": 8, "weftShrink": 8,
        "warpDensity": 10, "weftDensity": 10,
        "reedDents": 5, "wasteFront": 30, "wasteBack": 30,
        "yarnGpm": [0.05, 0.05],
    }


def make_steps(width_ends=400):
    """与前端 LoomCore.buildSteps 同构的最小步骤集（整经 + 穿综 + 穿筘）。"""
    return [
        {"kind": "warp", "label": f"整经：第 1–{width_ends} 根 · 色号1 白 ×{width_ends} 根",
         "detail": {"from": 1, "to": width_ends, "color": 0, "count": width_ends}},
        {"kind": "thread", "label": f"穿综：第 1–{width_ends} 根 · 循环 [1 2 3 4] ×{width_ends // 4} 次",
         "detail": {"from": 1, "to": width_ends, "cycle": [0, 1, 2, 3], "times": width_ends // 4}},
        {"kind": "dent", "label": f"穿筘：第 1–{width_ends} 根 · 每筘 [2] 循环，共 {width_ends // 2} 筘",
         "detail": {"from": 1, "to": width_ends, "seq": [2], "dents": width_ends // 2, "lastPartial": None}},
    ]


def make_payload(width=40.0, ends=400, name="测试工艺单"):
    return {
        "name": name,
        "draftId": None, "draftName": "未保存草稿",
        "snapshot": make_snapshot(),
        "params": make_params(width),
        "derived": {"totalEnds": ends, "reedWidthCm": ends / 9.2, "warpLengthM": 2.77,
                    "estPicks": 2000, "repeatWarp": 4, "gpm": [0.05, 0.05],
                    "warpColors": [], "weftColors": [],
                    "totalWarpGrams": 1, "totalWeftGrams": 1, "totalGrams": 2},
        "reedPlan": {"seq": [2], "avg": 2, "err": 0, "dents": ends // 2,
                     "target": 1.84, "exact": False, "note": None},
        "fingerprint": f"fp-{width}",
        "steps": make_steps(ends),
    }


class LoomSheetApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        app_module.app.config["DATABASE"] = os.path.join(cls.tmp.name, "test.db")
        app_module.init_db()
        cls.client = app_module.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def post_json(self, url, body=None, status=200):
        rv = self.client.post(url, data=json.dumps(body), content_type="application/json")
        self.assertEqual(rv.status_code, status, rv.data)
        return rv.get_json()

    def test_01_create_sheet(self):
        s = self.post_json("/api/sheets", make_payload(), status=201)
        self.__class__.sid = s["id"]
        self.assertEqual(s["version"], 1)
        self.assertEqual(s["stepCount"], 3)
        self.assertEqual(s["doneCount"], 0)
        self.assertEqual(s["staleCount"], 0)

    def test_02_create_validation(self):
        rv = self.client.post("/api/sheets", json={"name": "缺快照"})
        self.assertEqual(rv.status_code, 400)
        bad = make_payload()
        bad["steps"] = [{"kind": "weave", "label": "x", "detail": {}}]
        rv = self.client.post("/api/sheets", json=bad)
        self.assertEqual(rv.status_code, 400)
        bad2 = make_payload()
        bad2["steps"] = []
        rv = self.client.post("/api/sheets", json=bad2)
        self.assertEqual(rv.status_code, 400)

    def test_03_get_detail(self):
        s = self.client.get(f"/api/sheets/{self.__class__.sid}").get_json()
        self.assertEqual(len(s["steps"]), 3)
        self.assertEqual([st["kind"] for st in s["steps"]], ["warp", "thread", "dent"])
        self.assertEqual(s["steps"][0]["detail"]["to"], 400)
        self.assertEqual(s["params"]["finishWidth"], 40.0)
        self.assertEqual(s["derived"]["totalEnds"], 400)
        self.assertEqual(s["reedPlan"]["seq"], [2])
        self.assertFalse(any(st["done"] for st in s["steps"]))

    def test_04_list_progress(self):
        rows = self.client.get("/api/sheets").get_json()
        row = next(r for r in rows if r["id"] == self.__class__.sid)
        self.assertEqual((row["stepCount"], row["doneCount"]), (3, 0))

    def test_05_done_must_be_ordered(self):
        sid = self.__class__.sid
        steps = self.client.get(f"/api/sheets/{sid}").get_json()["steps"]
        # 跳过第 1 步直接确认第 2 步 → 409
        rv = self.client.post(f"/api/sheets/{sid}/steps/{steps[1]['id']}/done")
        self.assertEqual(rv.status_code, 409)
        # 顺序确认第 1、2 步
        self.post_json(f"/api/sheets/{sid}/steps/{steps[0]['id']}/done")
        st2 = self.post_json(f"/api/sheets/{sid}/steps/{steps[1]['id']}/done")
        self.assertTrue(st2["done"])
        self.assertIsNotNone(st2["doneAt"])
        # 重复确认 → 409
        rv = self.client.post(f"/api/sheets/{sid}/steps/{steps[1]['id']}/done")
        self.assertEqual(rv.status_code, 409)

    def test_06_undo_only_reverse_order(self):
        sid = self.__class__.sid
        steps = self.client.get(f"/api/sheets/{sid}").get_json()["steps"]
        # 第 1 步后面还有已确认的第 2 步 → 不能先撤第 1 步
        rv = self.client.post(f"/api/sheets/{sid}/steps/{steps[0]['id']}/undo")
        self.assertEqual(rv.status_code, 409)
        # 倒序撤回第 2 步 → 成功；再撤第 1 步 → 成功
        st2 = self.post_json(f"/api/sheets/{sid}/steps/{steps[1]['id']}/undo")
        self.assertFalse(st2["done"])
        st1 = self.post_json(f"/api/sheets/{sid}/steps/{steps[0]['id']}/undo")
        self.assertFalse(st1["done"])
        # 未确认的步骤不能撤回
        rv = self.client.post(f"/api/sheets/{sid}/steps/{steps[2]['id']}/undo")
        self.assertEqual(rv.status_code, 409)

    def test_07_copy_marks_stale_and_keeps_original(self):
        sid = self.__class__.sid
        # 原单先确认两步（复制后原单进度保留）
        steps = self.client.get(f"/api/sheets/{sid}").get_json()["steps"]
        self.post_json(f"/api/sheets/{sid}/steps/{steps[0]['id']}/done")
        self.post_json(f"/api/sheets/{sid}/steps/{steps[1]['id']}/done")

        # 新版：宽度 40 → 50（整经根数与步骤全部变化）
        r = self.post_json(f"/api/sheets/{sid}/copy",
                           make_payload(width=50.0, ends=500, name="测试工艺单 v2"),
                           status=201)
        new = r["sheet"]
        self.__class__.sid2 = new["id"]
        self.assertEqual(new["version"], 2)
        self.assertEqual(new["parentId"], sid)
        self.assertEqual(r["staleCount"], 3)   # 原单 3 步全部与新单不符

        # 原单不被改写：参数仍是 40cm、进度仍在、步骤已标失效
        old = self.client.get(f"/api/sheets/{sid}").get_json()
        self.assertEqual(old["params"]["finishWidth"], 40.0)
        self.assertEqual(old["doneCount"], 2)
        self.assertEqual(old["staleCount"], 3)
        self.assertTrue(all(st["stale"] for st in old["steps"]))

        # 失效步骤不能确认（第 3 步未确认且已失效）
        rv = self.client.post(f"/api/sheets/{sid}/steps/{old['steps'][2]['id']}/done")
        self.assertEqual(rv.status_code, 409)
        # 已确认的失效步骤仍可倒序撤回（先撤第 2 步）
        self.post_json(f"/api/sheets/{sid}/steps/{old['steps'][1]['id']}/undo")

    def test_08_copy_identical_keeps_steps_valid(self):
        sid = self.__class__.sid
        # 与原单完全相同的新版：签名一致 → 无失效
        r = self.post_json(f"/api/sheets/{sid}/copy", make_payload(), status=201)
        self.assertEqual(r["staleCount"], 0)
        self.__class__.sid3 = r["sheet"]["id"]
        old = self.client.get(f"/api/sheets/{sid}").get_json()
        # 原单仅剩的未失效步骤（第 3 步在上轮已被标记失效过，不重复计数）
        self.assertEqual(old["staleCount"], 3)

    def test_09_delete_sheet(self):
        sid3 = self.__class__.sid3
        self.assertEqual(self.client.delete(f"/api/sheets/{sid3}").get_json()["ok"], True)
        self.assertEqual(self.client.get(f"/api/sheets/{sid3}").status_code, 404)
        # 删除后步骤级联删除（通过列表计数验证其它单不受影响）
        rows = self.client.get("/api/sheets").get_json()
        ids = [r["id"] for r in rows]
        self.assertIn(self.__class__.sid, ids)
        self.assertIn(self.__class__.sid2, ids)
        self.assertNotIn(sid3, ids)

    def test_10_missing_sheet_404(self):
        self.assertEqual(self.client.get("/api/sheets/99999").status_code, 404)
        rv = self.client.post("/api/sheets/99999/steps/1/done")
        self.assertEqual(rv.status_code, 404)
        rv = self.client.post("/api/sheets/99999/copy", json=make_payload())
        self.assertEqual(rv.status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
