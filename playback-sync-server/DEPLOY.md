# WebHTV 观影记录同步服务端部署指南

## 前置条件

- 一个 Cloudflare 账号（免费即可）：https://dash.cloudflare.com/sign-up
- 安装 Node.js 18+ 和 npm

## 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

浏览器会打开 Cloudflare 授权页，点击允许。

### 2. 创建 KV 命名空间

```bash
cd playback-sync-server
wrangler kv:namespace create PLAYBACK_KV
```

输出类似：

```
[[kv_namespaces]]
binding = "PLAYBACK_KV"
id = "abcd1234efgh5678..."
```

### 3. 填写配置

把上一步返回的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "PLAYBACK_KV"
id = "abcd1234efgh5678..."   ← 替换成你的实际 id
```

### 4. 部署

```bash
wrangler deploy
```

部署成功后输出：

```
Published webhtv-playback-sync
  https://webhtv-playback-sync.<你的子域>.workers.dev
```

这个 URL 就是你的服务端地址。

### 5. 验证服务

```bash
curl https://webhtv-playback-sync.<你的子域>.workers.dev/health
```

返回：

```json
{"status":"ok","schema":"webhtv.playback.v1","service":"webhtv-playback-sync"}
```

## 关于 Token

服务端用 `X-WebHTV-Token` 请求头区分不同用户。Token 就是你自己定义的一个密码字符串，不需要在服务端预先注册。

**建议**：用一段足够长的随机字符串作为 token，例如：

```bash
openssl rand -hex 32
```

输出类似 `a3f5b8c1d2e4...`，把它作为你的 token 配置到 App 里。

多设备同步时，所有设备填同一个 token 就能共享记录；不同用户用不同 token 互不干扰。

## API 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/webhook` | 接收 App Webhook 上报 |
| GET | `/records` | 返回记录列表供 App 远端同步拉取 |
| DELETE | `/records` | 删除记录 |
| GET | `/stats` | 查看当前 token 的统计信息 |

所有接口（除 `/health`）都需要通过 `X-WebHTV-Token` 请求头传递 token。

## 手动测试

```bash
# 设你的地址和 token
export SERVER="https://webhtv-playback-sync.<你的子域>.workers.dev"
export TOKEN="你的token"

# 模拟 Webhook 上报
curl -X POST "$SERVER/webhook" \
  -H "Content-Type: application/json" \
  -H "X-WebHTV-Token: $TOKEN" \
  -H "X-WebHTV-Webhook-Id: test-001" \
  -H "X-WebHTV-Dedupe-Key: test-dedupe-001" \
  -H "X-WebHTV-Config-Key: test-config-001" \
  -d '{
    "schema": "webhtv.playback.v1",
    "event": "playback.progress",
    "eventId": "test-001",
    "timestamp": 1781170000000,
    "dedupeKey": "test-dedupe-001",
    "configKey": "test-config-001",
    "configName": "测试接口",
    "siteKey": "test_site",
    "vodId": "test_vod",
    "vodName": "测试影片",
    "episodeName": "第1集",
    "positionMs": 120000,
    "durationMs": 3600000,
    "progress": 0.033,
    "state": "playing",
    "completed": false
  }'

# 拉取记录
curl "$SERVER/records" -H "X-WebHTV-Token: $TOKEN"

# 查看统计
curl "$SERVER/stats" -H "X-WebHTV-Token: $TOKEN"
```

## 免费额度

Cloudflare Workers 免费计划：

| 项目 | 免费额度 |
|---|---|
| 请求数/天 | 100,000 |
| KV 读取/天 | 100,000 |
| KV 写入/天 | 1,000 |
| KV 存储 | 1 GB |
| Worker CPU 时间 | 10ms/请求 |

个人观影记录同步完全够用。App 默认进度上报间隔 30 秒，假设每天看 4 小时视频，约 480 次写入，远低于 1000 次/天的写入限制。

如果 KV 写入额度不够，可以在 App 的 Webhook 配置里把「进度间隔」调大（如 120 秒），减少上报频率。

## 常见问题

### Q: 部署后 App 连不上？

检查 App 配置的 URL 是否以 `https://` 开头，是否完整包含 `.workers.dev` 域名。

### Q: 记录数量上限？

`wrangler.toml` 中 `MAX_RECORDS_PER_USER` 默认 5000，超过后新记录会覆盖最旧的。个人使用足够。

### Q: 如何多设备同步？

所有设备在 App 里配置同一个 token 即可。每台设备都会把播放进度推到服务端，也会从服务端拉取其他设备的记录。

### Q: 如何清空所有记录？

```bash
curl -X DELETE "$SERVER/records?scope=all" -H "X-WebHTV-Token: $TOKEN"
```

### Q: 如何更新服务端代码？

修改 `src/index.js` 后重新执行 `wrangler deploy` 即可。
