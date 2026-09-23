# 领域资料

桥梁节段从预拼到浅水运输、倒驳和吊装有固定依赖，航道窗口同时受水位和水电站调度影响。

## 主线

以**构件版本**（`segments.current_revision` + `segment_revisions`）和**既定安装序列**（`install_order`）为主线。动作链固定为：

`dispatch（发运）→ transship（倒驳）→ hoist（起吊）→ install（安装就位）`

- 每个动作的申请（`action_requests`）必须携带节段引用与版本号；申请版本与当前版本不一致即阻断（`revision_mismatch`）。版本升级时，该节段所有未完成申请作废并释放资源租约。
- 只有**前序证据**与**当前窗口**同时成立，签发门（`src/gate.js` 的 `evaluateGate`）才允许签发。

## 签发门条件

| 动作 | 前序动作 | 证据 | 资源与工况 |
| --- | --- | --- | --- |
| dispatch | — | 制造验收、预拼验收 pass | 水位窗口完整覆盖计划时段；环保禁限；船舶可用、复检 pass；配载不超载/不超吃水；沿线航道点水深 ≥ 吃水+余量 |
| transship | dispatch 已完成 | 水位窗口、环保、船舶同上 | |
| hoist | transship 已完成 | 预拼验收、倒驳交接 `transfer_handover` pass | 水位窗口、环保；缆索吊可用、复检 pass、节段重量 ≤ 起重能力 |
| install | hoist 已完成 | 水位窗口；缆索吊同上；两岸 ready；所有 `install_order` 在前的节段已安装 |

水位窗口必须**完整覆盖**计划时段（边界相等也算覆盖）。环保时段分两级：`prohibit` 一律禁止；`restrict` 须存在与时段相交的全局 `environmental_waiver` pass 证据。

## 资源互斥

同一船舶或缆索吊在同一时段只允许一个生效许可：签发在 `BEGIN IMMEDIATE` 事务内重算闸门并写入 `resource_leases`，区间相交的第二份申请以 `vessel_lease_conflict` / `hoist_lease_conflict` 拒绝（HTTP 412）。取消、挂起或版本作废时立即释放租约。

## 变更与影响传播

`POST /changes` 接受三类变化并在同一事务内完成落库与重算：

- `water`：取消/作废旧窗口、登记新窗口（水电站调度改变水位窗口）；
- `equipment`：船舶、缆索吊、两岸状态变化；
- `reinspection`：资源复检 pass/fail。

重算覆盖所有 `pending/issued/suspended` 申请：**已签发但条件被打破的许可立即挂起并释放资源**；其余申请刷新闸门快照。每个受影响环节写入 `change_impacts`（前后状态与阻塞码）。条件恢复后不自动放行，须由控制室重新签发。

## 证据与反查

外部主体使用不含真实身份信息的引用编号。交换时间采用带偏移量的 ISO 8601 字符串，原始材料只保存受控引用或 `sha256` 摘要（`evidence.ref` / `evidence.sha256`）。

每个申请的 `created / issued / issue_denied / suspended / completed / cancelled` 事件（`request_events`）与闸门快照一并保留。`GET /segments/:ref/trace` 从节段节点反查制造、运输、交接与安装的全部证据和生命周期事件（含被变化打断的历史许可），而不是只剩最终状态。`GET /closure` 给出 37 个节段的合龙进度与序列。

`contracts/entities.json` 中的字段名称属于稳定接口约定，运行时数据文件位置由 `DATABASE_PATH` 决定。
