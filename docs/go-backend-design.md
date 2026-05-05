# Go 后端替代 Rust 后端开发文档

## 目标

用 Go 后端完整替代 `apps/backend` Rust 后端，对前端保持同一组 HTTP 与 WebSocket 接口，不要求前端先大改。

重点解决现有 Rust 后端的问题：

- 页面刷新、切后台、重新打开后，前端能重新连上后端。
- 后端到 Polymarket 的长连接断开后能自动恢复。
- 外部接口慢、WebSocket 断开、交易失败时，后端不被拖死。
- 风控、持仓、本地数据、交易接口行为与当前 Rust 版一致。

## 完成标准

- Go 后端启动后，`/health` 能在 2 秒内响应。
- 前端刷新 50 次，`/ws/board` 与 `/ws/monitor` 不出现无法重连。
- 浏览器关闭、切后台、网络断开后，后端连接数能回收。
- Polymarket WebSocket 断开后能重连，并恢复原订阅。
- 所有外部 HTTP / WebSocket / 文件写入都有超时或取消机制。
- 保留现有数据文件位置与格式，至少兼容：
  - `data/derived-credentials.json`
  - `data/leagues.json`
  - `data/teams.json`
  - `data/positions-state.json`
  - `data/global-params.json`
  - `data/trade-history.sqlite`
- 前端现有接口可直接切到 Go 后端。
- Go 侧通过 `go test ./...`，关键长连接逻辑通过 race detector。

## 现有 Rust 后端职责

现有 Rust 后端位于 `apps/backend`，核心职责如下：

| 模块 | 职责 |
| --- | --- |
| `http.rs` | 对前端提供 HTTP API 与 `/ws/board`、`/ws/monitor` |
| `app.rs` | 全局状态、广播、持仓价格合并 |
| `monitor_feed.rs` | Polymarket 行情 WebSocket、用户事件 WebSocket、风控循环、链上持仓同步 |
| `trading.rs` | 下单、卖出、查询订单、查询成交、余额与组合价值 |
| `board.rs` | 首页赛事、市场、盘口数据 |
| `positions_store.rs` | 本地持仓、风控配置、失败平仓任务 |
| `accounts.rs` | 本地账户与 CLOB 凭证 |
| `history_db.rs` | 平仓历史 SQLite |
| `global_params.rs` | UI 参数持久化 |

## 前端依赖的接口

Go 后端需要优先兼容以下接口：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/health` | GET | 后端存活检查 |
| `/api/runtime-status` | GET | 运行状态 |
| `/api/settings/global-params` | GET / PUT | 全局参数 |
| `/api/leagues` | GET | 联赛配置 |
| `/api/home/markets` | GET | 首页赛事市场 |
| `/api/home/ticks` | POST | 批量 token 报价 |
| `/api/markets/resolve-by-clob-tokens` | GET | token 反查市场信息 |
| `/api/history/closed` | GET | 已关闭交易历史 |
| `/api/accounts` | GET / POST | 账户列表与创建 |
| `/api/accounts/reload-auth` | POST | 重载账户凭证 |
| `/api/accounts/{id}/sync-derived-proxy` | POST | 同步 proxy 钱包 |
| `/api/accounts/{id}` | DELETE | 删除账户 |
| `/api/accounts/{id}/default` | POST | 设置默认账户 |
| `/orders` | POST | 下单 |
| `/orders/{id}` | GET | 查订单 |
| `/trading/market-sell` | POST | 市价卖出 |
| `/trading/close-all` | POST | 取消订单并批量卖出 |
| `/trading/orders` | GET | CLOB 订单 |
| `/trading/trades` | GET | CLOB 成交 |
| `/positions` | GET / POST | 持仓列表与注册 |
| `/positions/reconcile` | GET | 本地与链上持仓对账 |
| `/positions/chain` | GET | 链上持仓 |
| `/positions/chain-sync` | POST | 手动同步链上持仓 |
| `/positions/chain-sync/status` | GET | 同步状态 |
| `/positions/{id}` | PATCH | 更新持仓 |
| `/positions/{id}/arm` | POST | 开启监控 |
| `/positions/{id}/disarm` | POST | 关闭监控 |
| `/positions/{id}/close` | POST | 手动关闭 |
| `/risk/config` | PATCH | 风控配置 |
| `/monitor/start` | POST | 启动行情监控 |
| `/monitor/stop` | POST | 停止行情监控 |
| `/monitor/snapshot` | GET | 持仓快照 |
| `/monitor/close-tasks` | GET | 失败平仓任务 |
| `/paper/resolve` | POST | 模拟交易解析事件 |
| `/paper/simulate-buy` | POST | 模拟买入 |
| `/ws/board` | WS | 首页行情推送 |
| `/ws/monitor` | WS | 持仓快照推送 |

## Rust 版问题判断

当前刷新后连不上、服务端易卡死，主要风险点如下：

1. `/ws/board` 必须先等前端第一条订阅消息，缺少超时；异常连接可能长期占用协程。
2. `/ws/board` 与 `/ws/monitor` 发送失败时没有立刻关闭连接，断开的前端可能继续留在广播链路里。
3. 前端刷新、切后台会频繁关闭并重建 WebSocket；后端缺少明确的连接心跳、关闭原因与清理流程。
4. Rust 版上游 Polymarket WebSocket 与前端 WebSocket 耦合在全局广播里，一旦重订阅或上游阻塞，容易影响多个前端连接。
5. 部分后台循环是无限循环，缺少统一生命周期管理；停止服务或异常重启时不容易确认所有任务已退出。
6. 持久化通过多次异步写文件触发，短时间大量状态变更可能造成写入竞争或延迟堆积。

Go 版不直接照搬这些实现，应把连接管理作为第一优先级重新设计。

## Go 后端总体设计

推荐目录：

```text
apps/polyserver/
  cmd/polyserver/main.go
  internal/config/
  internal/httpapi/
  internal/realtime/
  internal/polymarket/
  internal/accounts/
  internal/positions/
  internal/risk/
  internal/history/
  internal/board/
  internal/scheduler/
  internal/storage/
```

使用 `apps/polyclient` 作为 Go SDK 依赖。服务端模块只处理业务编排，不在服务端里重复写 Polymarket SDK 逻辑。

## 关键设计决策

### 1. 前端 WebSocket 与上游 WebSocket 分离

推荐方案。

优点：

- 前端刷新只影响当前浏览器连接。
- Polymarket 重连不会直接踢掉前端连接。
- 可以独立观察前端连接数、订阅数、上游状态。

缺点：

- 需要维护本地订阅集合与广播 hub。

不推荐让每个前端连接各自连 Polymarket。这样刷新多次会制造大量上游连接，反而更容易卡死。

### 2. `/ws/board` 使用可更新订阅

前端连接建立后允许发送：

```json
{"type":"subscribe","tokenIds":["..."]}
```

也兼容当前前端旧格式：

```json
{"tokenIds":["..."]}
```

后端行为：

- 连接打开后立即进入读写循环，不无限等待首条消息。
- 首条订阅等待最多 5 秒；超时则保持空订阅，但连接仍可后续补发订阅。
- 每个连接有独立 `context.Context`。
- 发送失败、读失败、心跳失败都关闭连接并清理订阅。
- token 集合变更后通知上游行情管理器重新计算全局订阅。

### 3. `/ws/monitor` 打开即发快照

行为保持当前 Rust 版：

- 连接成功后立即发送一次当前快照。
- 后续只接收广播更新。
- 客户端断开后立即清理。
- 心跳失败或写超时后关闭。

### 4. 上游 Polymarket 行情连接集中管理

由 `realtime.PriceFeed` 负责：

- 聚合来源：
  - 打开的 `/ws/board` token
  - 本地 open / stopped_out 持仓 token
  - 待重试平仓任务 token
- 使用 `apps/polyclient/polymarket/ws/market` 连接 Polymarket。
- 开启 SDK 的 reconnect 与 subscription replay。
- 全局 token 集合变化时，重新订阅。
- WebSocket 30 秒无有效行情时，使用 REST midpoint 兜底。
- 每个上游连接只由一个 goroutine 读取，读到后写入本地 `PriceBook`，再广播给前端。

### 5. 所有阻塞操作必须可取消

规则：

- HTTP 请求默认超时 12 秒。
- 交易下单默认超时 30 秒。
- 链上持仓同步默认超时 30 秒。
- WebSocket 写超时 5 秒。
- 文件写入进入单独串行写队列，避免并发写同一文件。
- 后台循环统一由根 context 控制，服务退出时全部停止。

## Go 模块说明

| 模块 | 内容 |
| --- | --- |
| `internal/httpapi` | 路由、请求响应模型、错误格式、静态文件服务 |
| `internal/realtime` | 前端 WebSocket hub、上游行情连接、广播 |
| `internal/polymarket` | 对 `apps/polyclient` 的业务封装 |
| `internal/accounts` | 账户读取、创建、默认账户、CLOB 凭证 |
| `internal/positions` | 持仓状态、风控配置、失败平仓任务 |
| `internal/risk` | PriceBook、止损判断、快照生成 |
| `internal/history` | SQLite 平仓历史 |
| `internal/board` | 首页赛事与市场聚合 |
| `internal/scheduler` | close queue、chain sync、user events loop |
| `internal/storage` | JSON 文件原子写、写入合并、schema 兼容 |

## Go 技术选型

| 能力 | 推荐 |
| --- | --- |
| HTTP router | `net/http` + `chi` 或 `gin` |
| WebSocket | `gorilla/websocket`，与 SDK 保持一致 |
| SQLite | `modernc.org/sqlite` 或 `mattn/go-sqlite3` |
| 日志 | `log/slog` |
| 配置 | 环境变量，兼容 `POLYBACKEND_*` 与 `PORT` |
| 测试 | 标准 `testing`、`httptest`、race detector |

推荐 `chi`，原因是轻量、接近标准库、迁移成本低。

## 与 Electron 集成

Electron 当前查找：

```text
apps/backend/bin/server-${platform}-${arch}
```

Go 版可有两个选项：

| 选项 | 优点 | 缺点 |
| --- | --- | --- |
| 保持输出文件名不变 | Electron 几乎不用改 | 路径名仍叫 backend |
| 新增 `apps/polyserver/bin/server-*` 并改 Electron | 命名清楚 | 需要同步改构建脚本 |

推荐先保持输出文件名不变，确保替换风险最低；确认稳定后再重命名目录和构建路径。

## 开发步骤

### 第一阶段：可启动的 Go 后端骨架

- 新建 `apps/polyserver`。
- 实现配置读取、日志、`/health`、静态文件服务。
- 保持端口、数据目录、web 目录环境变量兼容 Rust 版。
- Electron 可拉起 Go 二进制。

### 第二阶段：状态与只读 API

- 迁移 global params、leagues、accounts、positions 读取。
- 实现 `/api/settings/global-params`、`/api/accounts`、`/positions`、`/monitor/snapshot`。
- 实现 JSON 原子写与写入合并。

### 第三阶段：前端 WebSocket 与行情

- 实现 `/ws/board`、`/ws/monitor`。
- 实现前端连接 hub、订阅更新、连接回收。
- 接入 `apps/polyclient/polymarket/ws/market`。
- 实现 REST midpoint 兜底。
- 重点验证刷新、断网、切后台。

### 第四阶段：交易与账户

- 接入 `apps/polyclient/polymarket/auth`、`orders`、`balances`、`positions`。
- 实现下单、卖出、取消订单、订单/成交列表。
- 实现账户创建、派生 CLOB 凭证、默认账户。

### 第五阶段：链上同步、风控、历史

- 实现 chain sync。
- 实现 trailing stop 与失败平仓任务。
- 实现 SQLite 历史。
- 接入 user channel，订单/成交变化后触发同步。

### 第六阶段：替换 Rust

- 构建 Go 二进制到 Electron 期望路径。
- 本地完整跑前端。
- 保留 Rust 后端一段时间作为回滚方案。
- 确认稳定后移除 Rust 构建链路。

## 测试方案

### 单元测试

- JSON 状态文件读写兼容。
- 风控触发条件。
- 持仓更新与失败平仓任务重试。
- 订阅集合合并与去重。
- WebSocket 断开时连接清理。

### 集成测试

- `httptest` 启动后端，覆盖主要 HTTP API。
- 本地 WebSocket client 连 `/ws/board`，订阅、断开、重连。
- 模拟 Polymarket WebSocket 断开，确认自动重连与订阅恢复。
- 文件写入 race detector。

### 手工验收

- 打开前端，刷新 50 次。
- 切后台 2 分钟后回到前台。
- 断网 30 秒再恢复。
- Polymarket 上游断开后等待恢复。
- 无账户、账户错误、CLOB 凭证错误时后端仍能响应 `/health`。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| Go SDK 缺少 Rust SDK 某些 Data API 能力 | 先补 `apps/polyclient`，再接服务端 |
| 订单签名细节与 Rust 输出不一致 | 对照现有 Go SDK 测试与真实 dry-run / 小额验证 |
| 首页市场聚合逻辑较多 | 先迁移接口行为，再整理内部实现 |
| 文件格式兼容出错 | 启动时只读加载，写入前保留 `.bak` |
| WebSocket 重连造成重复订阅 | 所有订阅以 token set 为准，统一 diff 与去重 |

## 待确认事项

1. Go 后端目录使用 `apps/polyserver`，还是直接放入 `apps/polyclient/cmd/server`？
2. 第一版是否要求 Electron 构建立即替换 Rust 二进制？
3. 交易接口是否允许先只支持现有前端用到的 market buy / market sell / cancel all？
4. Go SDK 若缺 Data API 或 Gamma 能力，是否允许在 `apps/polyclient` 同步补齐？

## 推荐结论

推荐按六阶段执行，并优先完成第三阶段的 WebSocket 与行情稳定性。原因是当前最大问题不是接口数量，而是刷新、重连、断开清理这些连接生命周期问题；先把连接模型做稳，再迁移交易和风控，替换风险最低。
