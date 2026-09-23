-- 乌江桥节段水运吊装协同：领域结构
-- 主线：构件版本（segment_revisions）+ 既定安装序列（install_plan）
-- 证据只追加（evidence_events），复检以“指向旧证据的新事件”表达，不覆盖历史。

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_domain');

-- 节段主档：当前版本与合龙序列位置
CREATE TABLE IF NOT EXISTS segments (
    segment_ref      TEXT PRIMARY KEY,
    revision         INTEGER NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'registered',
    install_order    INTEGER,
    closure_group    TEXT NOT NULL DEFAULT 'main',
    weight_t         REAL NOT NULL DEFAULT 0,
    length_m         REAL,
    updated_at       TEXT NOT NULL
);

-- 构件版本历史
CREATE TABLE IF NOT EXISTS segment_revisions (
    segment_ref      TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    weight_t         REAL NOT NULL,
    length_m         REAL,
    note             TEXT,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (segment_ref, revision)
);

-- 既定安装序列（合龙顺序）
CREATE TABLE IF NOT EXISTS install_plan (
    closure_group    TEXT NOT NULL,
    install_order    INTEGER NOT NULL,
    segment_ref      TEXT NOT NULL,
    planned_time     TEXT,
    PRIMARY KEY (closure_group, install_order),
    UNIQUE (closure_group, segment_ref)
);

-- 只追加证据事件：制造 / 预拼验收 / 运输 / 倒驳交接 / 安装 / 复检
CREATE TABLE IF NOT EXISTS evidence_events (
    event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_ref       TEXT NOT NULL,
    revision          INTEGER NOT NULL,
    stage             TEXT NOT NULL,   -- fabricated|accepted|transported|transferred|installed
    event_type        TEXT NOT NULL,
    occurred_at       TEXT NOT NULL,
    recorded_at       TEXT NOT NULL,
    actor_ref         TEXT,
    payload_json      TEXT NOT NULL DEFAULT '{}',
    source_digest     TEXT,            -- 原始材料 sha256 摘要或受控引用
    supersedes_event  INTEGER,         -- 复检事件指向被复检的旧证据
    disposition       TEXT             -- 仅复检使用：pass|fail
);
CREATE INDEX IF NOT EXISTS idx_events_segment ON evidence_events(segment_ref, event_id);

-- 运输船 / 驳船
CREATE TABLE IF NOT EXISTS vessels (
    vessel_ref    TEXT PRIMARY KEY,
    kind          TEXT NOT NULL DEFAULT 'vessel', -- vessel|barge
    name          TEXT,
    capacity_t    REAL NOT NULL,
    draft_m       REAL NOT NULL,
    status        TEXT NOT NULL DEFAULT 'available', -- available|out_of_service
    note          TEXT,
    updated_at    TEXT NOT NULL
);

-- 缆索吊（吊装资源）
CREATE TABLE IF NOT EXISTS hoists (
    hoist_ref     TEXT PRIMARY KEY,
    name          TEXT,
    capacity_t    REAL NOT NULL,
    status        TEXT NOT NULL DEFAULT 'available',
    note          TEXT,
    updated_at    TEXT NOT NULL
);

-- 两岸起吊条件
CREATE TABLE IF NOT EXISTS banks (
    bank_ref      TEXT PRIMARY KEY, -- NORTH|SOUTH
    name          TEXT,
    ready         INTEGER NOT NULL DEFAULT 0,
    ready_since   TEXT,
    note          TEXT,
    updated_at    TEXT NOT NULL
);

-- 水位窗口（水电站调度发布；变化时以新窗口取代旧窗口，旧窗口留痕）
CREATE TABLE IF NOT EXISTS water_windows (
    window_ref     TEXT PRIMARY KEY,
    channel_ref    TEXT NOT NULL,
    level_m        REAL,
    min_depth_m    REAL NOT NULL,
    starts_at      TEXT NOT NULL,
    ends_at        TEXT NOT NULL,
    source         TEXT,
    valid          INTEGER NOT NULL DEFAULT 1,
    superseded_by  TEXT,
    created_at     TEXT NOT NULL
);

-- 航道实测水深
CREATE TABLE IF NOT EXISTS channel_observations (
    observation_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_ref     TEXT NOT NULL,
    depth_m         REAL NOT NULL,
    observed_at     TEXT NOT NULL,
    note            TEXT
);

-- 环保禁限时段
CREATE TABLE IF NOT EXISTS environmental_bans (
    ban_ref      TEXT PRIMARY KEY,
    scope        TEXT NOT NULL,       -- navigation|hoist|all
    starts_at    TEXT NOT NULL,
    ends_at      TEXT NOT NULL,
    reason       TEXT,
    valid        INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL
);

-- 动作许可（签发记录，含闸门判定留痕）
CREATE TABLE IF NOT EXISTS permits (
    permit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_ref      TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    action           TEXT NOT NULL,   -- transport|transfer|hoist
    resource_type    TEXT NOT NULL,   -- vessel|hoist
    resource_ref     TEXT NOT NULL,
    window_ref       TEXT,
    valid_from       TEXT NOT NULL,
    valid_until      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'issued', -- issued|completed|voided
    issued_at        TEXT NOT NULL,
    completed_at     TEXT,
    voided_at        TEXT,
    void_reason      TEXT,
    gate_report_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permits_segment ON permits(segment_ref, permit_id);
CREATE INDEX IF NOT EXISTS idx_permits_status ON permits(status, resource_type, resource_ref);

-- 资源互斥：同一资源至多一个生效（未释放）授权，由数据库唯一索引强约束
CREATE TABLE IF NOT EXISTS resource_grants (
    resource_type  TEXT NOT NULL,
    resource_ref   TEXT NOT NULL,
    permit_id      INTEGER NOT NULL,
    granted_at     TEXT NOT NULL,
    released_at    TEXT,
    PRIMARY KEY (resource_type, resource_ref, permit_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_active
    ON resource_grants(resource_type, resource_ref) WHERE released_at IS NULL;

-- 变化影响报告（水位 / 设备 / 复检触发）
CREATE TABLE IF NOT EXISTS impact_reports (
    report_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_type   TEXT NOT NULL,    -- water_window|device_status|recheck
    trigger_ref    TEXT NOT NULL,
    computed_at    TEXT NOT NULL,
    affected_json  TEXT NOT NULL,
    detail_json    TEXT NOT NULL DEFAULT '{}'
);

-- 合龙节点
CREATE TABLE IF NOT EXISTS closures (
    closure_group   TEXT PRIMARY KEY,
    closed_at       TEXT NOT NULL,
    total_segments  INTEGER NOT NULL,
    evidence_count  INTEGER NOT NULL
);
