# App 对接观影记录同步服务端指南

## 前置条件

1. 已按 [DEPLOY.md](./DEPLOY.md) 部署好服务端
2. 拿到服务端地址（形如 `https://webhtv-playback-sync.xxx.workers.dev`）
3. 准备一个 token（自定义密码字符串，建议用 `openssl rand -hex 32` 生成）

## 配置步骤

### 第 1 步：开启观影记录同步总开关

打开 App → 设置 → 增强功能 → 观影记录同步

确保顶部「总开关」为开启状态。

### 第 2 步：配置 Webhook 上报（App 推送进度到服务端）

在「观影记录同步」页面点击 **Webhook 上报 → 管理 → 新增**，填写：

| 字段 | 填写内容 |
|---|---|
| 名称 | 随意，如 `我的同步服务` |
| 端点 URL | `https://webhtv-playback-sync.xxx.workers.dev/webhook` |
| 服务端 Token | 你的 token 字符串 |
| 字段预设 | 建议「基础」，如需调试信息选「标准」或「完整」 |
| 进度间隔 | 建议 30 秒（默认），额度紧张可调到 120 秒 |
| 重试 | 默认 2 即可 |
| 站点 key | 留空（同步全部站点） |

保存后，App 会在播放视频时自动把进度 POST 到这个地址。

### 第 3 步：配置远端同步（App 从服务端拉取记录）

在「观影记录同步」页面点击 **远端同步 → 管理 → 新增**，填写：

| 字段 | 填写内容 |
|---|---|
| 名称 | 随意，如 `我的同步服务` |
| 远端 API URL | `https://webhtv-playback-sync.xxx.workers.dev/records` |
| 服务端 Token | 与 Webhook 相同的 token 字符串 |
| 站点 key | 留空（拉取全部站点） |
| 间隔分钟 | 建议 30（每 30 分钟自动拉取一次），设为 0 则不自动拉取 |
| 最大条数 | 默认 100 即可 |
| 启动时同步 | 建议开启 |

保存后，App 会在启动时和定时自动从服务端拉取记录合并到本地。

### 第 4 步：验证同步是否生效

1. 在设备 A 上播放一个视频，播放 30 秒后暂停退出
2. 在设备 B 上进入「观影记录同步 → 远端同步」，点击列表中的「同步」按钮手动触发一次拉取
3. 设备 B 的最近观看列表中应该出现设备 A 播放过的影片和进度

## 数据流向

```
设备A 播放视频
    │
    ├── Webhook 上报 (POST /webhook)
    │       → 进度写入 Cloudflare KV
    │
设备B 启动 / 定时触发
    │
    └── 远端同步 (GET /records)
            → 拉取服务端记录
            → 合并到本地 History（按 updatedAt 判断新旧）
```

## 多设备同步

所有设备在 Webhook 和远端同步里填**同一个 token** 即可共享记录。

不同家庭成员想隔离记录，用不同 token。

## 字段预设说明

Webhook 上报的字段预设控制发送哪些信息到服务端：

| 预设 | 包含字段 | 适用场景 |
|---|---|---|
| 基础 | 影片信息 + 进度 + 站点 | 日常使用，推荐 |
| 标准 | 基础 + App 版本 + 客户端类型 | 多端排查问题 |
| 完整 | 标准 + 播放地址 + 设备标识 | 深度调试 |
| 匿名 | 进度 + 去重 key（无影片名/站点名） | 注重隐私 |

## 管理服务端数据

### 查看统计

```bash
curl https://webhtv-playback-sync.xxx.workers.dev/stats \
  -H "X-WebHTV-Token: 你的token"
```

返回：

```json
{
  "token": "你的token",
  "totalRecords": 42,
  "lastUpdate": 1781170000000,
  "configKeys": ["sha256-config-1", "sha256-config-2"],
  "breakdown": {
    "sha256-config-1": 30,
    "sha256-config-2": 12
  }
}
```

### 清空全部记录

```bash
curl -X DELETE "https://webhtv-playback-sync.xxx.workers.dev/records?scope=all" \
  -H "X-WebHTV-Token: 你的token"
```

### 删除某个接口下的记录

```bash
curl -X DELETE "https://webhtv-playback-sync.xxx.workers.dev/records?configKey=接口SHA256&scope=config" \
  -H "X-WebHTV-Token: 你的token"
```

## 故障排查

### App 上报失败

1. 进入 设置 → 增强功能 → 调试日志，开启调试日志
2. 播放视频后查看日志中 `playback-webhook` 相关条目
3. 如果显示 `HTTP 401`，检查 token 是否正确
4. 如果显示 `HTTP 0` 或超时，检查 URL 是否正确、网络是否可达

### 远端同步拉取为空

1. 确认服务端有数据：用 curl 调用 `/stats`
2. 确认远端同步的 token 和 Webhook 的 token 一致
3. 确认远端同步的 URL 以 `/records` 结尾

### 记录没有合并到本地

App 的合并规则是「远端记录的 updatedAt 大于本地 History 的 createTime 才覆盖」。如果本地记录比远端新，会被跳过（正常行为，防止旧数据覆盖新数据）。

### Webhook 连续失败后自动暂停

App 会在连续失败 3 次后自动暂停该 Webhook 端点。重新编辑保存该端点即可恢复。

## 配置示例

假设你的服务端地址是 `https://webhtv-playback-sync.abc123.workers.dev`，token 是 `my-secret-token-2026`：

**Webhook 上报配置**：

```
端点 URL: https://webhtv-playback-sync.abc123.workers.dev/webhook
服务端 Token: my-secret-token-2026
进度间隔: 30
重试: 2
字段预设: 基础
```

**远端同步配置**：

```
远端 API URL: https://webhtv-playback-sync.abc123.workers.dev/records
服务端 Token: my-secret-token-2026
间隔分钟: 30
最大条数: 100
启动时同步: 开启
```
