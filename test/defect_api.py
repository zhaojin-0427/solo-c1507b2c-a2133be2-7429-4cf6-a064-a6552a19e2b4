#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
试织缺陷回标 API 端到端测试（Flask test_client + 临时 SQLite）：
  批次冻结快照建立、标记换算、更新、归档不可改写、修订记录、列表计数。
直接运行：python3 test/defect_api.py
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


class DefectApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        app_module.app.config["DATABASE"] = os.path.join(cls.tmp.name, "test.db")
        app_module.init_db()
        cls.client = app_module.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def post_json(self, url, body, status=200):
        rv = self.client.post(url, data=json.dumps(body), content_type="application/json")
        self.assertEqual(rv.status_code, status, rv.data)
        return rv.get_json()

    def put_json(self, url, body, status=200):
        rv = self.client.put(url, data=json.dumps(body), content_type="application/json")
        self.assertEqual(rv.status_code, status, rv.data)
        return rv.get_json()

    def test_01_batch_create_freeze_and_repeat(self):
        b = self.post_json("/api/batches", {
            "name": "批次一", "snapshot": make_snapshot(),
            "draftId": None, "draftName": "未保存草稿",
            "warpDensity": 10, "weftDensity": 10,
            "warpShrink": 8, "weftShrink": 8, "originX": 20, "originY": 20,
        }, status=201)
        self.__class__.bid = b["id"]
        self.assertEqual(b["status"], "open")
        # 斜纹快照穿综/踩踏周期均为 4
        self.assertEqual((b["repeatWarp"], b["repeatWeft"]), (4, 4))
        self.assertEqual(b["markCount"], 0)

    def test_02_create_requires_snapshot(self):
        rv = self.client.post("/api/batches", json={"name": "无快照"})
        self.assertEqual(rv.status_code, 400)
        rv = self.client.post("/api/batches", json={"snapshot": {"foo": 1}})
        self.assertEqual(rv.status_code, 400)

    def test_03_mark_coordinate_conversion(self):
        bid = self.__class__.bid
        # 间距 1mm、原点 20 → 21.5/23.0 落在 end=1 / pick=3
        m = self.post_json(f"/api/batches/{bid}/marks",
                           {"type": "mistread", "mmX": 21.5, "mmY": 23.0, "note": "n1"}, status=201)
        self.assertEqual((m["end"], m["pick"]), (1, 3))
        # 幅外序号保留（不归 -1），用于跨循环分析
        m2 = self.post_json(f"/api/batches/{bid}/marks",
                            {"type": "broken", "mmX": 60, "mmY": 23.0}, status=201)
        self.assertEqual(m2["end"], 40)
        self.assertEqual(m2["pick"], 3)
        # 原点左下方为负序号
        m3 = self.post_json(f"/api/batches/{bid}/marks",
                            {"type": "miss", "mmX": 18, "mmY": 18}, status=201)
        self.assertEqual((m3["end"], m3["pick"]), (-2, -2))
        self.__class__.mid = m["id"]

    def test_04_mark_validation(self):
        bid = self.__class__.bid
        rv = self.client.post(f"/api/batches/{bid}/marks",
                              json={"type": "bogus", "mmX": 22, "mmY": 22})
        self.assertEqual(rv.status_code, 400)
        rv = self.client.post(f"/api/batches/{bid}/marks",
                              json={"type": "miss", "mmX": "abc", "mmY": 22})
        self.assertEqual(rv.status_code, 400)

    def test_05_mark_update_and_list_count(self):
        bid, mid = self.__class__.bid, self.__class__.mid
        m = self.put_json(f"/api/batches/{bid}/marks/{mid}",
                          {"mmX": 22.5, "mmY": 24.0, "note": "拖动后", "type": "float"})
        self.assertEqual((m["end"], m["pick"]), (2, 4))
        self.assertEqual(m["note"], "拖动后")
        self.assertEqual(m["type"], "float")
        # 部分更新（只改备注）
        m = self.put_json(f"/api/batches/{bid}/marks/{mid}", {"note": "仅备注"})
        self.assertEqual(m["mmX"], 22.5)
        lst = self.client.get("/api/batches").get_json()
        row = [x for x in lst if x["id"] == bid][0]
        self.assertEqual(row["markCount"], 3)

    def test_06_delete_mark(self):
        bid = self.__class__.bid
        all_marks = self.client.get(f"/api/batches/{bid}").get_json()["marks"]
        rid = [m for m in all_marks if m["type"] == "miss"][0]["id"]
        rv = self.client.delete(f"/api/batches/{bid}/marks/{rid}")
        self.assertEqual(rv.status_code, 200)
        rv = self.client.delete(f"/api/batches/{bid}/marks/{rid}")
        self.assertEqual(rv.status_code, 404)

    def test_07_revision_record(self):
        bid = self.__class__.bid
        r = self.post_json(f"/api/batches/{bid}/revisions", {
            "action": "threading", "summary": "穿综循环位修订；32 格变化",
            "newDraftId": None, "detail": {"changed": 32},
        }, status=201)
        self.assertEqual(r["action"], "threading")
        rv = self.client.post(f"/api/batches/{bid}/revisions",
                              json={"action": "bogus", "detail": {}})
        self.assertEqual(rv.status_code, 400)

    def test_08_archive_is_immutable(self):
        bid, mid = self.__class__.bid, self.__class__.mid
        self.post_json(f"/api/batches/{bid}/archive", {})
        # 重复归档 409
        rv = self.client.post(f"/api/batches/{bid}/archive")
        self.assertEqual(rv.status_code, 409)
        # 增 / 改 / 删标记均 409
        self.assertEqual(self.client.post(f"/api/batches/{bid}/marks",
                         json={"type": "miss", "mmX": 22, "mmY": 22}).status_code, 409)
        self.assertEqual(self.client.put(f"/api/batches/{bid}/marks/{mid}",
                         json={"note": "x"}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/batches/{bid}/marks/{mid}").status_code, 409)
        # 回归：归档批次同样不得再写修订记录（只读不依赖界面禁用）
        before_revs = len(self.client.get(f"/api/batches/{bid}").get_json()["revisions"])
        rv = self.client.post(f"/api/batches/{bid}/revisions", json={
            "action": "tieup", "summary": "归档后尝试修订", "detail": {"changed": 1},
        })
        self.assertEqual(rv.status_code, 409, rv.data)
        after = self.client.get(f"/api/batches/{bid}").get_json()
        self.assertEqual(len(after["revisions"]), before_revs)
        self.assertFalse(any(r["summary"] == "归档后尝试修订" for r in after["revisions"]))
        # 归档批次详情仍可读，标记数据未被改动
        b = after
        self.assertEqual(b["status"], "archived")
        self.assertTrue(b["archivedAt"])
        self.assertEqual(len(b["marks"]), 2)
        self.assertEqual(len(b["revisions"]), 1)
        # 快照冻结：即创建时的数据副本
        self.assertEqual(b["snapshot"]["ends"], 16)

    def test_09_unknown_batch_404(self):
        self.assertEqual(self.client.get("/api/batches/99999").status_code, 404)
        self.assertEqual(self.client.post("/api/batches/99999/marks",
                         json={"type": "miss", "mmX": 1, "mmY": 1}).status_code, 404)

    def test_10_shrink_and_density_helpers(self):
        # 密度不同的批次：经密 20/cm → 间距 0.5mm
        b = self.post_json("/api/batches", {
            "name": "密批次", "snapshot": make_snapshot(ends=40, picks=16),
            "warpDensity": 20, "weftDensity": 10, "originX": 0, "originY": 0,
        }, status=201)
        m = self.post_json(f"/api/batches/{b['id']}/marks",
                           {"type": "float", "mmX": 1.25, "mmY": 2.5}, status=201)
        self.assertEqual((m["end"], m["pick"]), (2, 2))


if __name__ == "__main__":
    unittest.main(verbosity=2)
