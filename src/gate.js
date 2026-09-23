
// 签发门：只有前序证据与当前窗口同时成立，动作才可签发。
// 所有判定为纯函数式读取；租约占用判定由签发事务在 BEGIN IMMEDIATE 内调用。

const CHAIN = ["dispatch", "transship", "hoist", "install"];
const ACTION_LABELS = {
  dispatch: "发运（浅水运输）",
  transship: "倒驳",
  hoist: "起吊",
  install: "安装就位",
};

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function ms(value) {
  return value == null ? null : Date.parse(value);
}

function blocker(code, detail = null) {
  return { code, detail };
}

// 取某节段某类证据的最新一条（按 recorded_at）
function latestEvidence(db, segmentRef, revision, kind) {
  return db
    .prepare(
      `SELECT * FROM evidence
       WHERE segment_ref = ? AND revision = ? AND kind = ?
       ORDER BY recorded_at DESC, evidence_id DESC LIMIT 1`
    )
    .get(segmentRef, revision, kind);
}

// 全局证据（如环保豁免），允许与动作时段相交的有效记录
function validGlobalEvidence(db, kind, startMs, endMs) {
  const rows = db
    .prepare(
      `SELECT * FROM evidence
       WHERE segment_ref IS NULL AND kind = ? AND result = 'pass'
       ORDER BY recorded_at DESC`
    )
    .all(kind);
  return rows.find((row) => {
    const from = ms(row.valid_from);
    const until = ms(row.valid_until);
    return (from == null || from <= endMs) && (until == null || until >= startMs);
  });
}

function checkEvidence(row, label, startMs) {
  if (!row) return blocker("evidence_missing", { kind: label });
  if (row.result === "fail") return blocker("evidence_failed", { kind: label, ref: row.ref });
  if (row.result !== "pass") return blocker("evidence_not_passed", { kind: label, result: row.result });
  const until = ms(row.valid_until);
  if (until != null && until < startMs) {
    return blocker("evidence_expired", { kind: label, valid_until: row.valid_until });
  }
  return null;
}

function previousAction(action) {
  const index = CHAIN.indexOf(action);
  return index <= 0 ? null : CHAIN[index - 1];
}

function findCoveringWindow(db, request, startMs, endMs) {
  let windows;
  if (request.window_ref) {
    windows = db
      .prepare("SELECT * FROM water_windows WHERE window_ref = ?")
      .all(request.window_ref);
  } else {
    windows = db.prepare("SELECT * FROM water_windows WHERE status = 'active'").all();
  }
  return windows.find((window) => {
    if (window.status !== "active") return false;
    if (!(ms(window.starts_at) <= startMs && endMs <= ms(window.ends_at))) return false;
    const detail = parseJson(request.detail, {}) || {};
    if (detail.forecast_level != null) {
      if (window.level_min != null && detail.forecast_level < window.level_min) return false;
      if (window.level_max != null && detail.forecast_level > window.level_max) return false;
    }
    return true;
  });
}

function checkEnvironment(db, startMs, endMs) {
  const restrictions = db
    .prepare("SELECT * FROM environmental_restrictions")
    .all()
    .filter((row) => ms(row.starts_at) < endMs && startMs < ms(row.ends_at));
  for (const restriction of restrictions) {
    if (restriction.level === "prohibit") {
      return blocker("environmental_prohibited", {
        restriction_id: restriction.restriction_id,
        kind: restriction.kind,
        window: [restriction.starts_at, restriction.ends_at],
      });
    }
    if (restriction.level === "restrict") {
      const waiver = validGlobalEvidence(db, "environmental_waiver", startMs, endMs);
      if (!waiver) {
        return blocker("environmental_waiver_missing", {
          restriction_id: restriction.restriction_id,
          kind: restriction.kind,
        });
      }
    }
  }
  return null;
}

function latestRecheck(db, resourceType, resourceRef) {
  return db
    .prepare(
      `SELECT * FROM resource_rechecks
       WHERE resource_type = ? AND resource_ref = ?
       ORDER BY recorded_at DESC, recheck_id DESC LIMIT 1`
    )
    .get(resourceType, resourceRef);
}

function checkLeaseConflict(db, resourceType, resourceRef, startMs, endMs, excludeRequestRef) {
  const leases = db
    .prepare(
      `SELECT * FROM resource_leases
       WHERE resource_type = ? AND resource_ref = ? AND released_at IS NULL`
    )
    .all(resourceType, resourceRef);
  return leases.find(
    (lease) =>
      lease.request_ref !== excludeRequestRef &&
      ms(lease.starts_at) < endMs &&
      startMs < ms(lease.ends_at)
  );
}

function evaluateGate(db, request, options = {}) {
  const blockers = [];
  const checks = {};
  const startMs = ms(request.scheduled_start);
  const endMs = ms(request.scheduled_end);
  const detail = parseJson(request.detail, {}) || {};
  const now = options.nowMs ?? Date.now();

  // 1. 构件与版本
  const segment = db
    .prepare("SELECT * FROM segments WHERE segment_ref = ?")
    .get(request.segment_ref);
  if (!segment) {
    blockers.push(blocker("segment_unknown", { segment_ref: request.segment_ref }));
  } else {
    checks.revision = {
      requested: request.revision,
      current: segment.current_revision,
    };
    if (segment.current_revision !== request.revision) {
      blockers.push(
        blocker("revision_mismatch", {
          requested: request.revision,
          current: segment.current_revision,
        })
      );
    }
  }
  const revisionRow = segment
    ? db
        .prepare(
          "SELECT * FROM segment_revisions WHERE segment_ref = ? AND revision = ?"
        )
        .get(request.segment_ref, request.revision)
    : null;
  if (segment && !revisionRow) {
    blockers.push(blocker("revision_unknown", { revision: request.revision }));
  }

  // 2. 动作链前序
  const prev = previousAction(request.action);
  if (prev) {
    const prevRequest = db
      .prepare(
        `SELECT * FROM action_requests
         WHERE segment_ref = ? AND revision = ? AND action = ? AND status = 'completed'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(request.segment_ref, request.revision, prev);
    checks.previous_action = { action: prev, completed: Boolean(prevRequest) };
    if (!prevRequest) blockers.push(blocker("previous_action_incomplete", { action: prev }));
  }

  // 3. 证据
  const requiredEvidence = {
    dispatch: ["fabrication_acceptance", "preassembly_acceptance"],
    transship: [],
    hoist: ["preassembly_acceptance", "transfer_handover"],
    install: [],
  }[request.action];
  checks.evidence = {};
  for (const kind of requiredEvidence) {
    const row = latestEvidence(db, request.segment_ref, request.revision, kind);
    checks.evidence[kind] = row ? { result: row.result, ref: row.ref } : null;
    const failure = checkEvidence(row, kind, startMs);
    if (failure) blockers.push(failure);
  }

  // 4. 水位窗口（调度窗口必须完整覆盖计划时段）
  checks.window = null;
  const window = findCoveringWindow(db, request, startMs, endMs);
  if (!window) {
    blockers.push(
      blocker("window_not_covered", { window_ref: request.window_ref || null })
    );
  } else {
    checks.window = {
      window_ref: window.window_ref,
      starts_at: window.starts_at,
      ends_at: window.ends_at,
      level_min: window.level_min,
      level_max: window.level_max,
    };
  }

  // 5. 环保禁限时段
  const environmentalFailure = checkEnvironment(db, startMs, endMs);
  if (environmentalFailure) blockers.push(environmentalFailure);

  // 6. 船舶：状态、复检、载荷、吃水与航道水深
  if (request.action === "dispatch" || request.action === "transship") {
    const vesselRef = request.vessel_ref || detail.vessel_ref;
    if (!vesselRef) {
      blockers.push(blocker("vessel_required", null));
    } else {
      const vessel = db.prepare("SELECT * FROM vessels WHERE vessel_ref = ?").get(vesselRef);
      if (!vessel) {
        blockers.push(blocker("vessel_unknown", { vessel_ref: vesselRef }));
      } else {
        if (vessel.status !== "available") {
          blockers.push(blocker("vessel_unavailable", { vessel_ref: vesselRef, status: vessel.status }));
        }
        const recheck = latestRecheck(db, "vessel", vesselRef);
        checks.vessel_recheck = recheck ? { result: recheck.result, at: recheck.recorded_at } : null;
        if (recheck && recheck.result === "fail") {
          blockers.push(blocker("vessel_recheck_failed", { vessel_ref: vesselRef }));
        }
        const loading = db
          .prepare(
            `SELECT * FROM vessel_loadings
             WHERE vessel_ref = ? AND segment_ref = ? AND revision = ?
             ORDER BY recorded_at DESC, loading_id DESC LIMIT 1`
          )
          .get(vesselRef, request.segment_ref, request.revision);
        if (!loading) {
          blockers.push(blocker("loading_not_recorded", { vessel_ref: vesselRef }));
        } else {
          checks.loading = { load: loading.load, draft: loading.draft };
          if (loading.load > vessel.max_load) {
            blockers.push(
              blocker("vessel_overloaded", {
                load: loading.load,
                max_load: vessel.max_load,
              })
            );
          }
          if (loading.draft > vessel.max_draft) {
            blockers.push(
              blocker("vessel_draft_exceeds", {
                draft: loading.draft,
                max_draft: vessel.max_draft,
              })
            );
          }
          const margin = detail.draft_margin ?? 0;
          const pointRefs = detail.point_refs || [];
          checks.channel = [];
          for (const pointRef of pointRefs) {
            const point = db
              .prepare("SELECT * FROM channel_readings WHERE point_ref = ?")
              .get(pointRef);
            if (!point) {
              blockers.push(blocker("channel_reading_missing", { point_ref: pointRef }));
              continue;
            }
            checks.channel.push({ point_ref: pointRef, depth: point.depth });
            if (point.depth < loading.draft + margin) {
              blockers.push(
                blocker("channel_too_shallow", {
                  point_ref: pointRef,
                  depth: point.depth,
                  draft: loading.draft,
                  margin,
                })
              );
            }
          }
          if (pointRefs.length === 0) {
            blockers.push(blocker("channel_points_required", null));
          }
        }
        const conflict = checkLeaseConflict(
          db,
          "vessel",
          vesselRef,
          startMs,
          endMs,
          request.request_ref
        );
        if (conflict) blockers.push(blocker("vessel_lease_conflict", { request_ref: conflict.request_ref }));
      }
    }
  }

  // 7. 缆索吊：状态、复检、能力
  if (request.action === "hoist" || request.action === "install") {
    const hoistRef = request.hoist_ref || detail.hoist_ref;
    if (!hoistRef) {
      blockers.push(blocker("hoist_required", null));
    } else {
      const hoist = db.prepare("SELECT * FROM hoists WHERE hoist_ref = ?").get(hoistRef);
      if (!hoist) {
        blockers.push(blocker("hoist_unknown", { hoist_ref: hoistRef }));
      } else {
        if (hoist.status !== "available") {
          blockers.push(blocker("hoist_unavailable", { hoist_ref: hoistRef, status: hoist.status }));
        }
        const recheck = latestRecheck(db, "hoist", hoistRef);
        checks.hoist_recheck = recheck ? { result: recheck.result, at: recheck.recorded_at } : null;
        if (recheck && recheck.result === "fail") {
          blockers.push(blocker("hoist_recheck_failed", { hoist_ref: hoistRef }));
        }
        if (revisionRow && revisionRow.weight > hoist.capacity) {
          blockers.push(
            blocker("hoist_capacity_exceeded", {
              weight: revisionRow.weight,
              capacity: hoist.capacity,
            })
          );
        }
        checks.hoist = { capacity: hoist.capacity };
        const conflict = checkLeaseConflict(
          db,
          "hoist",
          hoistRef,
          startMs,
          endMs,
          request.request_ref
        );
        if (conflict) blockers.push(blocker("hoist_lease_conflict", { request_ref: conflict.request_ref }));
      }
    }
  }

  // 8. 两岸就位条件（安装）
  if (request.action === "install") {
    const bankRefs = detail.bank_refs || [];
    checks.banks = [];
    if (bankRefs.length === 0) blockers.push(blocker("banks_required", null));
    for (const bankRef of bankRefs) {
      const bank = db.prepare("SELECT * FROM banks WHERE bank_ref = ?").get(bankRef);
      if (!bank) {
        blockers.push(blocker("bank_unknown", { bank_ref: bankRef }));
        continue;
      }
      checks.banks.push({ bank_ref: bankRef, ready: Boolean(bank.ready) });
      if (!bank.ready) blockers.push(blocker("bank_not_ready", { bank_ref: bankRef }));
    }

    // 安装序列：所有序号在前的节段必须已安装
    if (segment) {
      const predecessors = db
        .prepare(
          `SELECT s.segment_ref, s.install_order,
                  (SELECT COUNT(*) FROM action_requests a
                    WHERE a.segment_ref = s.segment_ref
                      AND a.revision = s.current_revision
                      AND a.action = 'install' AND a.status = 'completed') AS done
           FROM segments s WHERE s.install_order < ?`
        )
        .all(segment.install_order);
      const waiting = predecessors.filter((row) => row.done === 0);
      checks.install_sequence = {
        order: segment.install_order,
        waiting: waiting.map((row) => row.segment_ref),
      };
      if (waiting.length > 0) {
        blockers.push(
          blocker("install_sequence_blocked", {
            waiting: waiting.map((row) => row.segment_ref),
          })
        );
      }
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    checks,
    evaluated_at: new Date(now).toISOString(),
  };
}

module.exports = { CHAIN, ACTION_LABELS, evaluateGate, ms };
