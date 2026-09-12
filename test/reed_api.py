#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
分区变筘 API 端到端测试（Flask test_client + 临时 SQLite）：
  分区方案冻结 → 结构校验拒绝 → 服务端复核（漏穿/重穿/空筘超限/镜像破坏/宽度偏差）
  → 复制新版（原单不改写）→ 旧统一穿筘工艺单兼容。
直接运行：python3 test/reed_api.py
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


def make_params():
    return {
        "finishWidth": 40.0, "finishLength": 200,
        "warpShrink": 8, "weftShrink": 8,
        "warpDensity": 10, "weftDensity": 10,
        "reedDents": 5, "wasteFront": 30, "wasteBack": 30,
        "yarnGpm": [0.05, 0.05],
    }


# 整经 400 根、筘 5 筘/cm：
#   区段1 第 1–200 根，目标 10 根/cm → 每筘 2 根 × 100 筘（宽 20cm，精确）
#   区段2 第 201–400 根，目标 5 根/cm → 每筘 1 根 × 200 筘（宽 40cm，精确）
GOOD_ZONES = [
    {"from": 1, "to": 200, "targetDensity": 10, "maxPerDent": 2,
     "maxEmptyRun": 0, "mirror": False, "locked": False},
    {"from": 201, "to": 400, "targetDensity": 5, "maxPerDent": 2,
     "maxEmptyRun": 0, "mirror": False, "locked": False},
]
GOOD_DENTS = [2] * 100 + [1] * 200


def make_steps(ends=400, zoned=False):
    steps = [
        {"kind": "warp", "label": f"整经：第 1–{ends} 根 · 色号1 白 ×{ends} 根",
         "detail": {"from": 1, "to": ends, "color": 0, "count": ends}},
        {"kind": "thread", "label": f"穿综：第 1–{ends} 根 · 循环 [1 2 3 4] ×{ends // 4} 次",
         "detail": {"from": 1, "to": ends, "cycle": [0, 1, 2, 3], "times": ends // 4}},
    ]
    if zoned:
        steps.append({
            "kind": "dent", "label": "穿筘（区段1）：第 1–200 根 · 每筘 [2]，共 100 筘",
            "detail": {"from": 1, "to": 200, "zone": 0, "seq": [2] * 100,
                       "dents": 100, "empty": 0, "dent0": 1, "full": True}})
        steps.append({
            "kind": "dent", "label": "穿筘（区段2）：第 201–400 根 · 每筘 [1]，共 200 筘",
            "detail": {"from": 201, "to": 400, "zone": 1, "seq": [1] * 200,
                       "dents": 200, "empty": 0, "dent0": 101, "full": True}})
    else:
        steps.append({
            "kind": "dent", "label": f"穿筘：第 1–{ends} 根 · 每筘 [2] 循环，共 {ends // 2} 筘",
            "detail": {"from": 1, "to": ends, "seq": [2], "dents": ends // 2,
                       "lastPartial": None}})
    return steps


def make_payload(reed_plan, steps=None, name="分区工艺单"):
    return {
        "name": name,
        "draftId": None, "draftName": "未保存草稿",
        "snapshot": make_snapshot(),
        "params": make_params(),
        "derived": {"totalEnds": 400, "reedWidthCm": 43.5, "warpLengthM": 2.77,
                    "estPicks": 2000, "repeatWarp": 4, "gpm": [0.05, 0.05],
                    "warpColors": [], "weftColors": [],
                    "totalWarpGrams": 1, "totalWeftGrams": 1, "totalGrams": 2},
        "reedPlan": reed_plan,
        "fingerprint": "fp-zoned",
        "steps": steps if steps is not None else make_steps(400, zoned=True),
    }


def good_reed_plan():
    return {
        "mode": "zoned",
        "zones": [dict(z) for z in GOOD_ZONES],
        "dents": list(GOOD_DENTS),
        "metrics": [
            {"zone": 0, "dents": 100, "ends": 200, "avg": 2, "density": 10, "err": 0},
            {"zone": 1, "dents": 200, "ends": 200, "avg": 1, "density": 5, "err": 0},
        ],
        "emptyDents": 0, "changes": 100, "reedDents": 5, "note": None,
    }


class ZonedReedApiTest(unittest.TestCase):
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

    def test_01_create_zoned_sheet(self):
        s = self.post_json("/api/sheets", make_payload(good_reed_plan()), status=201)
        self.__class__.sid = s["id"]
        self.assertEqual(s["version"], 1)
        self.assertEqual(s["stepCount"], 4)   # 整经 + 穿综 + 区段×2
        detail = self.client.get(f"/api/sheets/{s['id']}").get_json()
        rp = detail["reedPlan"]
        self.assertEqual(rp["mode"], "zoned")
        self.assertEqual(len(rp["zones"]), 2)
        self.assertEqual(len(rp["dents"]), 300)
        self.assertEqual([st["kind"] for st in detail["steps"]],
                         ["warp", "thread", "dent", "dent"])
        self.assertEqual(detail["steps"][2]["detail"]["zone"], 0)
        self.assertEqual(detail["steps"][3]["detail"]["dent0"], 101)

    def test_02_reedcheck_clean_plan(self):
        r = self.client.get(f"/api/sheets/{self.__class__.sid}/reedcheck").get_json()
        self.assertEqual(r["mode"], "zoned")
        self.assertEqual(r["errorCount"], 0)
        self.assertEqual(r["warnCount"], 0)
        self.assertEqual(r["issues"], [])

    def test_03_structural_validation_rejected(self):
        # 筘根数超 0–4
        bad = make_payload({"mode": "zoned", "zones": [dict(GOOD_ZONES[0])],
                            "dents": [2, 5, 1]})
        rv = self.client.post("/api/sheets", json=bad)
        self.assertEqual(rv.status_code, 400)
        # 每筘上限超范围
        z = dict(GOOD_ZONES[0]); z["maxPerDent"] = 0
        bad = make_payload({"mode": "zoned", "zones": [z], "dents": [2, 2]})
        rv = self.client.post("/api/sheets", json=bad)
        self.assertEqual(rv.status_code, 400)
        # 区段范围无效
        z = dict(GOOD_ZONES[0]); z["from"] = 0
        bad = make_payload({"mode": "zoned", "zones": [z], "dents": [2, 2]})
        rv = self.client.post("/api/sheets", json=bad)
        self.assertEqual(rv.status_code, 400)
        # mode 无效
        bad = make_payload({"mode": "weird", "zones": [dict(GOOD_ZONES[0])],
                            "dents": [2, 2]})
        rv = self.client.post("/api/sheets", json=bad)
        self.assertEqual(rv.status_code, 400)
        # 区段为空
        bad = make_payload({"mode": "zoned", "zones": [], "dents": [2]})
        rv = self.client.post("/api/sheets", json=bad)
        self.assertEqual(rv.status_code, 400)

    def test_04_reedcheck_locates_miss(self):
        # 筘序列少 1 根 → 区段2 漏穿第 400 根
        plan = good_reed_plan()
        plan["dents"] = [2] * 100 + [1] * 199
        s = self.post_json("/api/sheets", make_payload(plan), status=201)
        r = self.client.get(f"/api/sheets/{s['id']}/reedcheck").get_json()
        codes = [i["code"] for i in r["issues"]]
        self.assertIn("miss", codes)
        miss = next(i for i in r["issues"] if i["code"] == "miss")
        self.assertEqual(miss["zone"], 1)
        self.assertEqual(miss["endFrom"], 400)

    def test_05_reedcheck_locates_over_and_span(self):
        # 筘序列多 2 筘 → 重穿（超出整幅）
        plan = good_reed_plan()
        plan["dents"] = [2] * 100 + [1] * 200 + [1, 1]
        s = self.post_json("/api/sheets", make_payload(plan), status=201)
        r = self.client.get(f"/api/sheets/{s['id']}/reedcheck").get_json()
        codes = [i["code"] for i in r["issues"]]
        self.assertIn("over", codes)
        # 区段1 用 3 根一筘（超上限 2）且跨越区段边界
        plan2 = good_reed_plan()
        plan2["dents"] = [2] * 99 + [3] + [1] * 199 + [2]
        # 199 根被区段1 覆盖后，第 100 筘 3 根 → 跨段
        s2 = self.post_json("/api/sheets", make_payload(plan2), status=201)
        r2 = self.client.get(f"/api/sheets/{s2['id']}/reedcheck").get_json()
        codes2 = [i["code"] for i in r2["issues"]]
        self.assertIn("cap", codes2)    # 3 > maxPerDent 2
        self.assertIn("span", codes2)   # 跨越第 200 根边界

    def test_06_reedcheck_empty_run_and_mirror(self):
        zones = [
            {"from": 1, "to": 200, "targetDensity": 10, "maxPerDent": 2,
             "maxEmptyRun": 1, "mirror": False, "locked": False},
            {"from": 201, "to": 400, "targetDensity": 5, "maxPerDent": 2,
             "maxEmptyRun": 0, "mirror": True, "locked": False},
        ]
        # 区段1：连续 3 个空筘（上限 1）；区段2：镜像段非回文
        d1 = [2] * 97 + [0, 0, 0] + [2, 2, 2]      # 100 筘，200 根
        d2 = [1] * 100 + [2] + [1] * 98             # 199 筘 200 根，非回文
        plan = {"mode": "zoned", "zones": zones, "dents": d1 + d2,
                "emptyDents": 3, "changes": 0, "reedDents": 5, "note": None}
        s = self.post_json("/api/sheets", make_payload(plan), status=201)
        r = self.client.get(f"/api/sheets/{s['id']}/reedcheck").get_json()
        codes = [i["code"] for i in r["issues"]]
        self.assertIn("empty-run", codes)
        self.assertIn("mirror", codes)
        er = next(i for i in r["issues"] if i["code"] == "empty-run")
        self.assertEqual(er["zone"], 0)
        self.assertEqual(er["dent"], 98)
        mi = next(i for i in r["issues"] if i["code"] == "mirror")
        self.assertEqual(mi["zone"], 1)

    def test_07_reedcheck_width_deviation(self):
        # 区段1 目标 10 根/cm（理想宽 20cm），实际 30 筘 → 6cm，偏差 -14cm
        plan = good_reed_plan()
        plan["dents"] = [4] * 25 + [2] * 50 + [1] * 200   # 区段1 共 75 筘 → 15cm
        # 区段1：100+100=200 根？4*25+2*50=200 ✓；区段2 不变
        s = self.post_json("/api/sheets", make_payload(plan), status=201)
        r = self.client.get(f"/api/sheets/{s['id']}/reedcheck").get_json()
        width = next((i for i in r["issues"] if i["code"] == "width"), None)
        self.assertIsNotNone(width)
        self.assertEqual(width["zone"], 0)
        self.assertEqual(width["level"], "warn")

    def test_08_copy_zoned_sheet_marks_stale(self):
        sid = self.__class__.sid
        # 原单确认前两步（复制后进度保留）
        steps = self.client.get(f"/api/sheets/{sid}").get_json()["steps"]
        self.post_json(f"/api/sheets/{sid}/steps/{steps[0]['id']}/done")
        self.post_json(f"/api/sheets/{sid}/steps/{steps[1]['id']}/done")
        # 新版：区段2 改为目标 10 根/cm（穿筘步骤签名变化 → 原单失效标记）
        plan = good_reed_plan()
        plan["zones"][1]["targetDensity"] = 10
        plan["dents"] = [2] * 100 + [2] * 100
        steps2 = make_steps(400, zoned=True)
        steps2[3] = {
            "kind": "dent", "label": "穿筘（区段2）：第 201–400 根 · 每筘 [2]，共 100 筘",
            "detail": {"from": 201, "to": 400, "zone": 1, "seq": [2] * 100,
                       "dents": 100, "empty": 0, "dent0": 101, "full": True}}
        r = self.post_json(f"/api/sheets/{sid}/copy",
                           make_payload(plan, steps=steps2, name="分区工艺单 v2"),
                           status=201)
        self.assertEqual(r["sheet"]["version"], 2)
        self.assertEqual(r["sheet"]["parentId"], sid)
        self.assertGreater(r["staleCount"], 0)
        # 原单不被改写：仍是旧方案，进度仍在
        old = self.client.get(f"/api/sheets/{sid}").get_json()
        self.assertEqual(old["reedPlan"]["zones"][1]["targetDensity"], 5)
        self.assertEqual(old["doneCount"], 2)
        # 新版复核干净
        r2 = self.client.get(f"/api/sheets/{r['sheet']['id']}/reedcheck").get_json()
        self.assertEqual(r2["errorCount"], 0)

    def test_09_uniform_sheet_still_works(self):
        # 旧格式（无 mode 字段）按整幅统一穿筘：可建、复核返回 uniform
        rp = {"seq": [2], "avg": 2, "err": 0, "dents": 200,
              "target": 1.84, "exact": False, "note": None}
        s = self.post_json("/api/sheets",
                           make_payload(rp, steps=make_steps(400, zoned=False),
                                        name="旧统一工艺单"), status=201)
        detail = self.client.get(f"/api/sheets/{s['id']}").get_json()
        self.assertNotEqual(detail["reedPlan"].get("mode"), "zoned")
        self.assertEqual(detail["reedPlan"]["seq"], [2])
        r = self.client.get(f"/api/sheets/{s['id']}/reedcheck").get_json()
        self.assertEqual(r["mode"], "uniform")
        self.assertEqual(r["issues"], [])

    def test_10_reedcheck_missing_sheet_404(self):
        self.assertEqual(self.client.get("/api/sheets/99999/reedcheck").status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
