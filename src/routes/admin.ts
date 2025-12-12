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
        try { systemConfig = { ...systemConfig, ...JSON.parse(configSetting.value) }; } catch(e){}
    }
    const agConfigSetting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_CONFIG' } });
    let agConfig = { claude_limit: 100, gemini3_limit: 200 };
    if (agConfigSetting) {
        try { agConfig = { ...agConfig, ...JSON.parse(agConfigSetting.value) }; } catch(e){}
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

    // Fetch Redis Model Stats
    const todayStr = new Date().toISOString().split('T')[0];
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
    
    const userAgClaude = (user as any).ag_claude_limit || 0;
    const userAgGemini3 = (user as any).ag_gemini3_limit || 0;
    const effectiveAgClaudeLimit = userAgClaude > 0 ? userAgClaude : agConfig.claude_limit;
    const effectiveAgGemini3Limit = userAgGemini3 > 0 ? userAgGemini3 : agConfig.gemini3_limit;

    let agUsage = { claude: 0, gemini3: 0, limits: { claude: effectiveAgClaudeLimit, gemini3: effectiveAgGemini3Limit } };
    try {
        const claudeKey = `USAGE:${todayStr}:${userId}:antigravity:claude`;
        const geminiKey = `USAGE:${todayStr}:${userId}:antigravity:gemini3`;
        const claude = parseInt((await redis.get(claudeKey)) || '0', 10);
        const gemini3 = parseInt((await redis.get(geminiKey)) || '0', 10);
        agUsage = {
            claude,
            gemini3,
            limits: {
                claude: effectiveAgClaudeLimit,
                gemini3: effectiveAgGemini3Limit
            }
        };
    } catch(e) {}

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
      force_discord_bind: forceBindSetting ? forceBindSetting.value === 'true' : false
    };
  });

  // --- Announcement Routes ---

  // Get Announcement
  fastify.get('/api/announcement', async (req: FastifyRequest) => {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'ANNOUNCEMENT_DATA' } });
    if (!setting) return { content: '', version: 0 };
    try {
        return JSON.parse(setting.value);
    } catch(e) {
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
        return reply.code(403).send({ error: 'Forbidden: Only admins can create ADMIN keys' });
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
    const statusFilter = query.status as CredentialStatus | 'ALL';

    const whereClause = (statusFilter && statusFilter !== 'ALL') ? { status: statusFilter } : {};

    const [total, credentials] = await prisma.$transaction([
      prisma.googleCredential.count({ where: whereClause }),
      prisma.googleCredential.findMany({
        where: whereClause,
        skip: (page - 1) * limit,
        take: limit,
        include: { 
          owner: { select: { email: true } },
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
        name: c.client_id ? `...${c.client_id.slice(0, 15)}` : `Credential #${c.id}`, // Truncated Client ID as name
        owner_email: c.owner.email,
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

    // Fetch Global Model Stats
    const todayStr = new Date().toISOString().split('T')[0];
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
    } catch(e) {}

    // B. Leaderboard (Top 25 Users by Usage)
    const leaderboard = await prisma.user.findMany({
      orderBy: { today_used: 'desc' },
      take: 25,
      select: {
        id: true,
        email: true,
        today_used: true,
        daily_limit: true
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
    const sharedSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_SHARED_MODE' } });
    const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
    
    let config = { ...DEFAULT_SYSTEM_CONFIG };
    if (configSetting) {
        try {
            const parsed = JSON.parse(configSetting.value);
            config = {
                enable_registration: parsed.enable_registration ?? config.enable_registration,
                quota: { ...config.quota, ...parsed.quota },
                rate_limit: { ...config.rate_limit, ...parsed.rate_limit }
            };
        } catch (e) {}
    }

    const agStrictSetting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_STRICT_MODE' } });
    const forceBindSetting = await prisma.systemSetting.findUnique({ where: { key: 'FORCE_DISCORD_BIND' } });
    return { 
        enable_shared_mode: sharedSetting ? sharedSetting.value === 'true' : true,
        antigravity_strict_mode: agStrictSetting ? agStrictSetting.value === 'true' : false,
        force_discord_bind: forceBindSetting ? forceBindSetting.value === 'true' : false,
        ...config
    };
  });

  // 7. Update System Settings
  fastify.post('/api/admin/settings', { preHandler: requireAdmin }, async (req: FastifyRequest) => {
    console.log('[Admin] Received settings update:', req.body);
    const body = req.body as any;
    
    // Handle Shared Mode
    if (body.enable_shared_mode !== undefined) {
        await prisma.systemSetting.upsert({
          where: { key: 'ENABLE_SHARED_MODE' },
          update: { value: String(body.enable_shared_mode) },
          create: { key: 'ENABLE_SHARED_MODE', value: String(body.enable_shared_mode) }
        });
    }

    // Handle System Config
    const currentConfigSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
    let currentConfig = { ...DEFAULT_SYSTEM_CONFIG };
    if (currentConfigSetting) {
        try { currentConfig = JSON.parse(currentConfigSetting.value); } catch(e){}
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

    return { success: true, ...newConfig, enable_shared_mode: body.enable_shared_mode, antigravity_strict_mode: body.antigravity_strict_mode };
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

    const todayStr = new Date().toISOString().split('T')[0];
    const enhancedUsers = await Promise.all(users.map(async u => {
        const claudeUsed = await redis.get(`USAGE:${todayStr}:${u.id}:antigravity:claude`);
        const gemini3Used = await redis.get(`USAGE:${todayStr}:${u.id}:antigravity:gemini3`);

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
            ag_claude_used: parseInt(claudeUsed || '0', 10),
            ag_gemini3_used: parseInt(gemini3Used || '0', 10)
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
}
