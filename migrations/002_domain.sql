-- 乌江桥节段协同：构件版本、证据链、窗口、船机岸条件、申请/许可/租约、变更影响

CREATE TABLE IF NOT EXISTS segments (
    segment_ref      TEXT PRIMARY KEY,
    install_order    INTEGER NOT NULL UNIQUE,
    name             TEXT,
    current_revision INTEGER,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segment_revisions (
    segment_ref TEXT NOT NULL REFERENCES segments(segment_ref),
    revision    INTEGER NOT NULL,
    weight      REAL NOT NULL,
    length_m    REAL,
    detail      TEXT, -- JSON：几何、材质等附加属性
    created_at  TEXT NOT NULL,
    PRIMARY KEY (segment_ref, revision)
);

-- 证据只保存受控引用或 sha256 摘要，不存放原始材料
CREATE TABLE IF NOT EXISTS evidence (
    evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_ref TEXT,            -- 环保豁免等全局证据允许为空
    revision    INTEGER,         -- 绑定构件版本
    kind        TEXT NOT NULL,   -- fabrication_acceptance/preassembly_acceptance/transfer_handover/environmental_waiver/reinspection ...
    result      TEXT NOT NULL,   -- pass | fail | note
    ref         TEXT,
    sha256      TEXT,
    valid_from  TEXT,
    valid_until TEXT,
    recorded_by TEXT,
    recorded_at TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_segment ON evidence(segment_ref, revision, kind, recorded_at);

CREATE TABLE IF NOT EXISTS water_windows (
    window_ref TEXT PRIMARY KEY,
    starts_at  TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    level_min  REAL,
    level_max  REAL,
    source     TEXT,
    status     TEXT NOT NULL DEFAULT 'active', -- active | superseded | cancelled
    replaced_by TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environmental_restrictions (
    restriction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    starts_at      TEXT NOT NULL,
    ends_at        TEXT NOT NULL,
    kind           TEXT,
    level          TEXT NOT NULL, -- prohibit（禁止，不可豁免） | restrict（限制，凭豁免放行）
    note           TEXT,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vessels (
    vessel_ref TEXT PRIMARY KEY,
    max_load   REAL NOT NULL,
    max_draft  REAL NOT NULL,
    status     TEXT NOT NULL DEFAULT 'available', -- available | maintenance | out_of_service
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vessel_loadings (
    loading_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    vessel_ref  TEXT NOT NULL,
    segment_ref TEXT NOT NULL,
    revision    INTEGER NOT NULL,
    load        REAL NOT NULL,
    draft       REAL NOT NULL,
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loading_latest ON vessel_loadings(vessel_ref, segment_ref, revision, recorded_at);

CREATE TABLE IF NOT EXISTS channel_readings (
    point_ref   TEXT PRIMARY KEY,
    depth       REAL NOT NULL,
    recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hoists (
    hoist_ref  TEXT PRIMARY KEY,
    capacity   REAL NOT NULL,
    status     TEXT NOT NULL DEFAULT 'available', -- available | maintenance | out_of_service
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banks (
    bank_ref   TEXT PRIMARY KEY,
    side       TEXT,                              -- north | south
    ready      INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_rechecks (
    recheck_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_type TEXT NOT NULL,                  -- vessel | hoist | bank
    resource_ref  TEXT NOT NULL,
    result      TEXT NOT NULL,                    -- pass | fail
    note        TEXT,
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recheck_resource ON resource_rechecks(resource_type, resource_ref, recorded_at);

CREATE TABLE IF NOT EXISTS action_requests (
    request_ref     TEXT PRIMARY KEY,
    segment_ref     TEXT NOT NULL,
    revision        INTEGER NOT NULL,
    action          TEXT NOT NULL,               -- dispatch | transship | hoist | install
    vessel_ref      TEXT,
    hoist_ref       TEXT,
    window_ref      TEXT,
    scheduled_start TEXT NOT NULL,
    scheduled_end   TEXT NOT NULL,
    detail          TEXT,                        -- JSON：point_refs / bank_refs 等
    requester       TEXT,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | issued | suspended | completed | cancelled
    gate_snapshot   TEXT,                        -- 最近一次闸门判定的条件与阻塞项快照
    decision_note   TEXT,
    decided_by      TEXT,
    decided_at      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_segment ON action_requests(segment_ref, revision, action);
CREATE INDEX IF NOT EXISTS idx_requests_status ON action_requests(status);

-- 同一吊装/船舶资源的时间互斥占用，在签发事务内按区间判定
CREATE TABLE IF NOT EXISTS resource_leases (
    lease_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_type TEXT NOT NULL,                 -- vessel | hoist
    resource_ref  TEXT NOT NULL,
    request_ref TEXT NOT NULL,
    starts_at   TEXT NOT NULL,
    ends_at     TEXT NOT NULL,
    granted_at  TEXT NOT NULL,
    released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lease_lookup ON resource_leases(resource_type, resource_ref, released_at);

CREATE TABLE IF NOT EXISTS change_events (
    change_ref TEXT PRIMARY KEY,
    type       TEXT NOT NULL,                    -- water | equipment | reinspection
    summary    TEXT,
    payload    TEXT NOT NULL,                    -- JSON
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_impacts (
    impact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    change_ref    TEXT NOT NULL,
    request_ref   TEXT,
    segment_ref   TEXT,
    action        TEXT,
    before_status TEXT,
    after_status  TEXT,
    blockers      TEXT,                          -- JSON
    detail        TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impacts_change ON change_impacts(change_ref);
CREATE INDEX IF NOT EXISTS idx_impacts_request ON change_impacts(request_ref);
CREATE INDEX IF NOT EXISTS idx_impacts_segment ON change_impacts(segment_ref);

-- 请求生命周期事件：申请、签发、挂起、恢复、完成、取消，供节点反查
CREATE TABLE IF NOT EXISTS request_events (
    event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    request_ref TEXT NOT NULL,
    segment_ref TEXT NOT NULL,
    revision    INTEGER NOT NULL,
    action      TEXT NOT NULL,
    event       TEXT NOT NULL,
    gate        TEXT,
    note        TEXT,
    actor       TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_segment ON request_events(segment_ref, revision, event_id);
