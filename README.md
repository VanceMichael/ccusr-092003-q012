# 乌江桥节段水运吊装协同

项目控制室协同系统：以**构件版本**和**既定安装序列（37 个节段的合龙顺序）**为主线，纳入预拼验收、船舶载荷、航道水深、倒驳交接、缆索吊能力、两岸条件与环保禁限时段。只有前序证据和当前窗口同时成立，下一动作才可签发；水位、设备或复检结果变化时立即重算受影响环节；同一吊装/运输资源的并发申请只准一个生效；合龙完成后仍能从节点反查每个节段经历的制造、运输、交接与安装证据。

## 本地开发

```bash
make migrate     # 初始化/升级数据库结构
make seed        # 写入 37 节段、设备、窗口、两岸条件等种子（可重复执行）
make reset-seed  # 删除数据文件后重建种子
make test        # 20 项自动化测试
make demo        # 端到端场景演示（临时库，走真实 HTTP）
make run         # 启动服务（首次自动迁移+播种），访问 http://localhost:8080
```

环境变量：`PORT`（默认 8080）、`DATABASE_PATH`（默认 `./data/app.sqlite3`）。也可用 `docker compose up --build` 运行，宿主机端口由 `APP_PORT` 调整。

`fixtures/example.json` 提供不含真实身份的本地示例，`contracts/entities.json` 记录字段约定与闸门清单，`docs/domain.md` 说明领域规则。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` `/plan` `/closure` | 健康、合龙序列总览、合龙状态 |
| POST | `/segments` `/segments/{ref}/revisions` | 节段登记 / 升版 |
| GET | `/segments/{ref}/trace` | **证据反查**：版本、各阶段证据与复检链、许可与吊销留痕 |
| POST/GET | `/events` | 追加证据 / 复检事件（只追加，`supersedes_event` 指向旧证据） |
| POST/GET | `/vessels` `/hoists` `/banks` | 船舶、缆索吊、两岸条件 |
| POST | `/devices/status` | 设备停用/恢复，**立即重算并吊销其生效许可** |
| POST/GET | `/water-windows` | 发布水位窗口（时间重叠的同航道旧窗口自动标记被取代，**立即重算**） |
| POST | `/channel-observations` | 航道实测水深 |
| POST/GET | `/environmental-bans` | 环保禁限时段（navigation/hoist/all） |
| POST | `/gate/evaluate` | 闸门试算（不签发） |
| POST/GET | `/permits`，`POST /permits/{id}/complete` | 签发/查询/完成许可；同资源冲突返回 409 |
| GET | `/impact-reports`，`POST /impact/recompute` | 变化影响报告 / 手动重算 |
| POST | `/closure/close` | 合龙（全部安装才允许） |

## 签发规则（闸门）

每次签发按序校验：构件版本 → 当前版本全部证据无复检失败 → 直接前序证据 → 合龙顺序（前序节段已安装）→ 资源可用且能力足够 → 水位窗口有效且正开启 → 航道水深满足吃水 → 南北两岸具备 → 非环保禁限时段 → 无重复生效许可。任一不满足返回 422 及逐项闸门报告；资源被占用返回 409 及持有许可号。

## 典型场景（见 `make demo`）

1. **提前起吊被拒**：SEGMENT-07 证据齐全时可签发；水电站临时发布 3 小时后才开启的新窗口，旧许可被即时吊销（`water_window_changed:*`），现场再申请被“当前时间处于水位窗口内”拒绝。
2. **并发只准一个**：SEGMENT-08/09 同时争抢 VESSEL-A，一个签发、一个 409，被拒方不留记录；完成释放后下一个申请才可生效。
3. **变化即重算**：VESSEL-A 故障、SEGMENT-08 预拼验收复检不通过，生效许可立即吊销，该节段及其后未安装节段全部进入受影响清单。
4. **合龙反查**：缺节段时合龙被拒；37 节段按序安装后合龙，`trace` 仍能看到 SEGMENT-07 的五条阶段证据、sha256 摘要、主体编号以及被吊销/完成的许可留痕。

## 控制室

浏览器打开根路径即控制室页面：合龙序列与五段证据色格、动作签发试算、现场条件（窗口/设备/两岸/环保）、许可与吊销留痕、影响报告、节段证据反查，并提供“水电站临时改变窗口”一键演练。
