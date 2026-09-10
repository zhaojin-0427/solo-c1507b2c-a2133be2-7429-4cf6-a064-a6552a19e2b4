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

所有静态资源均位于 static/ 目录，无外部 CDN 依赖，可离线运行。
草稿持久化到 SQLite（instance/drafts.db）。
"""

import json
import os
import sqlite3
from datetime import datetime

from flask import Flask, g, jsonify, render_template, request

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


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
