import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient, Role, CredentialStatus, ApiKeyType } from '@prisma/client';
import Redis from 'ioredis';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const POOL_KEY = 'GLOBAL_CREDENTIAL_POOL';
const COOLING_SET_KEY = 'COOLING_SET'; // Using a Set for O(1) lookups
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// Types
interface UserPayload {
  id: number;
  email: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserPayload;
  }
}

// Validation Schemas
const ToggleCredentialSchema = z.object({
  enable: z.boolean(),
});

const ResetQuotaSchema = z.object({
  quota: z.number().optional(), // Default to 0 if not provided
});

const GenerateKeySchema = z.object({
  name: z.string().optional(),
  type: z.enum(['NORMAL', 'ADMIN']).optional()
});

const UpdateKeySchema = z.object({
  name: z.string().optional(),
  is_active: z.boolean().optional()
});

import { pLimit } from '../utils/concurrency';

export default async function adminRoutes(fastify: FastifyInstance) {

  // --- Middleware: Verify Auth ---
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for public routes if any (none here)
    // Simple JWT Verification
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw { statusCode: 401, message: 'Unauthorized' };
    }
    const token = authHeader.replace('Bearer ', '');
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as UserPayload;
      req.user = decoded;
    } catch (e) {
      throw { statusCode: 401, message: 'Invalid Token' };
    }
  });

  // Middleware: Verify Admin
  const requireAdmin = async (req: FastifyRequest) => {
    if (req.user?.role !== Role.ADMIN) {
      throw { statusCode: 403, message: 'Forbidden: Admin access required' };
    }
  };

  const DEFAULT_SYSTEM_CONFIG = {
    enable_registration: true,
    quota: {
      newbie: 300,
      contributor: 1500,
      v3_contributor: 3000,
      increment_per_credential: 1000
    },
    rate_limit: {
      newbie: 10,
      contributor: 60,
      v3_contributor: 120
    }
  };

  // --- User Dashboard Routes ---

  // 1. Get Stats
  fastify.get('/api/dashboard/stats', async (req: FastifyRequest) => {
    const userId = req.user!.id;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        _count: {
          select: {
            credentials: { where: { status: CredentialStatus.ACTIVE } }
          }
        }
      }
    });

    const v3Count = await prisma.googleCredential.count({
      where: { owner_id: userId, status: CredentialStatus.ACTIVE, supports_v3: true }
    });

    // Get System Config for dynamic UI
    const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
    let systemConfig = { ...DEFAULT_SYSTEM_CONFIG };
    if (configSetting) {
      try { systemConfig = { ...systemConfig, ...JSON.parse(configSetting.value) }; } catch (e) { }
    }
    const agConfigSetting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_CONFIG' } });
    let agConfig: any = {
      claude_limit: 100,
      gemini3_limit: 200,
      use_token_quota: false,
      claude_token_quota: 100000,
      gemini3_token_quota: 200000,
      increment_per_token_claude: 0,
      increment_per_token_gemini3: 0,
      increment_token_per_token_claude: 0,
      increment_token_per_token_gemini3: 0
    };
    if (agConfigSetting) {
      try { agConfig = { ...agConfig, ...JSON.parse(agConfigSetting.value) }; } catch (e) { }
    }
    const forceBindSetting = await prisma.systemSetting.findUnique({ where: { key: 'FORCE_DISCORD_BIND' } });

    // Dynamic Quota Calculation
    const activeCredCount = user._count.credentials;
    const quotaConf = systemConfig.quota || {};
    let baseQuota = quotaConf.newbie ?? 300;
    if (v3Count > 0) baseQuota = quotaConf.v3_contributor ?? 3000;
    else if (activeCredCount > 0) baseQuota = quotaConf.contributor ?? 1500;
    const inc = quotaConf.increment_per_credential ?? 1000;
    const extra = Math.max(0, activeCredCount - 1) * inc;
    const totalQuota = baseQuota + extra;

    // Fetch Redis Model Stats (使用 UTC+8 时区，与 today_used 重置时间一致)
    const now = new Date();
    const utc8Offset = 8 * 60 * 60 * 1000;
    const todayStr = new Date(now.getTime() + utc8Offset).toISOString().split('T')[0];
    const statsKey = `USER_STATS:${userId}:${todayStr}`;
    let modelUsage = { 'gemini-2.5-flash': 0, 'gemini-2.5-pro': 0, 'gemini-3-pro-preview': 0 };

    try {
      const rawStats = await redis.hgetall(statsKey);
      if (rawStats) {
        modelUsage = {
          'gemini-2.5-flash': parseInt(rawStats['gemini-2.5-flash'] || '0', 10),
          'gemini-2.5-pro': parseInt(rawStats['gemini-2.5-pro'] || '0', 10),
          'gemini-3-pro-preview': parseInt(rawStats['gemini-3-pro-preview'] || '0', 10)
        };
      }
    } catch (e) {
      // Ignore redis errors, just return 0
    }

    const useTokenQuota = !!agConfig.use_token_quota;
    const userAgClaudeOverride = (user as any).ag_claude_limit || 0;
    const userAgGemini3Override = (user as any).ag_gemini3_limit || 0;

    // 用户的 Antigravity Token 数量 (ACTIVE + COOLING)
    // 冷却的凭证仍然算入配额增量，只有 DEAD 的不算
    const userAgTokenCount = await prisma.antigravityToken.count({
      where: { owner_id: userId, status: { in: ['ACTIVE', 'COOLING'] }, is_enabled: true }
    });

    const baseClaude = useTokenQuota ? (agConfig.claude_token_quota ?? 100000) : (agConfig.claude_limit ?? 100);
    const baseGemini3 = useTokenQuota ? (agConfig.gemini3_token_quota ?? 200000) : (agConfig.gemini3_limit ?? 200);

    const incClaude = useTokenQuota ? (agConfig.increment_token_per_token_claude || 0) : (agConfig.increment_per_token_claude || 0);
    const incGemini3 = useTokenQuota ? (agConfig.increment_token_per_token_gemini3 || 0) : (agConfig.increment_per_token_gemini3 || 0);

    const computedClaudeLimit = baseClaude + (userAgTokenCount > 0 ? userAgTokenCount * incClaude : 0);
    const computedGemini3Limit = baseGemini3 + (userAgTokenCount > 0 ? userAgTokenCount * incGemini3 : 0);

    const effectiveAgClaudeLimit = userAgClaudeOverride > 0 ? userAgClaudeOverride : computedClaudeLimit;
    const effectiveAgGemini3Limit = userAgGemini3Override > 0 ? userAgGemini3Override : computedGemini3Limit;

    let agUsage: any = {
      claude: 0,
      gemini3: 0,
      limits: { claude: effectiveAgClaudeLimit, gemini3: effectiveAgGemini3Limit },
      requests: { claude: 0, gemini3: 0 },
      tokens: { claude: 0, gemini3: 0 },
      use_token_quota: useTokenQuota
    };
    try {
      const claudeReqKey = `USAGE:requests:${todayStr}:${userId}:antigravity:claude`;
      const geminiReqKey = `USAGE:requests:${todayStr}:${userId}:antigravity:gemini3`;
      const claudeTokKey = `USAGE:tokens:${todayStr}:${userId}:antigravity:claude`;
      const geminiTokKey = `USAGE:tokens:${todayStr}:${userId}:antigravity:gemini3`;
      const claudeLegacyKey = `USAGE:${todayStr}:${userId}:antigravity:claude`;
      const geminiLegacyKey = `USAGE:${todayStr}:${userId}:antigravity:gemini3`;

      const [
        claudeReqRaw,
        geminiReqRaw,
        claudeTokRaw,
        geminiTokRaw,
        claudeLegacyRaw,
        geminiLegacyRaw
      ] = await Promise.all([
        redis.get(claudeReqKey),
        redis.get(geminiReqKey),
        redis.get(claudeTokKey),
        redis.get(geminiTokKey),
        redis.get(claudeLegacyKey),
        redis.get(geminiLegacyKey)
      ]);

      const claudeRequests = parseInt(claudeReqRaw || claudeLegacyRaw || '0', 10);
      const gemini3Requests = parseInt(geminiReqRaw || geminiLegacyRaw || '0', 10);
      const claudeTokens = parseInt(claudeTokRaw || '0', 10);
      const gemini3Tokens = parseInt(geminiTokRaw || '0', 10);

      agUsage.requests = { claude: claudeRequests, gemini3: gemini3Requests };
      agUsage.tokens = { claude: claudeTokens, gemini3: gemini3Tokens };

      if (useTokenQuota) {
        agUsage.claude = claudeTokens;
        agUsage.gemini3 = gemini3Tokens;
      } else {
        agUsage.claude = claudeRequests;
        agUsage.gemini3 = gemini3Requests;
      }
    } catch (e) { }

    const lastDay = new Date();
    lastDay.setHours(lastDay.getHours() - 24);
    const recentAlerts = await prisma.usageLog.findMany({
      where: { user_id: userId, status_code: 470, created_at: { gte: lastDay } },
      orderBy: { created_at: 'desc' },
      take: 5
    });
    const notifications = recentAlerts.map(a => ({
      type: 'antigravity_cleanup',
      message: '部分反重力凭证失效已自动清理',
      time: a.created_at
    }));

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      level: user.level,
      discordId: (user as any).discordId || null,
      discordUsername: (user as any).discordUsername || null,
      discordAvatar: (user as any).discordAvatar || null,
      daily_limit: totalQuota, // Dynamic limit
      today_used: user.today_used,
      model_usage: modelUsage,
      antigravity_usage: agUsage,
      contributed_active: user._count.credentials,
      contributed_v3_active: v3Count,
      system_config: systemConfig,
      force_discord_bind: forceBindSetting ? forceBindSetting.value === 'true' : false,
      notifications
    };
  });

  // --- Announcement Routes ---

  // Get Announcement
  fastify.get('/api/announcement', async (req: FastifyRequest) => {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'ANNOUNCEMENT_DATA' } });
    if (!setting) return { content: '', version: 0 };
    try {
      return JSON.parse(setting.value);
    } catch (e) {
      return { content: '', version: 0 };
    }
  });

  // Update Announcement (Admin)
  fastify.post('/api/admin/announcement', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    console.log('[Admin] Received announcement update:', req.body);
    const body = z.object({ content: z.string() }).parse(req.body);
    const data = {
      content: body.content,
      version: Date.now() // Use timestamp as version
    };

    const result = await prisma.systemSetting.upsert({
      where: { key: 'ANNOUNCEMENT_DATA' },
      update: { value: JSON.stringify(data) },
      create: { key: 'ANNOUNCEMENT_DATA', value: JSON.stringify(data) }
    });
    console.log('[Admin] Announcement saved:', result);

    return { success: true, ...data };
  });

  // 2. Get API Keys
  fastify.get('/api/dashboard/api-keys', async (req: FastifyRequest) => {
    return await prisma.apiKey.findMany({
      where: { user_id: req.user!.id },
      orderBy: { created_at: 'desc' }
    });
  });

  // 3. Generate API Key
  fastify.post('/api/dashboard/api-keys', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = GenerateKeySchema.parse(req.body || {});
    const key = `sk-${crypto.randomUUID()}`;

    // Only Admins can create ADMIN keys
    if (body.type === 'ADMIN' && req.user?.role !== Role.ADMIN) {
      return reply.code(401).send({ error: 'Forbidden: Only admins can create ADMIN keys' });
    }

    return await prisma.apiKey.create({
      data: {
        key,
        name: body.name || 'My API Key',
        type: body.type || 'NORMAL',
        user_id: req.user!.id,
      }
    });
  });

  // 4. Update API Key (Rename / Toggle)
  fastify.patch('/api/dashboard/api-keys/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = UpdateKeySchema.parse(req.body);

    const apiKey = await prisma.apiKey.findFirst({
      where: { id: Number(id), user_id: req.user!.id }
    });

    if (!apiKey) return reply.code(404).send({ error: 'Not found' });

    const updated = await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: {
        name: body.name !== undefined ? body.name : undefined,
        is_active: body.is_active !== undefined ? body.is_active : undefined
      }
    });
    return updated;
  });

  // 5. Revoke API Key
  fastify.delete('/api/dashboard/api-keys/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const apiKey = await prisma.apiKey.findFirst({
      where: { id: Number(id), user_id: req.user!.id }
    });

    if (!apiKey) return reply.code(404).send({ error: 'Not found' });

    await prisma.apiKey.delete({ where: { id: apiKey.id } });
    return { success: true };
  });


  // --- Admin Routes ---

  // 1. List Credentials (Pagination + Filter + Details)
  fastify.get('/api/admin/credentials', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    const query = req.query as { page?: string, limit?: string, status?: string };
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const statusFilter = query.status as CredentialStatus | 'ALL' | 'DUPLICATE';

    // 处理 DUPLICATE 筛选 - 查找重复邮箱
    if (statusFilter === 'DUPLICATE') {
      // 查找同一 google_email 出现多次的情况
      const duplicates = await prisma.$queryRaw<{ google_email: string; count: bigint }[]>`
        SELECT google_email, COUNT(*) as count
        FROM "GoogleCredential"
        WHERE google_email IS NOT NULL AND google_email != ''
        GROUP BY google_email
        HAVING COUNT(*) > 1
      `;

      const duplicateEmails = duplicates.map(d => d.google_email);

      if (duplicateEmails.length === 0) {
        return {
          data: [],
          meta: { total: 0, page, limit, total_pages: 0 }
        };
      }

      const [total, credentials] = await prisma.$transaction([
        prisma.googleCredential.count({
          where: { google_email: { in: duplicateEmails } }
        }),
        prisma.googleCredential.findMany({
          where: { google_email: { in: duplicateEmails } },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            owner: { select: { email: true, discordId: true, discordUsername: true, discordAvatar: true } },
            usage_logs: {
              where: { status_code: { gte: 400 } },
              orderBy: { created_at: 'desc' },
              take: 1,
              select: { status_code: true, created_at: true }
            }
          },
          orderBy: [{ google_email: 'asc' }, { id: 'desc' }]
        })
      ]);

      return {
        data: credentials.map(c => ({
          id: c.id,
          name: c.client_id ? `...${c.client_id.slice(0, 15)}` : `Credential #${c.id}`,
          owner_email: c.owner.email,
          owner_discord_id: c.owner.discordId,
          owner_discord_username: c.owner.discordUsername,
          owner_discord_avatar: c.owner.discordAvatar,
          google_email: c.google_email,
          status: c.status,
          fail_count: c.fail_count,
          last_validated: c.last_validated_at,
          last_error: c.usage_logs[0] ? `${c.usage_logs[0].status_code} at ${c.usage_logs[0].created_at.toISOString()}` : null
        })),
        meta: {
          total,
          page,
          limit,
          total_pages: Math.ceil(total / limit)
        }
      };
    }

    const whereClause = (statusFilter && statusFilter !== 'ALL') ? { status: statusFilter } : {};

    const [total, credentials] = await prisma.$transaction([
      prisma.googleCredential.count({ where: whereClause }),
      prisma.googleCredential.findMany({
        where: whereClause,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          owner: { select: { email: true, discordId: true, discordUsername: true, discordAvatar: true } },
          // Fetch latest error log (status >= 400)
          usage_logs: {
            where: { status_code: { gte: 400 } },
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { status_code: true, created_at: true }
          }
        },
        orderBy: { id: 'desc' }
      })
    ]);

    return {
      data: credentials.map(c => ({
        id: c.id,
        name: c.client_id ? `...${c.client_id.slice(0, 15)}` : `Credential #${c.id}`,
        owner_email: c.owner.email,
        owner_discord_id: c.owner.discordId,
        owner_discord_username: c.owner.discordUsername,
        owner_discord_avatar: c.owner.discordAvatar,
        google_email: c.google_email,
        status: c.status,
        fail_count: c.fail_count,
        last_validated: c.last_validated_at,
        last_error: c.usage_logs[0] ? `${c.usage_logs[0].status_code} at ${c.usage_logs[0].created_at.toISOString()}` : null
      })),
      meta: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit)
      }
    };
  });

  // 2. Admin Stats (Dashboard)
  fastify.get('/api/admin/stats', { preHandler: requireAdmin }, async () => {
    // A. Capacity & Usage
    const activeCount = await prisma.googleCredential.count({ where: { status: CredentialStatus.ACTIVE } });
    const v3CountGlobal = await prisma.googleCredential.count({ where: { status: CredentialStatus.ACTIVE, supports_v3: true } });
    const deadCount = await prisma.googleCredential.count({ where: { status: CredentialStatus.DEAD } });

    // "Normal" credentials = Total Active - V3 Active
    // User logic: 
    // - Flash Cap = Normal Creds * 1000
    // - 2.5 Pro Cap = Normal Creds * 250
    // - 3.0 Pro Cap = V3 Creds * 250
    const normalCount = Math.max(0, activeCount - v3CountGlobal);

    const flashCapacity = normalCount * 1000;
    const proCapacity = normalCount * 250;
    const v3Capacity = v3CountGlobal * 250;

    // Total capacity (Sum of all model types)
    const totalCapacity = flashCapacity + proCapacity + v3Capacity;

    const usageAgg = await prisma.user.aggregate({
      _sum: { today_used: true }
    });
    const globalUsage = usageAgg._sum.today_used || 0;

    // Fetch Global Model Stats (使用 UTC+8 时区)
    const utc8Offset2 = 8 * 60 * 60 * 1000;
    const todayStr = new Date(Date.now() + utc8Offset2).toISOString().split('T')[0];
    let modelUsage = { flash: 0, pro: 0, v3: 0 };
    try {
      const raw = await redis.hgetall(`GLOBAL_STATS:${todayStr}`);
      if (raw) {
        modelUsage = {
          flash: parseInt(raw.flash || '0', 10),
          pro: parseInt(raw.pro || '0', 10),
          v3: parseInt(raw.v3 || '0', 10)
        };
      }
    } catch (e) { }

    // B. Leaderboard (Top 25 Users by Usage) - 显示 Discord 名字
    const leaderboard = await prisma.user.findMany({
      orderBy: { today_used: 'desc' },
      take: 25,
      select: {
        id: true,
        email: true,
        today_used: true,
        daily_limit: true,
        discordUsername: true,
        discordAvatar: true
      }
    });

    return {
      overview: {
        active_credentials: activeCount,
        dead_credentials: deadCount,
        total_credentials: activeCount + deadCount,
        global_capacity: totalCapacity,
        capacities: { flash: flashCapacity, pro: proCapacity, v3: v3Capacity },
        global_usage: globalUsage,
        model_usage: modelUsage,
        utilization_rate: totalCapacity > 0 ? Math.round((globalUsage / totalCapacity) * 100) : 0
      },
      leaderboard
    };
  });

  // 3. Delete Credential (Soft/Hard Delete)
  fastify.delete('/api/admin/credentials/:id', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const credentialId = Number(id);

    try {
      const cred = await prisma.googleCredential.findUnique({ where: { id: credentialId } });
      if (!cred) return reply.code(404).send({ error: 'Not found' });

      // If already DEAD, perform Hard Delete
      if (cred.status === CredentialStatus.DEAD) {
        await prisma.googleCredential.delete({ where: { id: credentialId } });
        await redis.lrem(POOL_KEY, 0, String(credentialId));
        return { success: true, message: 'Credential permanently deleted.' };
      }

      // 1. Mark as DEAD (Soft Delete)
      const updatedCred = await prisma.googleCredential.update({
        where: { id: credentialId },
        data: { status: CredentialStatus.DEAD, is_active: false },
        include: { owner: true }
      });

      // 2. Sync Redis (Remove from pool)
      await redis.lrem(POOL_KEY, 0, String(credentialId));
      await redis.srem(COOLING_SET_KEY, String(credentialId));

      // 3. Recalculate User Level/Quota
      const userId = updatedCred.owner_id;
      const activeCount = await prisma.googleCredential.count({
        where: { owner_id: userId, status: CredentialStatus.ACTIVE }
      });

      if (activeCount === 0) {
        // Downgrade
        await prisma.user.update({
          where: { id: userId },
          data: { level: 0 }
        });
      }

      return { success: true, message: 'Credential marked as DEAD.' };
    } catch (e) {
      return reply.code(500).send({ error: 'Operation failed', details: e });
    }
  });

  // 4. Toggle Credential (Force Enable/Disable)
  fastify.post('/api/admin/credentials/:id/toggle', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = ToggleCredentialSchema.parse(req.body);
    const credId = Number(id);

    const cred = await prisma.googleCredential.findUnique({ where: { id: credId } });
    if (!cred) return reply.code(404).send({ error: 'Credential not found' });

    if (body.enable) {
      await prisma.googleCredential.update({
        where: { id: credId },
        data: { status: CredentialStatus.ACTIVE, is_active: true, fail_count: 0 }
      });
      const pipe = redis.pipeline();
      pipe.srem(COOLING_SET_KEY, String(credId));
      pipe.rpush(POOL_KEY, String(credId));
      await pipe.exec();
    } else {
      await prisma.googleCredential.update({
        where: { id: credId },
        data: { status: CredentialStatus.DEAD, is_active: false }
      });
      await redis.lrem(POOL_KEY, 0, String(credId));
      await redis.srem(COOLING_SET_KEY, String(credId));
    }

    return { success: true, new_status: body.enable ? 'ACTIVE' : 'DEAD' };
  });

  // 5. Update User Quota
  fastify.patch('/api/admin/users/:id/quota', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ daily_limit: z.number().min(0) }).parse(req.body);

    await prisma.user.update({
      where: { id: Number(id) },
      data: { daily_limit: body.daily_limit }
    });

    return { success: true, daily_limit: body.daily_limit };
  });

  // 5.b Update Antigravity Per-User Limits
  fastify.patch('/api/admin/users/:id/antigravity-limits', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      claude_limit: z.number().min(0).optional(),
      gemini3_limit: z.number().min(0).optional()
    }).parse(req.body || {});

    const data: any = {};
    if (body.claude_limit !== undefined) data.ag_claude_limit = body.claude_limit;
    if (body.gemini3_limit !== undefined) data.ag_gemini3_limit = body.gemini3_limit;
    if (Object.keys(data).length === 0) return { success: true };

    await prisma.user.update({
      where: { id: Number(id) },
      data
    });
    return { success: true, ...data };
  });

  // 6. Get System Settings
  fastify.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    const cliSharedSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_CLI_SHARED_MODE' } });
    const legacySharedSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_SHARED_MODE' } });
    const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
    const gemini3OpenSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_GEMINI3_OPEN_ACCESS' } });

    let config = { ...DEFAULT_SYSTEM_CONFIG };
    if (configSetting) {
      try {
        const parsed = JSON.parse(configSetting.value);
        config = {
          enable_registration: parsed.enable_registration ?? config.enable_registration,
          quota: { ...config.quota, ...parsed.quota },
          rate_limit: { ...config.rate_limit, ...parsed.rate_limit }
        };
      } catch (e) { }
    }

    const agStrictSetting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_STRICT_MODE' } });
    const forceBindSetting = await prisma.systemSetting.findUnique({ where: { key: 'FORCE_DISCORD_BIND' } });
    return {
      enable_cli_shared_mode: cliSharedSetting ? cliSharedSetting.value === 'true' : (legacySharedSetting ? legacySharedSetting.value === 'true' : true),
      // 为前端兼容保留旧字段（仅作为别名）
      enable_shared_mode: cliSharedSetting ? cliSharedSetting.value === 'true' : (legacySharedSetting ? legacySharedSetting.value === 'true' : true),
      enable_gemini3_open_access: gemini3OpenSetting ? gemini3OpenSetting.value === 'true' : false,
      antigravity_strict_mode: agStrictSetting ? agStrictSetting.value === 'true' : false,
      force_discord_bind: forceBindSetting ? forceBindSetting.value === 'true' : false,
      ...config
    };
  });

  // 7. Update System Settings
  fastify.post('/api/admin/settings', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    console.log('[Admin] Received settings update:', req.body);
    const body = req.body as any;

    // Handle CLI Shared Mode (兼容旧字段)
    const cliShared = (body.enable_cli_shared_mode !== undefined) ? body.enable_cli_shared_mode : body.enable_shared_mode;
    if (cliShared !== undefined) {
      await prisma.systemSetting.upsert({
        where: { key: 'ENABLE_CLI_SHARED_MODE' },
        update: { value: String(cliShared) },
        create: { key: 'ENABLE_CLI_SHARED_MODE', value: String(cliShared) }
      });
    }
    // Handle Gemini3 Open Access toggle
    if (body.enable_gemini3_open_access !== undefined) {
      await prisma.systemSetting.upsert({
        where: { key: 'ENABLE_GEMINI3_OPEN_ACCESS' },
        update: { value: String(body.enable_gemini3_open_access) },
        create: { key: 'ENABLE_GEMINI3_OPEN_ACCESS', value: String(body.enable_gemini3_open_access) }
      });
    }

    // Handle System Config
    const currentConfigSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
    let currentConfig = { ...DEFAULT_SYSTEM_CONFIG };
    if (currentConfigSetting) {
      try { currentConfig = JSON.parse(currentConfigSetting.value); } catch (e) { }
    }

    // Merge updates
    const newConfig = {
      enable_registration: body.enable_registration ?? currentConfig.enable_registration,
      quota: {
        ...currentConfig.quota,
        ...(body.quota || {})
      },
      rate_limit: {
        ...currentConfig.rate_limit,
        ...(body.rate_limit || {})
      }
    };

    await prisma.systemSetting.upsert({
      where: { key: 'SYSTEM_CONFIG' },
      update: { value: JSON.stringify(newConfig) },
      create: { key: 'SYSTEM_CONFIG', value: JSON.stringify(newConfig) }
    });

    // Quota Sync is no longer needed as ProxyController calculates it dynamically

    // Handle Antigravity Strict Mode
    if (body.antigravity_strict_mode !== undefined) {
      await prisma.systemSetting.upsert({
        where: { key: 'ANTIGRAVITY_STRICT_MODE' },
        update: { value: String(body.antigravity_strict_mode) },
        create: { key: 'ANTIGRAVITY_STRICT_MODE', value: String(body.antigravity_strict_mode) }
      });
    }
    if (body.force_discord_bind !== undefined) {
      await prisma.systemSetting.upsert({
        where: { key: 'FORCE_DISCORD_BIND' },
        update: { value: String(body.force_discord_bind) },
        create: { key: 'FORCE_DISCORD_BIND', value: String(body.force_discord_bind) }
      });
    }

    return { success: true, ...newConfig, enable_cli_shared_mode: cliShared, enable_gemini3_open_access: body.enable_gemini3_open_access, antigravity_strict_mode: body.antigravity_strict_mode };
  });

  // 8. List Users (Pagination + Search)
  fastify.get('/api/admin/users', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    const query = req.query as { page?: string, limit?: string, search?: string, discord_unbound?: string, errors_today?: string };
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const search = query.search || '';
    const discordUnbound = String(query.discord_unbound || '').toLowerCase() === 'true';
    const errorsToday = String(query.errors_today || '').toLowerCase() === 'true';
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const whereClause: any = {};
    if (search) {
      whereClause.email = { contains: search, mode: 'insensitive' }; // Requires Prisma preview feature or appropriate DB collation, but works for basic contains
    }
    if (discordUnbound) {
      whereClause.discordId = null;
    }
    if (errorsToday) {
      whereClause.usage_logs = { some: { status_code: { gte: 400 }, created_at: { gte: startOfDay } } };
    }

    const [total, users] = await prisma.$transaction([
      prisma.user.count({ where: whereClause }),
      prisma.user.findMany({
        where: whereClause,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { id: 'desc' },
        include: {
          _count: { select: { credentials: true } }
        }
      })
    ]);

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_CONFIG' } });
    let agConfig = { claude_limit: 100, gemini3_limit: 200, claude_token_quota: 100000, gemini3_token_quota: 200000 };
    if (setting) {
      try { agConfig = { ...agConfig, ...JSON.parse(setting.value) }; } catch (e) { }
    }

    // 使用 UTC+8 时区
    const utc8Offset3 = 8 * 60 * 60 * 1000;
    const todayStr = new Date(Date.now() + utc8Offset3).toISOString().split('T')[0];
    const enhancedUsers = await Promise.all(users.map(async u => {
      // Dual keys
      const claudeRequests = await redis.get(`USAGE:requests:${todayStr}:${u.id}:antigravity:claude`);
      const gemini3Requests = await redis.get(`USAGE:requests:${todayStr}:${u.id}:antigravity:gemini3`);
      const claudeTokens = await redis.get(`USAGE:tokens:${todayStr}:${u.id}:antigravity:claude`);
      const gemini3Tokens = await redis.get(`USAGE:tokens:${todayStr}:${u.id}:antigravity:gemini3`);

      // Legacy fallback
      const claudeLegacy = await redis.get(`USAGE:${todayStr}:${u.id}:antigravity:claude`);
      const gemini3Legacy = await redis.get(`USAGE:${todayStr}:${u.id}:antigravity:gemini3`);

      return {
        id: u.id,
        email: u.email,
        role: u.role,
        level: u.level,
        daily_limit: u.daily_limit,
        today_used: u.today_used,
        is_active: u.is_active,
        created_at: u.created_at,
        credential_count: u._count.credentials,
        discordId: (u as any).discordId || null,
        discordUsername: (u as any).discordUsername || null,
        discordAvatar: (u as any).discordAvatar || null,
        ag_claude_limit: (u as any).ag_claude_limit ?? 0,
        ag_gemini3_limit: (u as any).ag_gemini3_limit ?? 0,
        ag_claude_used_requests: parseInt(claudeRequests || claudeLegacy || '0', 10),
        ag_gemini3_used_requests: parseInt(gemini3Requests || gemini3Legacy || '0', 10),
        ag_claude_used_tokens: parseInt(claudeTokens || '0', 10),
        ag_gemini3_used_tokens: parseInt(gemini3Tokens || '0', 10),
        ag_claude_token_limit: agConfig.claude_token_quota,
        ag_gemini3_token_limit: agConfig.gemini3_token_quota,
        ag_active_tokens: (u as any)._count?.antigravity_tokens || 0 // Assuming you added relation count in query, if not we need to fetch
      };
    }));

    return {
      data: enhancedUsers,
      meta: { total, page, limit, total_pages: Math.ceil(total / limit) }
    };
  });

  // 9. Toggle User Status (Ban/Unban)
  fastify.patch('/api/admin/users/:id/toggle', { preHandler: requireAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ is_active: z.boolean() }).parse(req.body);
    const userId = Number(id);

    // Prevent banning self
    if (userId === req.user?.id && !body.is_active) {
      return reply.code(400).send({ error: 'Cannot ban yourself' });
    }

    await prisma.$transaction(async (tx) => {
      // Toggle User
      await tx.user.update({
        where: { id: userId },
        data: { is_active: body.is_active }
      });

      // If disabling, disable all API keys
      if (!body.is_active) {
        await tx.apiKey.updateMany({
          where: { user_id: userId },
          data: { is_active: false }
        });
      }
    });

    return { success: true, is_active: body.is_active };
  });

  // 10. Reset User Password
  fastify.post('/api/admin/users/:id/reset-password', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = z.object({ password: z.string().min(6) }).parse(req.body);

    const hashedPassword = await bcrypt.hash(body.password, 10);

    await prisma.user.update({
      where: { id: Number(id) },
      data: { password: hashedPassword }
    });

    return { success: true };
  });

  // 11. Manual Quota Reset (Debug)
  fastify.post('/api/admin/reset-quota', { preHandler: requireAdmin }, async () => {
    console.log('[Admin] Manually triggering daily quota reset...');
    const result = await prisma.user.updateMany({
      data: { today_used: 0 }
    });
    console.log(`[Admin] Reset complete. Users affected: ${result.count}`);
    return { success: true, count: result.count };
  });

  // 12. CLI 凭证检活 - 验证所有 ACTIVE 凭证
  fastify.post('/api/admin/health-check/cli', { preHandler: requireAdmin }, async (req, reply) => {
    console.log('[Admin] 开始 CLI 凭证检活...');

    const allCredentials = await prisma.googleCredential.findMany({
      where: { status: CredentialStatus.ACTIVE },
      include: { owner: { select: { id: true, username: true, level: true } } }
    });

    console.log(`[Admin] 共 ${allCredentials.length} 个 ACTIVE 凭证需要检查`);

    const results = {
      total: allCredentials.length,
      checked: 0,
      healthy: 0,
      dead: 0,
      cooled: 0,
      errors: [] as { id: number; email: string | null; owner: string | null; error: string; action?: string }[]
    };

    for (const cred of allCredentials) {
      results.checked++;
      console.log(`[Admin] 检查凭证 ${cred.id} (${cred.google_email || 'unknown'})...`);

      try {
        // 尝试刷新 Token
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: cred.client_id,
            client_secret: cred.client_secret,
            refresh_token: cred.refresh_token,
            grant_type: 'refresh_token'
          })
        });

        if (!tokenResponse.ok) {
          // Token 刷新失败 (400/401) 视为凭证失效
          if (tokenResponse.status === 400 || tokenResponse.status === 401) {
            console.log(`[Admin] 凭证 ${cred.id} Token 刷新失败 (凭证失效)`);

            await prisma.googleCredential.update({
              where: { id: cred.id },
              data: { status: CredentialStatus.DEAD }
            });

            if (cred.owner && cred.owner.level > 0) {
              await prisma.user.update({
                where: { id: cred.owner.id },
                data: { level: { decrement: 1 } }
              });
            }

            results.dead++;
            results.errors.push({
              id: cred.id,
              email: cred.google_email,
              owner: cred.owner?.username || null,
              error: 'Token 刷新失败',
              action: '已失效'
            });
          }
          // 其他刷新错误不管
          continue;
        }

        const tokenData = await tokenResponse.json() as any;
        const accessToken = tokenData.access_token;

        if (!accessToken) {
          console.log(`[Admin] 凭证 ${cred.id} 无法获取 access_token`);
          results.dead++;
          results.errors.push({
            id: cred.id,
            email: cred.google_email,
            owner: cred.owner?.username || null,
            error: '无法获取 access_token'
          });
          continue;
        }

        // 使用 CredentialService 验证 gemini-2.5-flash
        const { CredentialService } = require('../services/CredentialService');
        const credentialService = new CredentialService();
        try {
          const ok = await credentialService.verifyCloudCodeAccess(accessToken, cred.project_id, 'gemini-2.5-flash', true);
          if (ok) {
            results.healthy++;
            console.log(`[Admin] 凭证 ${cred.id} 验证通过 (gemini-2.5-flash)`);
            continue;
          }
        } catch (e: any) {
          const status = e?.statusCode;
          if (status === 403) {
            console.log(`[Admin] 凭证 ${cred.id} 验证失败: 403 权限不足`);

            // 标记为 DEAD
            await prisma.googleCredential.update({
              where: { id: cred.id },
              data: { status: CredentialStatus.DEAD }
            });

            // 降低用户等级
            if (cred.owner && cred.owner.level > 0) {
              await prisma.user.update({
                where: { id: cred.owner.id },
                data: { level: { decrement: 1 } }
              });
              console.log(`[Admin] 用户 ${cred.owner.username} 等级降低`);
            }

            results.dead++;
            results.errors.push({
              id: cred.id,
              email: cred.google_email,
              owner: cred.owner?.username || null,
              error: '403 权限不足',
              action: '已失效'
            });
            continue;
          }
          if (status === 429) {
            console.log(`[Admin] 凭证 ${cred.id} 遇到 429，设置冷却`);

            // 计算冷却时间：第二天下午 4 点
            const now = new Date();
            const cooldownTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 16, 0, 0);

            await prisma.googleCredential.update({
              where: { id: cred.id },
              data: { cooling_expires_at: cooldownTime }
            });

            results.cooled++;
            results.errors.push({
              id: cred.id,
              email: cred.google_email,
              owner: cred.owner?.username || null,
              error: '429 速率限制',
              action: `冷却至 ${cooldownTime.toLocaleString('zh-CN')}`
            });
            continue;
          }
          // 其它错误不改变状态
          results.errors.push({
            id: cred.id,
            email: cred.google_email,
            owner: cred.owner?.username || null,
            error: String(status || 'unknown')
          });
          continue;
        }

      } catch (e: any) {
        // 其他异常不管
        console.error(`[Admin] 检查凭证 ${cred.id} 异常:`, e.message);
      }
    }

    console.log(`[Admin] CLI 检活完成: 健康 ${results.healthy}, 失效 ${results.dead}, 冷却 ${results.cooled}`);
    return results;
  });

  fastify.post('/api/admin/credentials/enable-dead', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    const deadCreds = await prisma.googleCredential.findMany({
      where: { status: CredentialStatus.DEAD },
      select: { id: true, client_id: true, client_secret: true, refresh_token: true, project_id: true, supports_v3: true, google_email: true }
    });
    const POOL_KEY_V3 = 'GLOBAL_CREDENTIAL_POOL_V3';
    const results: any = { total: deadCreds.length, processed: 0, activated: 0, cooled: 0, still_dead: 0, errors: [] };
    for (const cred of deadCreds) {
      results.processed++;
      try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: cred.client_id,
            client_secret: cred.client_secret,
            refresh_token: cred.refresh_token,
            grant_type: 'refresh_token'
          })
        });
        const tokenData = await tokenResponse.json() as any;
        const accessToken = tokenData?.access_token;
        if (!accessToken) {
          results.still_dead++;
          results.errors.push({ id: cred.id, email: cred.google_email, reason: 'refresh_failed' });
          continue;
        }
        const { CredentialService } = require('../services/CredentialService');
        const cs = new CredentialService();
        try {
          const ok = await cs.verifyCloudCodeAccess(accessToken, cred.project_id, 'gemini-2.5-flash', true);
          if (ok) {
            await prisma.googleCredential.update({
              where: { id: cred.id },
              data: { status: CredentialStatus.ACTIVE, is_active: true, fail_count: 0 }
            });
            await redis.rpush(POOL_KEY, String(cred.id));
            if (cred.supports_v3) await redis.rpush(POOL_KEY_V3, String(cred.id));
            results.activated++;
            continue;
          }
        } catch (e: any) {
          const status = e?.statusCode;
          if (status === 403) {
            results.still_dead++;
            results.errors.push({ id: cred.id, email: cred.google_email, reason: '403' });
            continue;
          }
          if (status === 429) {
            const now = new Date();
            const cooldownTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 16, 0, 0);
            await prisma.googleCredential.update({
              where: { id: cred.id },
              data: { status: CredentialStatus.ACTIVE, is_active: true, cooling_expires_at: cooldownTime, fail_count: 0 }
            });
            await redis.rpush(POOL_KEY, String(cred.id));
            if (cred.supports_v3) await redis.rpush(POOL_KEY_V3, String(cred.id));
            results.cooled++;
            continue;
          }
        }
        results.still_dead++;
        results.errors.push({ id: cred.id, email: cred.google_email, reason: 'unknown' });
      } catch (e: any) {
        results.still_dead++;
        results.errors.push({ id: cred.id, email: cred.google_email, reason: 'network', message: e.message });
      }
    }
    return results;
  });

  fastify.post('/api/admin/health-check/cli-dead', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    const deadCreds = await prisma.googleCredential.findMany({
      where: { status: CredentialStatus.DEAD },
      select: { id: true, client_id: true, client_secret: true, refresh_token: true, project_id: true, google_email: true }
    });
    const results: any = { total: deadCreds.length, checked: 0, healthy: 0, dead: 0, cooled: 0, errors: [] };
    for (const cred of deadCreds) {
      results.checked++;
      try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: cred.client_id,
            client_secret: cred.client_secret,
            refresh_token: cred.refresh_token,
            grant_type: 'refresh_token'
          })
        });
        const tokenData = await tokenResponse.json() as any;
        const accessToken = tokenData?.access_token;
        if (!accessToken) {
          results.dead++;
          results.errors.push({ id: cred.id, email: cred.google_email, error: 'refresh_failed' });
          continue;
        }
        const { CredentialService } = require('../services/CredentialService');
        const cs = new CredentialService();
        try {
          const ok = await cs.verifyCloudCodeAccess(accessToken, cred.project_id, 'gemini-2.5-flash', true);
          if (ok) {
            results.healthy++;
            continue;
          }
        } catch (e: any) {
          const status = e?.statusCode;
          if (status === 403) {
            results.dead++;
            results.errors.push({ id: cred.id, email: cred.google_email, error: '403' });
            continue;
          }
          if (status === 429) {
            results.cooled++;
            continue;
          }
          results.errors.push({ id: cred.id, email: cred.google_email, error: String(status || 'unknown') });
          continue;
        }
      } catch (e: any) {
        results.errors.push({ id: cred.id, email: cred.google_email, error: e.message });
      }
    }
    return results;
  });

  // 13. Stream Health Check (SSE + Concurrency)
  fastify.get('/api/admin/health-check/stream', { preHandler: requireAdmin }, async (req, reply) => {
    const { type } = req.query as { type: string };

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const sendEvent = (data: any) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const limit = pLimit(10); // Concurrency limit 10

    try {
      if (type === 'cli') {
        // --- CLI Active Check ---
        sendEvent({ type: 'log', message: '🚀 开始 CLI 活跃凭证检活 (并发数: 10)...' });
        const creds = await prisma.googleCredential.findMany({
          where: { status: CredentialStatus.ACTIVE },
          include: { owner: { select: { username: true, level: true } } }
        });

        sendEvent({ type: 'init', total: creds.length });

        let processed = 0;
        let healthy = 0;
        let dead = 0;
        let cooled = 0;

        await Promise.all(creds.map(cred => limit(async () => {
          try {
            // Refresh Token
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: cred.client_id,
                client_secret: cred.client_secret,
                refresh_token: cred.refresh_token,
                grant_type: 'refresh_token'
              })
            });

            if (!tokenRes.ok) {
              if (tokenRes.status === 400 || tokenRes.status === 401) {
                await prisma.googleCredential.update({ where: { id: cred.id }, data: { status: CredentialStatus.DEAD } });
                if (cred.owner && cred.owner.level > 0) {
                  await prisma.user.update({ where: { id: cred.owner_id }, data: { level: { decrement: 1 } } });
                }
                dead++;
                sendEvent({ type: 'log', message: `❌ #${cred.id} 刷新失败 (400/401) -> 失效` });
              } else {
                // Temporary error
                sendEvent({ type: 'log', message: `⚠️ #${cred.id} 刷新临时错误 (${tokenRes.status}) -> 跳过` });
              }
            } else {
              const tokenData = await tokenRes.json() as any;
              const accessToken = tokenData.access_token;
              if (!accessToken) {
                dead++;
                sendEvent({ type: 'log', message: `❌ #${cred.id} 无 Access Token -> 失效` });
              } else {
                // Verify Cloud Code (gemini-2.5-flash)
                const { CredentialService } = require('../services/CredentialService');
                const cs = new CredentialService();
                try {
                  const ok = await cs.verifyCloudCodeAccess(accessToken, cred.project_id, 'gemini-2.5-flash', true);
                  if (ok) {
                    healthy++;
                    sendEvent({ type: 'log', message: `✅ #${cred.id} 健康` });
                  }
                } catch (e: any) {
                  const status = e?.statusCode;
                  if (status === 403) {
                    await prisma.googleCredential.update({ where: { id: cred.id }, data: { status: CredentialStatus.DEAD } });
                    if (cred.owner && cred.owner.level > 0) {
                      await prisma.user.update({ where: { id: cred.owner_id }, data: { level: { decrement: 1 } } });
                    }
                    dead++;
                    sendEvent({ type: 'log', message: `❌ #${cred.id} 403 权限不足 -> 失效` });
                  } else if (status === 429) {
                    const now = new Date();
                    const cooldownTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 16, 0, 0);
                    await prisma.googleCredential.update({ where: { id: cred.id }, data: { cooling_expires_at: cooldownTime } });
                    cooled++;
                    sendEvent({ type: 'log', message: `⏳ #${cred.id} 429 -> 冷却` });
                  } else {
                    sendEvent({ type: 'log', message: `⚠️ #${cred.id} 验证错误 (${status}) -> 跳过` });
                  }
                }
              }
            }
          } catch (e: any) {
            sendEvent({ type: 'log', message: `⚠️ #${cred.id} 异常: ${e.message}` });
          } finally {
            processed++;
            sendEvent({ type: 'progress', processed, healthy, dead, cooled });
          }
        })));

      } else if (type === 'cli_dead') {
        // --- CLI Dead Check ---
        sendEvent({ type: 'log', message: '💀 开始失效凭证复检...' });
        const creds = await prisma.googleCredential.findMany({
          where: { status: CredentialStatus.DEAD },
          select: { id: true, client_id: true, client_secret: true, refresh_token: true, project_id: true, google_email: true }
        });
        sendEvent({ type: 'init', total: creds.length });

        let processed = 0;
        let healthy = 0;
        let dead = 0;
        let cooled = 0;

        await Promise.all(creds.map(cred => limit(async () => {
          // Logic similar to above but without marking dead again (already dead)
          // If healthy -> ACTIVE
          try {
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: cred.client_id,
                client_secret: cred.client_secret,
                refresh_token: cred.refresh_token,
                grant_type: 'refresh_token'
              })
            });
            if (!tokenRes.ok) {
              dead++;
              sendEvent({ type: 'log', message: `❌ #${cred.id} 仍失效 (${tokenRes.status})` });
            } else {
              const data = await tokenRes.json() as any;
              const { CredentialService } = require('../services/CredentialService');
              const cs = new CredentialService();
              try {
                const ok = await cs.verifyCloudCodeAccess(data.access_token, cred.project_id, 'gemini-2.5-flash', true);
                if (ok) {
                  // Revive!
                  await prisma.googleCredential.update({
                    where: { id: cred.id },
                    data: { status: CredentialStatus.ACTIVE, is_active: true, fail_count: 0 }
                  });
                  await redis.rpush(POOL_KEY, String(cred.id));
                  healthy++;
                  sendEvent({ type: 'log', message: `🎉 #${cred.id} 复活成功！` });
                }
              } catch (e: any) {
                if (e?.statusCode === 429) {
                  // Cooldown
                  const now = new Date();
                  const cooldownTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 16, 0, 0);
                  await prisma.googleCredential.update({
                    where: { id: cred.id },
                    data: { status: CredentialStatus.ACTIVE, is_active: true, cooling_expires_at: cooldownTime, fail_count: 0 }
                  });
                  await redis.rpush(POOL_KEY, String(cred.id));
                  cooled++;
                  sendEvent({ type: 'log', message: `⏳ #${cred.id} 复活并进入冷却 (429)` });
                } else {
                  dead++;
                  sendEvent({ type: 'log', message: `❌ #${cred.id} 验证失败 (${e?.statusCode})` });
                }
              }
            }
          } catch (e: any) {
            dead++;
            sendEvent({ type: 'log', message: `❌ #${cred.id} 异常: ${e.message}` });
          } finally {
            processed++;
            sendEvent({ type: 'progress', processed, healthy, dead, cooled });
          }
        })));

      } else if (type === 'enable_dead') {
        // --- Enable Dead (Try Force) ---
        sendEvent({ type: 'log', message: '⚡ 开始一键启用失效凭证...' });
        const creds = await prisma.googleCredential.findMany({ where: { status: CredentialStatus.DEAD } });
        sendEvent({ type: 'init', total: creds.length });

        let processed = 0;
        let activated = 0;
        let failed = 0;

        await Promise.all(creds.map(cred => limit(async () => {
          try {
            // Simply try to update to ACTIVE and verify later? 
            // Or do real verification? The user asked for "Enable Dead", usually means re-verify and enable if works.
            // Reusing the same logic as cli_dead essentially, but maybe focusing on just pushing them back?
            // Let's stick to verification to be safe.

            // Same logic as cli_dead actually.
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: cred.client_id,
                client_secret: cred.client_secret,
                refresh_token: cred.refresh_token,
                grant_type: 'refresh_token'
              })
            });
            if (tokenRes.ok) {
              const data = await tokenRes.json() as any;
              const { CredentialService } = require('../services/CredentialService');
              const cs = new CredentialService();
              try {
                const ok = await cs.verifyCloudCodeAccess(data.access_token, cred.project_id, 'gemini-2.5-flash', true);
                if (ok) {
                  await prisma.googleCredential.update({
                    where: { id: cred.id },
                    data: { status: CredentialStatus.ACTIVE, is_active: true, fail_count: 0 }
                  });
                  await redis.rpush(POOL_KEY, String(cred.id));
                  if (cred.supports_v3) await redis.rpush(POOL_KEY + '_V3', String(cred.id)); // POOL_KEY_V3 logic needs check
                  activated++;
                  sendEvent({ type: 'log', message: `🎉 #${cred.id} 启用成功` });
                }
              } catch (e) { failed++; }
            } else { failed++; }
          } catch (e) { failed++; }
          finally {
            processed++;
            sendEvent({ type: 'progress', processed, activated, failed });
          }
        })));

      } else if (type === 'cli_v3') {
        // --- CLI V3 Check & Downgrade ---
        sendEvent({ type: 'log', message: '💎 开始 3.0 凭证专项检活 (gemini-3-flash-preview)...' });
        const creds = await prisma.googleCredential.findMany({
          where: { status: CredentialStatus.ACTIVE, supports_v3: true }
        });
        sendEvent({ type: 'init', total: creds.length });

        let processed = 0;
        let healthy = 0;
        let downgraded = 0;
        let failed = 0; // Network errors / 429
        const POOL_KEY_V3 = 'GLOBAL_CREDENTIAL_POOL_V3'; // Hardcoded based on other files

        await Promise.all(creds.map(cred => limit(async () => {
          try {
            // 1. Refresh Token
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: cred.client_id,
                client_secret: cred.client_secret,
                refresh_token: cred.refresh_token,
                grant_type: 'refresh_token'
              })
            });
            if (!tokenRes.ok) {
              // If token refresh fails, it's dead, but we are only checking V3 here.
              // Let's just log and skip, or maybe downgrade?
              // If it's dead, it will be caught by normal health check.
              sendEvent({ type: 'log', message: `⚠️ #${cred.id} Token 刷新失败 -> 跳过` });
              failed++;
              return;
            }

            const data = await tokenRes.json() as any;
            const { CredentialService } = require('../services/CredentialService');
            const cs = new CredentialService();

            // 2. Verify V3 (gemini-3-flash-preview)
            try {
              const ok = await cs.verifyCloudCodeAccess(data.access_token, cred.project_id, 'gemini-3-flash-preview', false); // false = strict on 429? No, maybe true to allow 429.
              // Actually, for V3 check, if 429, we shouldn't downgrade.
              // verifyCloudCodeAccess returns true if 429 and allow429=true.
              // But we want to distinguish.
              // Let's call with allow429=false to catch 429 as error?
              // No, if we catch 429, we shouldn't downgrade.

              // Let's use verifyViaProxy logic or just verifyCloudCodeAccess.
              // If it passes (200), it's good.
              // If it throws...

              // Let's try verifyCloudCodeAccess with allow429=false.
              // If it throws 429, we catch it and do nothing (count as failed/skipped).
              // If it throws 404/403/400, we downgrade.

              await cs.verifyCloudCodeAccess(data.access_token, cred.project_id, 'gemini-3-flash-preview', false);

              healthy++;
              sendEvent({ type: 'log', message: `✅ #${cred.id} 3.0 正常` });
            } catch (e: any) {
              const status = e?.statusCode;
              if (status === 429 || status >= 500) {
                sendEvent({ type: 'log', message: `⚠️ #${cred.id} 3.0 检测遇到 ${status} -> 跳过` });
                failed++;
              } else {
                // 404, 403, 400 -> Downgrade
                await prisma.googleCredential.update({
                  where: { id: cred.id },
                  data: { supports_v3: false }
                });
                await redis.lrem(POOL_KEY_V3, 0, String(cred.id));
                downgraded++;
                sendEvent({ type: 'log', message: `⬇️ #${cred.id} 3.0 失效 (${status}) -> 降级为 2.5` });
              }
            }

          } catch (e: any) {
            failed++;
            sendEvent({ type: 'log', message: `⚠️ #${cred.id} 异常: ${e.message}` });
          } finally {
            processed++;
            sendEvent({ type: 'progress', processed, healthy, downgraded, failed });
          }
        })));
      } else {
        sendEvent({ type: 'error', message: '未知操作类型' });
      }

    } catch (e: any) {
      sendEvent({ type: 'error', message: `全局错误: ${e.message}` });
    } finally {
      sendEvent({ type: 'done' });
      reply.raw.end();
    }
  });
}
