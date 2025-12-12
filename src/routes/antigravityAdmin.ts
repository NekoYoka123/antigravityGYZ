import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { antigravityTokenManager } from '../services/AntigravityTokenManager';
import { AntigravityService } from '../services/AntigravityService';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// OAuth 配置 (与原始 antigravity 项目一致)
const OAUTH_CONFIG = {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ]
};

/**
 * 验证用户登录 (不需要管理员) - 返回用户 ID 或 null
 */
async function verifyAuth(req: FastifyRequest, reply: FastifyReply): Promise<number | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Missing authorization header' });
        return null;
    }

    const token = authHeader.replace('Bearer ', '');

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        // 注意: auth.ts 中签发的 token 使用 id 而不是 userId
        const userId = decoded.id || decoded.userId;

        const user = await prisma.user.findUnique({ where: { id: userId } });

        if (!user) {
            console.error(`[Auth] User not found for ID: ${userId}`);
            reply.code(401).send({ error: 'User not found' });
            return null;
        }

        return userId;
    } catch (e: any) {
        console.error('[Auth] Token verification failed:', e.message);
        reply.code(401).send({ error: 'Invalid token: ' + e.message });
        return null;
    }
}

/**
 * 验证管理员权限
 */
async function verifyAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Missing authorization header' });
        return false;
    }

    const token = authHeader.replace('Bearer ', '');

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        // 注意: auth.ts 中签发的 token 使用 id 而不是 userId
        const userId = decoded.id || decoded.userId;

        const user = await prisma.user.findUnique({ where: { id: userId } });

        if (!user || user.role !== 'ADMIN') {
            reply.code(403).send({ error: 'Admin access required' });
            return false;
        }

        return true;
    } catch (e: any) {
        console.error('[Admin] Token verification failed:', e.message);
        reply.code(401).send({ error: 'Invalid token' });
        return false;
    }
}

export default async function antigravityAdminRoutes(app: FastifyInstance) {

    // 获取反重力配置
    app.get('/config', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const setting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_CONFIG' } });
        let config = { claude_limit: 100, gemini3_limit: 200 };
        
        if (setting) {
            try {
                config = { ...config, ...JSON.parse(setting.value) };
            } catch (e) {
                console.error('Failed to parse ANTIGRAVITY_CONFIG', e);
            }
        }

        return config;
    });

    // 更新反重力配置
    app.post('/config', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const { claude_limit, gemini3_limit } = req.body as any;

        if (typeof claude_limit !== 'number' || typeof gemini3_limit !== 'number') {
            return reply.code(400).send({ error: 'Invalid limits. Must be numbers.' });
        }

        const config = { claude_limit, gemini3_limit };
        
        await prisma.systemSetting.upsert({
            where: { key: 'ANTIGRAVITY_CONFIG' },
            update: { value: JSON.stringify(config) },
            create: { key: 'ANTIGRAVITY_CONFIG', value: JSON.stringify(config) }
        });

        // Audit Log (Optional but good practice)
        // Note: AuditLog model is not yet created, so we skip or use console for now
        console.log(`[Admin] Antigravity config updated:`, config);

        return { success: true, config };
    });

    // 获取反重力全局统计数据 (管理员)
    app.get('/stats', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;
        
        const todayStr = new Date().toISOString().split('T')[0];
        
        // 1. Get Global Usage from Redis
        const globalUsage = await redis.hgetall(`AG_GLOBAL:${todayStr}`);
        const claudeUsed = parseInt(globalUsage?.claude || '0', 10);
        const gemini3Used = parseInt(globalUsage?.gemini3 || '0', 10);
        
        // 2. Get Token Count (Active)
        const activeTokens = await prisma.antigravityToken.count({
            where: { status: 'ACTIVE', is_enabled: true }
        });
        
        // 3. Get Config for Limits
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_CONFIG' } });
        let config = { claude_limit: 100, gemini3_limit: 200 };
        if (setting) {
            try { config = { ...config, ...JSON.parse(setting.value) }; } catch(e){}
        }
        
        // 4. Calculate "Capacity" (Token Count * User Limit)
        // Interpretation: Total possible usage if we consider token count as a multiplier of service capability
        // OR simply reflecting the prompt's request: "有效凭证数 × 每个用户被允许使用的次数"
        const claudeCapacity = activeTokens * config.claude_limit;
        const gemini3Capacity = activeTokens * config.gemini3_limit;
        
        return {
            date: todayStr,
            usage: {
                claude: claudeUsed,
                gemini3: gemini3Used
            },
            capacity: {
                claude: claudeCapacity,
                gemini3: gemini3Capacity
            },
            meta: {
                active_tokens: activeTokens,
                limits: config
            }
        };
    });

    // 获取用户反重力使用详情 (管理员)
    app.get('/usage/:userId', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;
        
        const { userId } = req.params as any;
        const todayStr = new Date().toISOString().split('T')[0];
        
        const claudeUsed = await redis.get(`USAGE:${todayStr}:${userId}:antigravity:claude`);
        const gemini3Used = await redis.get(`USAGE:${todayStr}:${userId}:antigravity:gemini3`);
        
        return {
            date: todayStr,
            userId: parseInt(userId),
            usage: {
                claude: parseInt(claudeUsed || '0', 10),
                gemini3: parseInt(gemini3Used || '0', 10)
            }
        };
    });

    // 获取 Token 列表 (仅管理员)
    app.get('/tokens', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const tokens = await antigravityTokenManager.getTokenList();
        const baseStats = await antigravityTokenManager.getStats();
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
        let personalMax = 0;
        try {
            const conf = setting ? JSON.parse(setting.value) : {};
            personalMax = conf?.quota?.personal_max_usage ?? 0;
        } catch {}
        const inactive = await prisma.antigravityToken.count({ where: { is_enabled: false } });
        const totalCapacity = personalMax > 0 ? personalMax * baseStats.active : 0;
        const stats = { ...baseStats, inactive, personal_max_usage: personalMax, total_capacity: totalCapacity };

        return { tokens, stats };
    });

    // 添加 Token (仅管理员)
    app.post('/tokens', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const body = req.body as any;

        if (!body.access_token || !body.refresh_token || !body.owner_id) {
            return reply.code(400).send({ error: 'access_token, refresh_token, and owner_id are required' });
        }

        try {
            let projectId: string | undefined = body.projectId;
            try {
                const projectRes = await axios.post(
                    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
                    { metadata: { ideType: 'ANTIGRAVITY' } },
                    {
                        headers: {
                            'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
                            'Authorization': `Bearer ${body.access_token}`,
                            'Content-Type': 'application/json',
                            'User-Agent': 'antigravity/1.11.9 windows/amd64'
                        }
                    }
                );
                projectId = projectRes.data?.cloudaicompanionProject || projectId;
            } catch (e: any) {
                const status = e.response?.status;
                const err = e.response?.data?.error;
                const message = err?.message || e.message;
                if (status === 403) {
                    const isNamedUser403 = err?.code === 403
                        && err?.status === 'PERMISSION_DENIED'
                        && typeof err?.message === 'string'
                        && err.message.includes('You must be a named user on your organization');
                    const outMsg = isNamedUser403
                        ? '账号权限不足：此 Google 账号未获得 Gemini Code Assist 标准版授权，无法作为反重力凭证使用。请更换已开通权限的账号。'
                        : '该凭证无权使用 Antigravity（403）: ' + message;
                    console.warn('[Antigravity] Credential upload permission denied (admin /tokens):', e.response?.data || e.message);
                    return reply.code(400).send({ error: outMsg });
                }
            }
            const token = await antigravityTokenManager.addToken({
                access_token: body.access_token,
                refresh_token: body.refresh_token,
                expires_in: body.expires_in,
                email: body.email,
                projectId,
                ownerId: body.owner_id
            });

            return { success: true, token: { id: token.id } };
        } catch (e: any) {
            return reply.code(500).send({ error: e.message });
        }
    });

    // 更新 Token (启用/禁用) (仅管理员)
    app.put('/tokens/:id', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const { id } = req.params as { id: string };
        const body = req.body as any;

        try {
            const token = await antigravityTokenManager.updateToken(parseInt(id), {
                is_enabled: body.is_enabled
            });

            return { success: true, token };
        } catch (e: any) {
            return reply.code(500).send({ error: e.message });
        }
    });

    // 删除 Token (仅管理员)
    app.delete('/tokens/:id', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const { id } = req.params as { id: string };

        try {
            await antigravityTokenManager.deleteToken(parseInt(id));
            return { success: true };
        } catch (e: any) {
            return reply.code(500).send({ error: e.message });
        }
    });

    // 获取 OAuth URL (所有登录用户)
    // 返回一个随机端口的 OAuth URL，用户需要记住这个端口
    app.get('/oauth/url', async (req, reply) => {
        if (!await verifyAuth(req, reply)) return;

        // 生成一个随机端口 (50000-60000)
        const port = Math.floor(Math.random() * 10000) + 50000;
        const redirectUri = `http://localhost:${port}/oauth-callback`;

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `access_type=offline` +
            `&client_id=${encodeURIComponent(OAUTH_CONFIG.clientId)}` +
            `&prompt=consent` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=code` +
            `&scope=${encodeURIComponent(OAUTH_CONFIG.scopes.join(' '))}` +
            `&state=${Date.now()}`;

        return { url: authUrl, port };
    });

    // OAuth 交换 (所有登录用户)
    // 接收完整的回调 URL，提取 code 和 port
    app.post('/oauth/exchange', async (req, reply) => {
        const userId = await verifyAuth(req, reply);
        if (userId === null) return;

        const body = req.body as any;
        const { code, port, skip_validation } = body;

        if (!code || !port) {
            return reply.code(400).send({ error: 'code 和 port 是必填的' });
        }

        try {
            const redirectUri = `http://localhost:${port}/oauth-callback`;

            // 交换 Token
            const tokenResponse = await axios.post(OAUTH_CONFIG.tokenUrl,
                new URLSearchParams({
                    code,
                    client_id: OAUTH_CONFIG.clientId,
                    client_secret: OAUTH_CONFIG.clientSecret,
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code'
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );

            const { access_token, refresh_token, expires_in } = tokenResponse.data;

            if (!access_token) {
                return reply.code(400).send({ error: 'Token 交换失败' });
            }

            if (!refresh_token) {
                return reply.code(400).send({ error: '未获取到 refresh_token，请撤销应用授权后重试' });
            }

            // 获取用户邮箱
            let email: string | undefined;
            try {
                const userInfo = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: {
                        'Host': 'www.googleapis.com',
                        'User-Agent': 'Go-http-client/1.1',
                        'Authorization': `Bearer ${access_token}`,
                        'Accept-Encoding': 'gzip'
                    }
                });
                email = userInfo.data.email;
                console.log('[OAuth] 获取到用户邮箱:', email);
            } catch (e) {
                console.warn('[OAuth] 获取用户邮箱失败');
            }

            // 验证账号是否有 Antigravity 权限 (获取 projectId)
            let projectId: string | undefined;
            try {
                const projectRes = await axios.post(
                    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
                    { metadata: { ideType: 'ANTIGRAVITY' } },
                    {
                        headers: {
                            'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
                            'Authorization': `Bearer ${access_token}`,
                            'Content-Type': 'application/json',
                            'User-Agent': 'antigravity/1.11.9 windows/amd64'
                        }
                    }
                );
                projectId = projectRes.data?.cloudaicompanionProject;
                if (!projectId) {
                    return reply.code(400).send({ error: '该账号没有 Antigravity 项目权限（未返回 projectId）。' });
                }
            } catch (e: any) {
                console.error('[OAuth] ProjectId 验证失败:', e.response?.data || e.message);
                const status = e.response?.status;
                const err = e.response?.data?.error;
                const message = err?.message || e.message;
                if (status === 403) {
                    const isNamedUser403 = err?.code === 403
                        && err?.status === 'PERMISSION_DENIED'
                        && typeof err?.message === 'string'
                        && err.message.includes('You must be a named user on your organization');
                    const outMsg = isNamedUser403
                        ? '账号权限不足：此 Google 账号未获得 Gemini Code Assist 标准版授权，无法作为反重力凭证使用。请更换已开通权限的账号。'
                        : '该账号无权使用 Antigravity（403）: ' + message;
                    console.warn('[Antigravity] Credential upload permission denied (OAuth exchange):', e.response?.data || e.message);
                    return reply.code(400).send({ error: outMsg });
                }
                return reply.code(400).send({ error: '验证 Antigravity 权限失败: ' + message });
            }

            // 保存 Token (绑定到当前用户)
            const token = await antigravityTokenManager.addToken({
                access_token,
                refresh_token,
                expires_in,
                email,
                projectId,
                ownerId: userId
            });

            return { success: true, token: { id: token.id, email, projectId } };
        } catch (e: any) {
            console.error('[OAuth] Token 交换失败:', e.response?.data || e.message);
            return reply.code(500).send({
                error: e.response?.data?.error_description || e.response?.data?.error || e.message
            });
        }
    });

    app.get('/my-tokens', async (req, reply) => {
        const userId = await verifyAuth(req, reply);
        if (userId === null) return;
        const query = req.query as any;
        const page = Math.max(1, parseInt(query.page) || 1);
        const limitRaw = parseInt(query.limit) || 10;
        const limit = Math.min(Math.max(1, limitRaw), 50);
        const skip = (page - 1) * limit;
        const [total, tokens] = await prisma.$transaction([
            prisma.antigravityToken.count({ where: { owner_id: userId } }),
            prisma.antigravityToken.findMany({
                where: { owner_id: userId },
                orderBy: { id: 'desc' },
                skip,
                take: limit
            })
        ]);
        const data = tokens.map(t => ({
            id: t.id,
            email: t.email,
            project_id: t.project_id,
            is_enabled: t.is_enabled,
            status: t.status,
            created_at: t.created_at
        }));
        return { tokens: data, total, page, limit };
    });

    app.delete('/my-tokens/:id', async (req, reply) => {
        const userId = await verifyAuth(req, reply);
        if (userId === null) return;
        const { id } = req.params as { id: string };
        const tokenId = parseInt(id);
        const token = await prisma.antigravityToken.findUnique({ where: { id: tokenId } });
        if (!token) {
            return reply.code(404).send({ error: 'Not found' });
        }
        if (token.owner_id !== userId) {
            return reply.code(403).send({ error: 'Forbidden' });
        }
        await antigravityTokenManager.deleteToken(tokenId);
        return { success: true };
    });

    app.put('/my-tokens/:id', async (req, reply) => {
        const userId = await verifyAuth(req, reply);
        if (userId === null) return;
        const { id } = req.params as { id: string };
        const body = req.body as any;
        const tokenId = parseInt(id);
        const token = await prisma.antigravityToken.findUnique({ where: { id: tokenId } });
        if (!token) {
            return reply.code(404).send({ error: 'Not found' });
        }
        if (token.owner_id !== userId) {
            return reply.code(403).send({ error: 'Forbidden' });
        }
        if (typeof body.is_enabled !== 'boolean') {
            return reply.code(400).send({ error: 'is_enabled is required and must be boolean' });
        }
        const updated = await antigravityTokenManager.updateToken(tokenId, { is_enabled: body.is_enabled });
        return { success: true, token: { id: updated.id, is_enabled: updated.is_enabled } };
    });

    // 刷新所有 Token (仅管理员)
    app.post('/refresh-all', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const tokens = await antigravityTokenManager.getTokenList();
        const results: any[] = [];

        for (const t of tokens) {
            if (t.is_enabled) {
                const success = await antigravityTokenManager.refreshToken(t.id);
                results.push({ id: t.id, success });
            }
        }

        return { results };
    });

    // 从 antigravity2api 项目导入本地 accounts.json (仅管理员)
    app.post('/import-accounts', async (req, reply) => {
        if (!await verifyAdmin(req, reply)) return;

        const body = req.body as any;
        let ownerId = Number(body?.owner_id);
        if (!Number.isFinite(ownerId)) {
            const adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
            if (!adminUser) {
                return reply.code(400).send({ error: '没有找到管理员用户，请在请求体提供 owner_id' });
            }
            ownerId = adminUser.id;
        }

        const accountsPath = path.join(process.cwd(), 'antigravity2api-nodejs-main', 'antigravity2api-nodejs-main', 'data', 'accounts.json');
        if (!fs.existsSync(accountsPath)) {
            return reply.code(404).send({ error: `未找到 accounts.json: ${accountsPath}` });
        }

        try {
            const raw = fs.readFileSync(accountsPath, 'utf-8');
            const accounts = JSON.parse(raw) as Array<{
                access_token: string;
                refresh_token: string;
                expires_in?: number;
                timestamp?: number;
                enable?: boolean;
            }>;

            const results: any[] = [];
            for (const acc of accounts) {
                if (acc.enable === false) continue;
                try {
                    let projectId: string | undefined;
                    try {
                        const projectRes = await axios.post(
                            'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
                            { metadata: { ideType: 'ANTIGRAVITY' } },
                            {
                                headers: {
                                    'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
                                    'Authorization': `Bearer ${acc.access_token}`,
                                    'Content-Type': 'application/json',
                                    'User-Agent': 'antigravity/1.11.9 windows/amd64'
                                }
                            }
                        );
                        projectId = projectRes.data?.cloudaicompanionProject;
                    } catch (e: any) {
                        const status = e.response?.status;
                        const message = e.response?.data?.error?.message || e.message;
                        if (status === 403) {
                            results.push({ refresh_token_suffix: acc.refresh_token.slice(-8), error: '403 无权限: ' + message });
                            continue;
                        } else {
                            results.push({ refresh_token_suffix: acc.refresh_token.slice(-8), warn: '无法获取 projectId，已按无项目ID入库' });
                        }
                    }
                    const token = await antigravityTokenManager.addToken({
                        access_token: acc.access_token,
                        refresh_token: acc.refresh_token,
                        expires_in: acc.expires_in ?? 3599,
                        projectId,
                        ownerId
                    });
                    results.push({ refresh_token_suffix: acc.refresh_token.slice(-8), id: token.id, status: 'imported' });
                } catch (e: any) {
                    results.push({ refresh_token_suffix: acc.refresh_token.slice(-8), error: e.message });
                }
            }

            return { success: true, imported: results.length, results };
        } catch (e: any) {
            return reply.code(500).send({ error: e.message });
        }
    });
}
