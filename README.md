# 乌江桥节段水运吊装协同

桥梁节段从预拼到浅水运输、倒驳和吊装有固定依赖，航道窗口同时受水位和水电站调度影响。本服务以**构件版本**与**既定安装序列**为主线，把预拼验收、船舶载荷、航道水深、倒驳交接、缆索吊能力、两岸条件与环保禁限时段纳入统一的签发门：

> 只有前序证据和当前窗口**同时成立**，下一动作才可签发。

水位、设备或复检结果变化时，系统在同一事务内立即重算受影响环节，已签发但条件失效的许可立即挂起并释放资源；同一吊装/船舶资源的并发申请只准一个生效。合龙完成后可从节段节点反查制造、运输、交接与安装的全部证据。

## 运行

```bash
make migrate          # 初始化/升级 SQLite 数据文件
make seed             # 可选：写入 37 个节段的演示数据（RESET=1 可重建）
make test             # 自动化检查（14 项端到端用例）
make run              # 启动 HTTP 服务
```

也可以 `docker compose up --build`，宿主机端口由 `APP_PORT` 调整。`PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件。

## 动作链与状态

`dispatch（发运）→ transship（倒驳）→ hoist（起吊）→ install（安装就位）`

申请状态：`pending → issued → completed`；条件失效时 `issued → suspended`（恢复后须重新签发）；人工取消或构件版本升级则为 `cancelled`。

## 接口

操作者通过 `X-Actor` 请求头传递（不含真实身份的引用编号）。时间一律为带偏移量的 ISO 8601。

### 登记（基础数据与证据）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /admin/segments` | 登记节段、安装序号、首版本（重量等） |
| `POST /admin/segments/revision` | 构件版本升级；该节段未完成申请全部作废、租约释放 |
| `POST /admin/evidence` | 证据登记，只存 `ref` 受控引用或 `sha256`；全局豁免允许 `segment_ref` 为空 |
| `POST /admin/windows` | 登记/更新水位窗口（起止、水位上下限、来源） |
| `POST /admin/restrictions` | 环保 `prohibit`（禁止）/`restrict`（凭豁免）时段 |
| `POST /admin/vessels` `/hoists` `/banks` | 船舶（载重/吃水）、缆索吊（能力）、两岸就位 |
| `POST /admin/loadings` | 实际配载与吃水（按节段版本） |
| `POST /admin/channel-readings` | 航道点最新水深 |

### 协同流程

| 方法与路径 | 说明 |
| --- | --- |
| `POST /requests` | 提出申请，响应含即时闸门快照（`gate_snapshot.ok` 与阻塞码） |
| `POST /requests/:ref/issue` | 控制室签发；条件不成立返回 `412 gate_blocked` |
| `POST /requests/:ref/complete` | 标记完成；完成前条件失效则挂起（412） |
| `POST /requests/:ref/cancel` | 取消并释放资源 |
| `POST /changes` | 水位/设备/复检变化，立即返回受影响环节 |

### 查询

| 方法与路径 | 说明 |
| --- | --- |
| `GET /requests?status=&segment_ref=` | 申请列表 |
| `GET /requests/:ref` | 单个申请（闸门快照、租约） |
| `GET /segments/:ref` | 节段与全部版本 |
| `GET /segments/:ref/trace` | **节点反查**：证据、四个动作的完整生命周期、变化影响、汇总时间线 |
| `GET /closure` | 37 节段合龙进度、既定序列与下一个待装节段 |

## 场景演练：水位窗口变更与提前起吊

```bash
# 1. 基础数据：窗口、船、缆索吊、两岸、航道点（略，见 make seed）
# 2. 节段到达倒驳点，现场申请 05:00 提前起吊（窗口 06:00 才开始，前序未完成）
curl -X POST localhost:8080/requests -H 'content-type: application/json' -d '{
  "request_ref":"REQ-07-H-EARLY","segment_ref":"SEG-07","revision":2,"action":"hoist",
  "hoist_ref":"HOIST-MAIN",
  "scheduled_start":"2026-09-23T05:00:00+08:00",
  "scheduled_end":"2026-09-23T05:40:00+08:00","requester":"SITE-FOREMAN"}'
curl -X POST localhost:8080/requests/REQ-07-H-EARLY/issue -H 'X-Actor: CTRL-ROOM'
# 412：window_not_covered、previous_action_incomplete、evidence_missing

# 3. 水电站调度改变水位窗口：已签发的发运许可立即挂起并释放船舶
curl -X POST localhost:8080/changes -H 'content-type: application/json' -d '{
  "change_ref":"CHG-WATER-1","type":"water","summary":"上游水电站临时调整水位窗口",
  "cancel_windows":["WIN-1"],
  "new_windows":[{"window_ref":"WIN-2",
    "starts_at":"2026-09-24T10:00:00+08:00","ends_at":"2026-09-24T18:00:00+08:00",
    "level_min":219.5,"level_max":221.0,"source":"水电站调度（更新）"}]}'
# 响应 impacts 给出每个受影响申请的 before/after 状态与阻塞码

# 4. 设备故障 / 复检
curl -X POST localhost:8080/changes -d '{"type":"equipment",
  "hoists":[{"hoist_ref":"HOIST-MAIN","status":"out_of_service"}]}'
curl -X POST localhost:8080/changes -d '{"type":"reinspection",
  "rechecks":[{"resource_type":"hoist","resource_ref":"HOIST-MAIN","result":"pass"}]}'

# 5. 反查：从节段节点看到全部制造、运输、交接与安装证据，包括被挂起的历史许可
curl localhost:8080/segments/SEG-07/trace
curl localhost:8080/closure
```

阻塞码的完整清单与稳定字段名见 `contracts/entities.json`，领域规则见 `docs/domain.md`，本地无真实身份的示例见 `fixtures/example.json`。
