#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
手织组织图校验台 (Hand-weaving draft checker)

本地 Flask 服务：
  GET  /                      单页应用
  GET  /api/drafts            草稿列表
  POST /api/drafts            新建 / 保存草稿（带 id 时为更新）
  GET  /api/drafts/<id>       读取草稿
  DELETE /api/drafts/<id>     删除草稿

  试织缺陷回标：
  GET  /api/batches                      试织批次列表（含标记摘要）
  POST /api/batches                      从当前草稿冻结快照建立批次
  GET  /api/batches/<id>                 批次详情（快照 / 标记 / 修订记录）
  POST /api/batches/<id>/archive         归档批次（归档后不可改写）
  POST /api/batches/<id>/marks           新增缺陷标记
  PUT  /api/batches/<id>/marks/<mid>     拖动 / 备注 / 改类型
  DELETE /api/batches/<id>/marks/<mid>   删除标记
  POST /api/batches/<id>/revisions       记录“另存为新草稿”的修订

  上机工艺单：
  GET  /api/sheets                       工艺单列表（含进度摘要）
  POST /api/sheets                       从当前草稿冻结工艺单（快照 + 工艺参数 + 穿筘方案 + 步骤）
  GET  /api/sheets/<id>                  工艺单详情（含步骤与确认进度）
  DELETE /api/sheets/<id>                删除工艺单
  POST /api/sheets/<id>/steps/<sid>/done 确认步骤（必须按顺序，前序未确认则拒绝）
  POST /api/sheets/<id>/steps/<sid>/undo 撤回步骤（只能倒序撤回最后已确认项）
  POST /api/sheets/<id>/copy             复制新版（不改写原单；原单中与新单不符的步骤标记失效）

所有静态资源均位于 static/ 目录，无外部 CDN 依赖，可离线运行。
草稿与试织批次持久化到 SQLite（instance/drafts.db）。
"""

import json
import math
import os
import sqlite3
from datetime import datetime

from flask import Flask, g, jsonify, render_template, request

MARK_TYPES = ("miss", "mistread", "broken", "float")

app = Flask(__name__)
app.config["DATABASE"] = os.path.join(app.instance_path, "drafts.db")


# --------------------------------------------------------------------------- #
# 数据库
# --------------------------------------------------------------------------- #
def get_db():
    if "db" not in g:
        os.makedirs(app.instance_path, exist_ok=True)
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(app.instance_path, exist_ok=True)
    db = sqlite3.connect(app.config["DATABASE"])
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS drafts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            data       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    # 试织批次：创建时冻结草稿快照与实测参数，归档后不可改写
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS weave_batches (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT NOT NULL,
            draft_id     INTEGER,
            draft_name   TEXT NOT NULL,
            snapshot     TEXT NOT NULL,
            warp_density REAL NOT NULL,      -- 实测经密（根/厘米）
            weft_density REAL NOT NULL,      -- 实测纬密（根/厘米）
            warp_shrink  REAL NOT NULL,      -- 经向缩率（%）
            weft_shrink  REAL NOT NULL,      -- 纬向缩率（%）
            origin_x     REAL NOT NULL,      -- 对齐原点（mm，相对布边/布首）
            origin_y     REAL NOT NULL,
            repeat_warp  INTEGER,            -- 冻结时快照最小经循环
            repeat_weft  INTEGER,
            status       TEXT NOT NULL DEFAULT 'open',  -- open | archived
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            archived_at  TEXT
        )
        """
    )
    # 缺陷标记：mmX/mmY 为实物坐标，end/pick 为换算后的经线/纬次（0 基，可越界为 -1）
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS weave_marks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id   INTEGER NOT NULL REFERENCES weave_batches(id) ON DELETE CASCADE,
            mtype      TEXT NOT NULL,
            mm_x       REAL NOT NULL,
            mm_y       REAL NOT NULL,
            end        INTEGER,
            pick       INTEGER,
            note       TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS weave_revisions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id    INTEGER NOT NULL REFERENCES weave_batches(id) ON DELETE CASCADE,
            new_draft_id INTEGER,
            action      TEXT NOT NULL,       -- threading | tieup | treadling
            summary     TEXT NOT NULL,
            detail      TEXT NOT NULL,       -- JSON：逐项修订参数
            created_at  TEXT NOT NULL
        )
        """
    )
    # 上机工艺单：创建时冻结草稿快照与工艺参数；复制新版不改写原单
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS loom_sheets (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            draft_id    INTEGER,
            draft_name  TEXT NOT NULL,
            snapshot    TEXT NOT NULL,       -- 冻结的草稿快照
            params      TEXT NOT NULL,       -- JSON：工艺参数（成品尺寸/缩率/密度/筘/废纱/纱重）
            derived     TEXT NOT NULL,       -- JSON：推算结果（整经根数/筘幅/经长/纬数/分色用量）
            reed_plan   TEXT NOT NULL,       -- JSON：已选穿筘方案
            fingerprint TEXT NOT NULL,       -- 快照+参数指纹，用于识别草稿/参数变化
            version     INTEGER NOT NULL DEFAULT 1,
            parent_id   INTEGER,             -- 复制来源（上一版工艺单 id）
            status      TEXT NOT NULL DEFAULT 'open',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
        """
    )
    # 工艺单步骤：整经色序 / 穿综 / 穿筘的连续区段；确认只能顺序、撤回只能倒序
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS loom_steps (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            sheet_id   INTEGER NOT NULL REFERENCES loom_sheets(id) ON DELETE CASCADE,
            step_index INTEGER NOT NULL,
            kind       TEXT NOT NULL,        -- warp | thread | dent
            label      TEXT NOT NULL,
            detail     TEXT NOT NULL,        -- JSON：区段信息（from/to/color/cycle/seq…）
            done       INTEGER NOT NULL DEFAULT 0,
            done_at    TEXT,
            stale      INTEGER NOT NULL DEFAULT 0   -- 复制新版后与新单不符 → 失效
        )
        """
    )
    db.commit()
    db.close()


def now_iso():
    return datetime.now().replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# 页面
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health():
    return jsonify(ok=True)


@app.get("/api/drafts")
def list_drafts():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, updated_at, created_at FROM drafts ORDER BY updated_at DESC"
    ).fetchall()
    return jsonify(
        [
            {
                "id": r["id"],
                "name": r["name"],
                "updated_at": r["updated_at"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    )


@app.get("/api/drafts/<int:draft_id>")
def get_draft(draft_id):
    row = get_db().execute(
        "SELECT id, name, data, updated_at FROM drafts WHERE id = ?", (draft_id,)
    ).fetchone()
    if row is None:
        return jsonify(error="草稿不存在"), 404
    try:
        data = json.loads(row["data"])
    except json.JSONDecodeError:
        return jsonify(error="草稿数据损坏"), 500
    return jsonify(id=row["id"], name=row["name"], data=data,
                   updated_at=row["updated_at"])


@app.post("/api/drafts")
def save_draft():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "data" not in payload:
        return jsonify(error="请求格式错误"), 400

    name = (str(payload.get("name") or "未命名草稿")).strip()[:80] or "未命名草稿"
    try:
        data_text = json.dumps(payload["data"], ensure_ascii=False)
    except (TypeError, ValueError):
        return jsonify(error="草稿数据无法序列化"), 400

    db = get_db()
    draft_id = payload.get("id")
    ts = now_iso()

    if draft_id:
        cur = db.execute("SELECT id FROM drafts WHERE id = ?", (draft_id,))
        if cur.fetchone() is None:
            draft_id = None  # id 不存在则新建

    if draft_id:
        db.execute(
            "UPDATE drafts SET name = ?, data = ?, updated_at = ? WHERE id = ?",
            (name, data_text, ts, draft_id),
        )
    else:
        cur = db.execute(
            "INSERT INTO drafts (name, data, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, data_text, ts, ts),
        )
        draft_id = cur.lastrowid

    db.commit()
    return jsonify(id=draft_id, name=name, updated_at=ts)


@app.delete("/api/drafts/<int:draft_id>")
def delete_draft(draft_id):
    db = get_db()
    db.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# 试织缺陷回标
# --------------------------------------------------------------------------- #
def finite_float(v, lo, hi, default):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(f):
        return default
    return max(lo, min(hi, f))


def snapshot_repeats(snapshot):
    """从冻结快照取最小经/纬循环（与前端 Engine.repeats 同口径的轻量周期）。"""
    threading = snapshot.get("threading") or []
    treadling = snapshot.get("treadling") or []
    warp = period_seq(threading) or None
    # 升综矩阵启用时组织由它驱动，纬向周期取升综行周期（与前端一致）
    dobby = snapshot.get("dobby")
    if isinstance(dobby, dict) and dobby.get("enabled") \
            and isinstance(dobby.get("cells"), list) and dobby["cells"]:
        weft = period_rows(dobby["cells"]) or None
    else:
        weft = period_seq(treadling) or None
    return warp, weft


def period_rows(cells):
    """升综矩阵行序列（每行视为一个组合）的最小周期。"""
    keys = ["".join("1" if v else "0" for v in (row or [])) for row in cells]
    return period_seq(keys)


def period_seq(seq):
    n = len(seq)
    if n == 0:
        return 0
    for k in range(1, n + 1):
        if n % k != 0:
            continue
        if all(seq[i] == seq[i - k] for i in range(k, n)):
            return k
    return n


def mm_to_index(mm, density, shrink, origin):
    """实物坐标 → 经线/纬次（0 基）。

    实测密度为成品（下机）密度：单位序号 = (实物 mm − 原点 mm) / 10 × 密度；
    缩率仅用于换算上机坐标的展示，序号换算本身不受缩率影响。
    """
    spacing = 10.0 / density if density > 0 else 0.0
    if spacing <= 0:
        return -1
    idx = int(math.floor((mm - origin) / spacing + 1e-9))
    return idx


def row_to_batch(r, mark_count=None):
    return {
        "id": r["id"],
        "name": r["name"],
        "draftId": r["draft_id"],
        "draftName": r["draft_name"],
        "warpDensity": r["warp_density"],
        "weftDensity": r["weft_density"],
        "warpShrink": r["warp_shrink"],
        "weftShrink": r["weft_shrink"],
        "originX": r["origin_x"],
        "originY": r["origin_y"],
        "repeatWarp": r["repeat_warp"],
        "repeatWeft": r["repeat_weft"],
        "status": r["status"],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
        "archivedAt": r["archived_at"],
        "markCount": mark_count if mark_count is not None else 0,
    }


def get_batch_or_404(batch_id):
    return get_db().execute(
        "SELECT * FROM weave_batches WHERE id = ?", (batch_id,)
    ).fetchone()


@app.get("/api/batches")
def list_batches():
    db = get_db()
    rows = db.execute(
        """
        SELECT b.*, (SELECT COUNT(*) FROM weave_marks m WHERE m.batch_id = b.id) AS mark_count
        FROM weave_batches b ORDER BY b.updated_at DESC
        """
    ).fetchall()
    return jsonify([row_to_batch(r, r["mark_count"]) for r in rows])


@app.post("/api/batches")
def create_batch():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("snapshot"), dict):
        return jsonify(error="请求格式错误：需要草稿快照"), 400
    snap = payload["snapshot"]
    if not isinstance(snap.get("threading"), list) or not isinstance(snap.get("treadling"), list):
        return jsonify(error="快照缺少穿综 / 踩踏数据"), 400

    name = (str(payload.get("name") or "未命名批次")).strip()[:80] or "未命名批次"
    warp_density = finite_float(payload.get("warpDensity"), 0.1, 200.0, 10.0)
    weft_density = finite_float(payload.get("weftDensity"), 0.1, 200.0, 10.0)
    warp_shrink = finite_float(payload.get("warpShrink"), 0.0, 90.0, 0.0)
    weft_shrink = finite_float(payload.get("weftShrink"), 0.0, 90.0, 0.0)
    origin_x = finite_float(payload.get("originX"), -100000.0, 100000.0, 0.0)
    origin_y = finite_float(payload.get("originY"), -100000.0, 100000.0, 0.0)
    draft_id = payload.get("draftId")
    if draft_id is not None:
        try:
            draft_id = int(draft_id)
        except (TypeError, ValueError):
            draft_id = None
    draft_name = (str(payload.get("draftName") or "未保存草稿")).strip()[:80] or "未保存草稿"

    try:
        snap_text = json.dumps(snap, ensure_ascii=False)
    except (TypeError, ValueError):
        return jsonify(error="草稿快照无法序列化"), 400

    rw, rwft = snapshot_repeats(snap)
    db = get_db()
    ts = now_iso()
    cur = db.execute(
        """
        INSERT INTO weave_batches
          (name, draft_id, draft_name, snapshot,
           warp_density, weft_density, warp_shrink, weft_shrink,
           origin_x, origin_y, repeat_warp, repeat_weft,
           status, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL)
        """,
        (name, draft_id, draft_name, snap_text,
         warp_density, weft_density, warp_shrink, weft_shrink,
         origin_x, origin_y, rw, rwft, ts, ts),
    )
    db.commit()
    row = get_batch_or_404(cur.lastrowid)
    return jsonify(row_to_batch(row)), 201


@app.get("/api/batches/<int:batch_id>")
def get_batch(batch_id):
    row = get_batch_or_404(batch_id)
    if row is None:
        return jsonify(error="批次不存在"), 404
    db = get_db()
    marks = db.execute(
        "SELECT * FROM weave_marks WHERE batch_id = ? ORDER BY id", (batch_id,)
    ).fetchall()
    revs = db.execute(
        "SELECT * FROM weave_revisions WHERE batch_id = ? ORDER BY id", (batch_id,)
    ).fetchall()
    try:
        snapshot = json.loads(row["snapshot"])
    except json.JSONDecodeError:
        return jsonify(error="批次快照损坏"), 500
    batch = row_to_batch(row, len(marks))
    batch["snapshot"] = snapshot
    batch["marks"] = [
        {
            "id": m["id"], "type": m["mtype"],
            "mmX": m["mm_x"], "mmY": m["mm_y"],
            "end": m["end"], "pick": m["pick"],
            "note": m["note"],
            "createdAt": m["created_at"], "updatedAt": m["updated_at"],
        }
        for m in marks
    ]
    batch["revisions"] = [
        {
            "id": r["id"], "newDraftId": r["new_draft_id"],
            "action": r["action"], "summary": r["summary"],
            "detail": json.loads(r["detail"] or "{}"),
            "createdAt": r["created_at"],
        }
        for r in revs
    ]
    return jsonify(batch)


@app.post("/api/batches/<int:batch_id>/archive")
def archive_batch(batch_id):
    row = get_batch_or_404(batch_id)
    if row is None:
        return jsonify(error="批次不存在"), 404
    if row["status"] == "archived":
        return jsonify(error="批次已归档，无需重复归档"), 409
    ts = now_iso()
    db = get_db()
    db.execute(
        "UPDATE weave_batches SET status='archived', archived_at=?, updated_at=? WHERE id=?",
        (ts, ts, batch_id),
    )
    db.commit()
    return jsonify(ok=True, archivedAt=ts)


def _editable_batch(batch_id):
    """取出开放中的批次；已归档/不存在返回 (None, error_response)。"""
    row = get_batch_or_404(batch_id)
    if row is None:
        return None, (jsonify(error="批次不存在"), 404)
    if row["status"] == "archived":
        return None, (jsonify(error="批次已归档，标记不可改写"), 409)
    return row, None


def _mark_payload(raw, batch):
    mtype = str(raw.get("type") or "")
    if mtype not in MARK_TYPES:
        return None, "缺陷类型无效（miss/mistread/broken/float）"
    mm_x = finite_float(raw.get("mmX"), -100000.0, 100000.0, None)
    mm_y = finite_float(raw.get("mmY"), -100000.0, 100000.0, None)
    if mm_x is None or mm_y is None:
        return None, "实物坐标无效"
    note = str(raw.get("note") or "")[:500]
    # 序号保留幅外推算值（可能 ≥ 设计尺寸或为负），供跨循环位置分析；
    # 是否越界由前端结合快照尺寸判断（inWarp/inWeft）。
    end = mm_to_index(mm_x, batch["warp_density"], batch["warp_shrink"], batch["origin_x"])
    pick = mm_to_index(mm_y, batch["weft_density"], batch["weft_shrink"], batch["origin_y"])
    return {
        "type": mtype, "mm_x": round(mm_x, 3), "mm_y": round(mm_y, 3),
        "end": end, "pick": pick, "note": note,
    }, None


@app.post("/api/batches/<int:batch_id>/marks")
def add_mark(batch_id):
    row, err = _editable_batch(batch_id)
    if err:
        return err
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="请求格式错误"), 400
    data, error = _mark_payload(payload, row)
    if error:
        return jsonify(error=error), 400
    ts = now_iso()
    db = get_db()
    cur = db.execute(
        """
        INSERT INTO weave_marks (batch_id, mtype, mm_x, mm_y, end, pick, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (batch_id, data["type"], data["mm_x"], data["mm_y"], data["end"], data["pick"],
         data["note"], ts, ts),
    )
    db.execute("UPDATE weave_batches SET updated_at=? WHERE id=?", (ts, batch_id))
    db.commit()
    m = db.execute("SELECT * FROM weave_marks WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({
        "id": m["id"], "type": m["mtype"], "mmX": m["mm_x"], "mmY": m["mm_y"],
        "end": m["end"], "pick": m["pick"], "note": m["note"],
        "createdAt": m["created_at"], "updatedAt": m["updated_at"],
    }), 201


@app.put("/api/batches/<int:batch_id>/marks/<int:mark_id>")
def update_mark(batch_id, mark_id):
    row, err = _editable_batch(batch_id)
    if err:
        return err
    db = get_db()
    m = db.execute(
        "SELECT * FROM weave_marks WHERE id=? AND batch_id=?", (mark_id, batch_id)
    ).fetchone()
    if m is None:
        return jsonify(error="标记不存在"), 404
    payload = request.get_json(silent=True) or {}

    mtype = payload.get("type", m["mtype"])
    if mtype not in MARK_TYPES:
        return jsonify(error="缺陷类型无效"), 400
    mm_x = finite_float(payload.get("mmX", m["mm_x"]), -100000.0, 100000.0, m["mm_x"])
    mm_y = finite_float(payload.get("mmY", m["mm_y"]), -100000.0, 100000.0, m["mm_y"])
    note = str(payload.get("note", m["note"]))[:500]

    # 保留幅外推算序号（≥ 尺寸或为负均保留），跨循环分析需要真实循环砖编号
    end = mm_to_index(mm_x, row["warp_density"], row["warp_shrink"], row["origin_x"])
    pick = mm_to_index(mm_y, row["weft_density"], row["weft_shrink"], row["origin_y"])
    ts = now_iso()
    db.execute(
        "UPDATE weave_marks SET mtype=?, mm_x=?, mm_y=?, end=?, pick=?, note=?, updated_at=? WHERE id=?",
        (mtype, round(mm_x, 3), round(mm_y, 3), end, pick, note, ts, mark_id),
    )
    db.execute("UPDATE weave_batches SET updated_at=? WHERE id=?", (ts, batch_id))
    db.commit()
    m2 = db.execute("SELECT * FROM weave_marks WHERE id=?", (mark_id,)).fetchone()
    return jsonify({
        "id": m2["id"], "type": m2["mtype"], "mmX": m2["mm_x"], "mmY": m2["mm_y"],
        "end": m2["end"], "pick": m2["pick"], "note": m2["note"],
        "createdAt": m2["created_at"], "updatedAt": m2["updated_at"],
    })


@app.delete("/api/batches/<int:batch_id>/marks/<int:mark_id>")
def delete_mark(batch_id, mark_id):
    _row, err = _editable_batch(batch_id)
    if err:
        return err
    db = get_db()
    cur = db.execute(
        "DELETE FROM weave_marks WHERE id=? AND batch_id=?", (mark_id, batch_id)
    )
    if cur.rowcount == 0:
        return jsonify(error="标记不存在"), 404
    db.execute("UPDATE weave_batches SET updated_at=? WHERE id=?", (now_iso(), batch_id))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/batches/<int:batch_id>/revisions")
def add_revision(batch_id):
    row = get_batch_or_404(batch_id)
    if row is None:
        return jsonify(error="批次不存在"), 404
    # 归档批次只读：修订记录属于批次数据，服务端必须拒绝（不依赖界面禁用）
    if row["status"] == "archived":
        return jsonify(error="批次已归档，不能再记录修订"), 409
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="请求格式错误"), 400
    action = str(payload.get("action") or "")
    if action not in ("threading", "tieup", "treadling"):
        return jsonify(error="修订类型无效（threading/tieup/treadling）"), 400
    summary = str(payload.get("summary") or "")[:300]
    detail = payload.get("detail")
    if not isinstance(detail, dict):
        return jsonify(error="修订明细缺失"), 400
    new_draft_id = payload.get("newDraftId")
    if new_draft_id is not None:
        try:
            new_draft_id = int(new_draft_id)
        except (TypeError, ValueError):
            new_draft_id = None
    ts = now_iso()
    db = get_db()
    cur = db.execute(
        """
        INSERT INTO weave_revisions (batch_id, new_draft_id, action, summary, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (batch_id, new_draft_id, action, summary,
         json.dumps(detail, ensure_ascii=False), ts),
    )
    db.execute("UPDATE weave_batches SET updated_at=? WHERE id=?", (ts, batch_id))
    db.commit()
    return jsonify({
        "id": cur.lastrowid, "newDraftId": new_draft_id,
        "action": action, "summary": summary, "detail": detail, "createdAt": ts,
    }), 201


# --------------------------------------------------------------------------- #
# 上机工艺单
# --------------------------------------------------------------------------- #
STEP_KINDS = ("warp", "thread", "dent")


def _json_text(obj, field):
    """把请求中的 JSON 子对象序列化为存储文本；失败返回 None。"""
    try:
        return json.dumps(obj, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def step_signature(kind, label, detail):
    """步骤签名：种类 + 区段内容。复制新版时用于判定原单步骤是否失效。"""
    canon = json.dumps(detail, ensure_ascii=False, sort_keys=True)
    return f"{kind}|{label}|{canon}"


def row_to_sheet(r, step_count=0, done_count=0, stale_count=0):
    return {
        "id": r["id"],
        "name": r["name"],
        "draftId": r["draft_id"],
        "draftName": r["draft_name"],
        "fingerprint": r["fingerprint"],
        "version": r["version"],
        "parentId": r["parent_id"],
        "status": r["status"],
        "stepCount": step_count,
        "doneCount": done_count,
        "staleCount": stale_count,
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


def row_to_step(s):
    return {
        "id": s["id"],
        "index": s["step_index"],
        "kind": s["kind"],
        "label": s["label"],
        "detail": json.loads(s["detail"]),
        "done": bool(s["done"]),
        "doneAt": s["done_at"],
        "stale": bool(s["stale"]),
    }


def get_sheet_or_none(sheet_id):
    return get_db().execute(
        "SELECT * FROM loom_sheets WHERE id = ?", (sheet_id,)
    ).fetchone()


def _valid_steps(raw_steps):
    """规整客户端生成的步骤序列；返回 (steps, error)。"""
    if not isinstance(raw_steps, list) or not raw_steps:
        return None, "步骤序列缺失"
    if len(raw_steps) > 2000:
        return None, "步骤数量过多"
    steps = []
    for i, st in enumerate(raw_steps):
        if not isinstance(st, dict):
            return None, f"第 {i + 1} 个步骤格式错误"
        kind = str(st.get("kind") or "")
        if kind not in STEP_KINDS:
            return None, f"第 {i + 1} 个步骤类型无效（warp/thread/dent）"
        label = str(st.get("label") or "")[:300]
        detail = st.get("detail")
        if not isinstance(detail, dict):
            return None, f"第 {i + 1} 个步骤缺少区段明细"
        detail_text = _json_text(detail, "detail")
        if detail_text is None:
            return None, f"第 {i + 1} 个步骤明细无法序列化"
        steps.append({"kind": kind, "label": label, "detail": detail,
                      "detail_text": detail_text})
    return steps, None


def _sheet_payload(payload):
    """校验并规整“冻结工艺单”请求体；返回 (fields, error)。"""
    if not isinstance(payload, dict):
        return None, "请求格式错误"
    snap = payload.get("snapshot")
    if not isinstance(snap, dict) or not isinstance(snap.get("threading"), list) \
            or not isinstance(snap.get("treadling"), list):
        return None, "快照缺少穿综 / 踩踏数据"
    fields = {
        "name": (str(payload.get("name") or "未命名工艺单")).strip()[:80] or "未命名工艺单",
        "draftName": (str(payload.get("draftName") or "未保存草稿")).strip()[:80] or "未保存草稿",
    }
    draft_id = payload.get("draftId")
    if draft_id is not None:
        try:
            draft_id = int(draft_id)
        except (TypeError, ValueError):
            draft_id = None
    fields["draftId"] = draft_id
    for key in ("snapshot", "params", "derived", "reedPlan"):
        text = _json_text(payload.get(key), key)
        if text is None or payload.get(key) is None:
            return None, f"{key} 缺失或无法序列化"
        fields[key] = text
    fp = str(payload.get("fingerprint") or "")
    fields["fingerprint"] = fp[:4000]
    steps, err = _valid_steps(payload.get("steps"))
    if err:
        return None, err
    fields["steps"] = steps
    return fields, None


def _insert_sheet(db, f, version, parent_id):
    ts = now_iso()
    cur = db.execute(
        """
        INSERT INTO loom_sheets
          (name, draft_id, draft_name, snapshot, params, derived, reed_plan,
           fingerprint, version, parent_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
        """,
        (f["name"], f["draftId"], f["draftName"], f["snapshot"], f["params"],
         f["derived"], f["reedPlan"], f["fingerprint"], version, parent_id, ts, ts),
    )
    sheet_id = cur.lastrowid
    for i, st in enumerate(f["steps"]):
        db.execute(
            """
            INSERT INTO loom_steps (sheet_id, step_index, kind, label, detail,
                                    done, done_at, stale)
            VALUES (?, ?, ?, ?, ?, 0, NULL, 0)
            """,
            (sheet_id, i, st["kind"], st["label"], st["detail_text"]),
        )
    return sheet_id, ts


@app.get("/api/sheets")
def list_sheets():
    db = get_db()
    rows = db.execute(
        """
        SELECT s.*,
          (SELECT COUNT(*) FROM loom_steps t WHERE t.sheet_id = s.id) AS step_count,
          (SELECT COUNT(*) FROM loom_steps t WHERE t.sheet_id = s.id AND t.done = 1) AS done_count,
          (SELECT COUNT(*) FROM loom_steps t WHERE t.sheet_id = s.id AND t.stale = 1) AS stale_count
        FROM loom_sheets s ORDER BY s.updated_at DESC, s.id DESC
        """
    ).fetchall()
    return jsonify([
        row_to_sheet(r, r["step_count"], r["done_count"], r["stale_count"]) for r in rows
    ])


@app.post("/api/sheets")
def create_sheet():
    f, err = _sheet_payload(request.get_json(silent=True))
    if err:
        return jsonify(error=err), 400
    db = get_db()
    sheet_id, ts = _insert_sheet(db, f, version=1, parent_id=None)
    db.commit()
    row = get_sheet_or_none(sheet_id)
    return jsonify(row_to_sheet(row, len(f["steps"]), 0, 0)), 201


@app.get("/api/sheets/<int:sheet_id>")
def get_sheet(sheet_id):
    row = get_sheet_or_none(sheet_id)
    if row is None:
        return jsonify(error="工艺单不存在"), 404
    steps = get_db().execute(
        "SELECT * FROM loom_steps WHERE sheet_id = ? ORDER BY step_index", (sheet_id,)
    ).fetchall()
    try:
        sheet = row_to_sheet(row, len(steps),
                             sum(1 for s in steps if s["done"]),
                             sum(1 for s in steps if s["stale"]))
        sheet["snapshot"] = json.loads(row["snapshot"])
        sheet["params"] = json.loads(row["params"])
        sheet["derived"] = json.loads(row["derived"])
        sheet["reedPlan"] = json.loads(row["reed_plan"])
    except json.JSONDecodeError:
        return jsonify(error="工艺单数据损坏"), 500
    sheet["steps"] = [row_to_step(s) for s in steps]
    return jsonify(sheet)


@app.delete("/api/sheets/<int:sheet_id>")
def delete_sheet(sheet_id):
    db = get_db()
    cur = db.execute("DELETE FROM loom_sheets WHERE id = ?", (sheet_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="工艺单不存在"), 404
    return jsonify(ok=True)


def _ordered_steps(db, sheet_id):
    return db.execute(
        "SELECT * FROM loom_steps WHERE sheet_id = ? ORDER BY step_index", (sheet_id,)
    ).fetchall()


@app.post("/api/sheets/<int:sheet_id>/steps/<int:step_id>/done")
def done_step(sheet_id, step_id):
    row = get_sheet_or_none(sheet_id)
    if row is None:
        return jsonify(error="工艺单不存在"), 404
    db = get_db()
    steps = _ordered_steps(db, sheet_id)
    target = next((s for s in steps if s["id"] == step_id), None)
    if target is None:
        return jsonify(error="步骤不存在"), 404
    if target["done"]:
        return jsonify(error="该步骤已确认"), 409
    if target["stale"]:
        return jsonify(error="该步骤已失效（草稿或参数已出新版），请改用新版工艺单"), 409
    # 顺序确认：前面不允许存在未确认步骤
    if any(s["step_index"] < target["step_index"] and not s["done"] for s in steps):
        return jsonify(error="请按顺序确认：前面还有未完成的步骤"), 409
    ts = now_iso()
    db.execute("UPDATE loom_steps SET done=1, done_at=? WHERE id=?", (ts, step_id))
    db.execute("UPDATE loom_sheets SET updated_at=? WHERE id=?", (ts, sheet_id))
    db.commit()
    s = db.execute("SELECT * FROM loom_steps WHERE id=?", (step_id,)).fetchone()
    return jsonify(row_to_step(s))


@app.post("/api/sheets/<int:sheet_id>/steps/<int:step_id>/undo")
def undo_step(sheet_id, step_id):
    row = get_sheet_or_none(sheet_id)
    if row is None:
        return jsonify(error="工艺单不存在"), 404
    db = get_db()
    steps = _ordered_steps(db, sheet_id)
    target = next((s for s in steps if s["id"] == step_id), None)
    if target is None:
        return jsonify(error="步骤不存在"), 404
    if not target["done"]:
        return jsonify(error="该步骤尚未确认"), 409
    # 倒序撤回：后面不允许存在仍已确认的步骤
    if any(s["step_index"] > target["step_index"] and s["done"] for s in steps):
        return jsonify(error="只能倒序撤回：请先撤回后面的步骤"), 409
    ts = now_iso()
    db.execute("UPDATE loom_steps SET done=0, done_at=NULL WHERE id=?", (step_id,))
    db.execute("UPDATE loom_sheets SET updated_at=? WHERE id=?", (ts, sheet_id))
    db.commit()
    s = db.execute("SELECT * FROM loom_steps WHERE id=?", (step_id,)).fetchone()
    return jsonify(row_to_step(s))


@app.post("/api/sheets/<int:sheet_id>/copy")
def copy_sheet(sheet_id):
    """复制新版：原单不改写；原单中与新单步骤签名不符的步骤标记为失效。"""
    old = get_sheet_or_none(sheet_id)
    if old is None:
        return jsonify(error="工艺单不存在"), 404
    f, err = _sheet_payload(request.get_json(silent=True))
    if err:
        return jsonify(error=err), 400
    db = get_db()
    new_id, ts = _insert_sheet(db, f, version=old["version"] + 1, parent_id=sheet_id)

    # 新单步骤签名集合
    new_sigs = {
        step_signature(st["kind"], st["label"], st["detail"]) for st in f["steps"]
    }
    old_steps = _ordered_steps(db, sheet_id)
    stale_count = 0
    for s in old_steps:
        try:
            detail = json.loads(s["detail"])
        except json.JSONDecodeError:
            detail = {}
        sig = step_signature(s["kind"], s["label"], detail)
        if sig not in new_sigs and not s["stale"]:
            db.execute("UPDATE loom_steps SET stale=1 WHERE id=?", (s["id"],))
            stale_count += 1
    db.execute("UPDATE loom_sheets SET updated_at=? WHERE id=?", (ts, sheet_id))
    db.commit()
    row = get_sheet_or_none(new_id)
    return jsonify({
        "sheet": row_to_sheet(row, len(f["steps"]), 0, 0),
        "parentId": sheet_id,
        "staleCount": stale_count,
    }), 201


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
