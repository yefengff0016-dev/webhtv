/**
 * WebHTV 观影记录同步服务端
 * 基于 Cloudflare Workers + KV
 *
 * 对接 App 的两条通道：
 * 1. Webhook 上报：App 在播放过程中 POST /webhook 推送进度
 * 2. 远端同步：App 启动/定时 GET /records 拉取记录
 *
 * 存储模型（KV key 设计）：
 *   token:{token}                    → 用户元数据（记录数、最后更新时间）
 *   rec:{token}:{configKey}:{dedupeKey} → 单条观影记录 JSON
 *   idx:{token}:{configKey}          → 该接口下所有 dedupeKey 的 JSON 数组
 *   evt:{token}:{eventId}            → 已处理的事件 ID（用于幂等去重，TTL 24h）
 */

const SCHEMA = 'webhtv.playback.v1';
const EVENT_TTL = 86400; // 事件去重记录保留 24 小时
const MAX_RECORDS_DEFAULT = 5000;

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS 预检
  if (method === 'OPTIONS') return corsResponse(new Response(null, { status: 204 }));

  try {
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', schema: SCHEMA, service: 'webhtv-playback-sync' });
    }

    if (path === '/webhook' && method === 'POST') {
      return handleWebhook(request, env, ctx);
    }

    if (path === '/records' && method === 'GET') {
      return handleFetchRecords(request, env);
    }

    if (path === '/records' && method === 'DELETE') {
      return handleDeleteRecords(request, env);
    }

    if (path === '/stats' && method === 'GET') {
      return handleStats(request, env);
    }

    return jsonResponse({ error: 'not found', path }, 404);
  } catch (e) {
    return jsonResponse({ error: e.message || 'internal error' }, 500);
  }
}

// ======================== Webhook 接收 ========================

async function handleWebhook(request, env, ctx) {
  const token = extractToken(request);
  if (!token) return jsonResponse({ error: 'missing token (X-WebHTV-Token header)' }, 401);

  const payload = await request.json();
  const eventId = payload.eventId || request.headers.get('X-WebHTV-Webhook-Id') || '';
  const dedupeKey = payload.dedupeKey || request.headers.get('X-WebHTV-Dedupe-Key') || '';
  const configKey = payload.configKey || request.headers.get('X-WebHTV-Config-Key') || '';

  if (!dedupeKey) return jsonResponse({ error: 'missing dedupeKey' }, 400);
  if (!configKey) return jsonResponse({ error: 'missing configKey' }, 400);

  // 幂等去重：同一 eventId 已处理过则直接返回成功
  if (eventId) {
    const eventKey = `evt:${token}:${eventId}`;
    const exists = await env.PLAYBACK_KV.get(eventKey);
    if (exists) {
      return jsonResponse({ success: true, action: 'duplicate', eventId, message: 'event already processed' });
    }
  }

  // 构建存储记录
  const record = buildRecord(payload, token);
  const recKey = `rec:${token}:${configKey}:${dedupeKey}`;

  // 读取已有记录，判断是否需要更新
  const existing = await env.PLAYBACK_KV.get(recKey, 'json');
  if (existing && existing.updatedAt >= record.updatedAt) {
    // 已有记录更新，跳过
    markEventProcessed(ctx, env, token, eventId);
    return jsonResponse({ success: true, action: 'skipped', eventId, dedupeKey, message: 'existing record is newer' });
  }

  // 写入记录
  await env.PLAYBACK_KV.put(recKey, JSON.stringify(record));

  // 更新索引
  await updateIndex(env, token, configKey, dedupeKey, !!existing);

  // 更新用户元数据
  await updateMeta(env, token, !existing);

  // 标记事件已处理
  markEventProcessed(ctx, env, token, eventId);

  return jsonResponse({
    success: true,
    action: existing ? 'updated' : 'created',
    eventId,
    dedupeKey,
    configKey,
    timestamp: record.updatedAt,
  });
}

// ======================== 远端拉取 ========================

async function handleFetchRecords(request, env) {
  const token = extractToken(request);
  if (!token) return jsonResponse({ error: 'missing token' }, 401);

  const configKey = request.headers.get('X-WebHTV-Config-Key') || '';
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000', 10), 1000);

  let items = [];

  if (configKey) {
    // 只拉取指定接口的记录
    items = await listRecordsByConfigKey(env, token, configKey, since, limit);
  } else {
    // 拉取该 token 下所有接口的记录
    items = await listAllRecords(env, token, since, limit);
  }

  // 计算最新的 updatedAt 作为 nextSince
  let nextSince = since;
  for (const item of items) {
    if (item.updatedAt > nextSince) nextSince = item.updatedAt;
  }

  return jsonResponse({ items, nextSince });
}

// ======================== 删除记录 ========================

async function handleDeleteRecords(request, env) {
  const token = extractToken(request);
  if (!token) return jsonResponse({ error: 'missing token' }, 401);

  const url = new URL(request.url);
  const configKey = url.searchParams.get('configKey') || request.headers.get('X-WebHTV-Config-Key') || '';
  const dedupeKey = url.searchParams.get('dedupeKey') || '';
  const scope = url.searchParams.get('scope') || '';

  let deleted = 0;

  if (dedupeKey && configKey) {
    // 删除单条
    const recKey = `rec:${token}:${configKey}:${dedupeKey}`;
    const existed = await env.PLAYBACK_KV.get(recKey);
    if (existed) {
      await env.PLAYBACK_KV.delete(recKey);
      await removeFromIndex(env, token, configKey, dedupeKey);
      deleted = 1;
    }
  } else if (configKey && (scope === 'config' || scope === 'all')) {
    // 删除某接口下全部记录
    deleted = await deleteByConfigKey(env, token, configKey);
  } else if (scope === 'all') {
    // 删除该 token 下全部记录
    deleted = await deleteAllRecords(env, token);
  }

  return jsonResponse({ success: true, deleted });
}

// ======================== 统计信息 ========================

async function handleStats(request, env) {
  const token = extractToken(request);
  if (!token) return jsonResponse({ error: 'missing token' }, 401);

  const meta = await env.PLAYBACK_KV.get(`token:${token}`, 'json');
  if (!meta) return jsonResponse({ token, totalRecords: 0, lastUpdate: 0 });

  // 统计各接口记录数
  const configKeys = await listConfigKeys(env, token);
  const breakdown = {};
  for (const ck of configKeys) {
    const idx = await env.PLAYBACK_KV.get(`idx:${token}:${ck}`, 'json');
    breakdown[ck] = idx ? idx.length : 0;
  }

  return jsonResponse({
    token,
    totalRecords: meta.count || 0,
    lastUpdate: meta.lastUpdate || 0,
    configKeys: configKeys,
    breakdown,
  });
}

// ======================== 存储辅助函数 ========================

function buildRecord(payload, token) {
  return {
    schema: SCHEMA,
    configKey: payload.configKey || '',
    configName: payload.configName || '',
    siteKey: payload.siteKey || '',
    siteName: payload.siteName || payload.siteKey || '',
    vodId: payload.vodId || '',
    vodName: payload.vodName || '',
    vodPic: payload.vodPic || '',
    flag: payload.flag || '',
    episodeName: payload.episodeName || '',
    episodeUrl: payload.episodeUrl || '',
    positionMs: payload.positionMs || 0,
    durationMs: payload.durationMs || 0,
    progress: payload.progress || 0,
    speed: payload.speed || 1.0,
    completed: payload.completed || false,
    state: payload.state || '',
    updatedAt: payload.updatedAt || payload.timestamp || Date.now(),
    // 保留 Webhook 特有字段
    event: payload.event || '',
    sessionId: payload.sessionId || '',
    client: payload.client || '',
    appVersion: payload.appVersion || '',
    clientKey: payload.clientKey || '',
  };
}

async function updateIndex(env, token, configKey, dedupeKey, isUpdate) {
  const idxKey = `idx:${token}:${configKey}`;
  let idx = (await env.PLAYBACK_KV.get(idxKey, 'json')) || [];
  if (!isUpdate && !idx.includes(dedupeKey)) {
    idx.push(dedupeKey);
    await env.PLAYBACK_KV.put(idxKey, JSON.stringify(idx));
    await addToConfigs(env, token, configKey);
  }
}

async function addToConfigs(env, token, configKey) {
  const cfgKey = `configs:${token}`;
  let list = (await env.PLAYBACK_KV.get(cfgKey, 'json')) || [];
  if (!list.includes(configKey)) {
    list.push(configKey);
    await env.PLAYBACK_KV.put(cfgKey, JSON.stringify(list));
  }
}

async function removeFromIndex(env, token, configKey, dedupeKey) {
  const idxKey = `idx:${token}:${configKey}`;
  let idx = (await env.PLAYBACK_KV.get(idxKey, 'json')) || [];
  idx = idx.filter(k => k !== dedupeKey);
  if (idx.length === 0) {
    await env.PLAYBACK_KV.delete(idxKey);
  } else {
    await env.PLAYBACK_KV.put(idxKey, JSON.stringify(idx));
  }
}

async function updateMeta(env, token, isnew) {
  const metaKey = `token:${token}`;
  let meta = (await env.PLAYBACK_KV.get(metaKey, 'json')) || { count: 0, lastUpdate: 0 };
  if (isnew) meta.count = (meta.count || 0) + 1;
  meta.lastUpdate = Date.now();
  await env.PLAYBACK_KV.put(metaKey, JSON.stringify(meta));
}

async function listRecordsByConfigKey(env, token, configKey, since, limit) {
  const idxKey = `idx:${token}:${configKey}`;
  const idx = (await env.PLAYBACK_KV.get(idxKey, 'json')) || [];
  const items = [];
  for (const dedupeKey of idx) {
    if (items.length >= limit) break;
    const rec = await env.PLAYBACK_KV.get(`rec:${token}:${configKey}:${dedupeKey}`, 'json');
    if (rec && rec.updatedAt > since) items.push(stripInternalFields(rec));
  }
  return items;
}

async function listAllRecords(env, token, since, limit) {
  const configKeys = await listConfigKeys(env, token);
  const items = [];
  for (const configKey of configKeys) {
    if (items.length >= limit) break;
    const batch = await listRecordsByConfigKey(env, token, configKey, since, limit - items.length);
    items.push(...batch);
  }
  return items;
}

async function listConfigKeys(env, token) {
  // KV 不支持前缀列表查询，通过一个汇总 key 维护 configKey 列表
  const list = (await env.PLAYBACK_KV.get(`configs:${token}`, 'json')) || [];
  return list;
}

async function deleteByConfigKey(env, token, configKey) {
  const idxKey = `idx:${token}:${configKey}`;
  const idx = (await env.PLAYBACK_KV.get(idxKey, 'json')) || [];
  let deleted = 0;
  for (const dedupeKey of idx) {
    await env.PLAYBACK_KV.delete(`rec:${token}:${configKey}:${dedupeKey}`);
    deleted++;
  }
  await env.PLAYBACK_KV.delete(idxKey);
  await removeFromConfigs(env, token, configKey);
  // 更新元数据计数
  const metaKey = `token:${token}`;
  let meta = (await env.PLAYBACK_KV.get(metaKey, 'json')) || { count: 0, lastUpdate: 0 };
  meta.count = Math.max(0, (meta.count || 0) - deleted);
  await env.PLAYBACK_KV.put(metaKey, JSON.stringify(meta));
  return deleted;
}

async function deleteAllRecords(env, token) {
  const configKeys = await listConfigKeys(env, token);
  let deleted = 0;
  for (const configKey of configKeys) {
    deleted += await deleteByConfigKey(env, token, configKey);
  }
  await env.PLAYBACK_KV.delete(`token:${token}`);
  await env.PLAYBACK_KV.delete(`configs:${token}`);
  return deleted;
}

async function removeFromConfigs(env, token, configKey) {
  const cfgKey = `configs:${token}`;
  let list = (await env.PLAYBACK_KV.get(cfgKey, 'json')) || [];
  list = list.filter(k => k !== configKey);
  await env.PLAYBACK_KV.put(cfgKey, JSON.stringify(list));
}

function markEventProcessed(ctx, env, token, eventId) {
  if (!eventId) return;
  ctx.waitUntil(
    env.PLAYBACK_KV.put(`evt:${token}:${eventId}`, '1', { expirationTtl: EVENT_TTL })
  );
}

function stripInternalFields(rec) {
  const { ...publicRec } = rec;
  return publicRec;
}

// ======================== 工具函数 ========================

function extractToken(request) {
  return (
    request.headers.get('X-WebHTV-Token') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    new URL(request.url).searchParams.get('token') ||
    ''
  ).trim();
}

function jsonResponse(data, status = 200) {
  return corsResponse(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    })
  );
}

function corsResponse(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-WebHTV-Token, X-WebHTV-Config-Key, X-WebHTV-Config-Name, X-WebHTV-Webhook-Id, X-WebHTV-Dedupe-Key, X-WebHTV-Timestamp, Idempotency-Key, Authorization');
  return response;
}
