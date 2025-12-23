
import { FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient, CredentialStatus } from '@prisma/client';
import Redis from 'ioredis';
import { ProxyController } from './ProxyController';
import { convertAnthropicToOpenAI } from '../utils/adapters';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export class AnthropicController {
    static async handleMessages(req: FastifyRequest, reply: FastifyReply) {
        // 1. Auth (Support x-api-key or Authorization)
        let apiKeyStr = '';
        if (req.headers['x-api-key']) {
            apiKeyStr = Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key'];
        } else if (req.headers.authorization?.startsWith('Bearer ')) {
            apiKeyStr = req.headers.authorization.replace('Bearer ', '').trim();
        }

        if (!apiKeyStr) {
            return reply.code(401).send({ error: { type: 'authentication_error', message: 'Missing API Key' } });
        }

        const apiKeyData = await prisma.apiKey.findUnique({
            where: { key: apiKeyStr },
            include: { user: true }
        });

        if (!apiKeyData || !apiKeyData.is_active) {
            return reply.code(401).send({ error: { type: 'authentication_error', message: 'Invalid or disabled API Key' } });
        }

        const user = apiKeyData.user;
        if (!user.is_active) {
            return reply.code(401).send({ error: { type: 'permission_error', message: '🚫 您的账户已被禁用，请联系管理员解封。' } });
        }

        const isAdminKey = (apiKeyData as any).type === 'ADMIN';

        // Check Discord Bind
        const forceBindSetting = await prisma.systemSetting.findUnique({ where: { key: 'FORCE_DISCORD_BIND' } });
        const forceDiscordBind = forceBindSetting ? forceBindSetting.value === 'true' : false;
        if (forceDiscordBind && !isAdminKey) {
            const userFull = await prisma.user.findUnique({ where: { id: user.id } }) as any;
            if (!userFull?.discordId) {
                return reply.code(401).send({ error: { type: 'permission_error', message: '请先绑定 Discord 账户后再使用服务' } });
            }
        }

        // Fetch counts for permissions/quota
        const activeCredCount = await prisma.googleCredential.count({
            where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] } }
        });
        const activeV3CredCount = await prisma.googleCredential.count({
            where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] }, supports_v3: true }
        });

        // Quota & Rate Limit Logic (Mirrored from ProxyController)
        if (!isAdminKey) {
            const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
            let rateLimit = 10;
            let baseQuota = 300;

            if (configSetting) {
                try {
                    const conf = JSON.parse(configSetting.value);
                    const limits = conf.rate_limit || {};
                    if (activeV3CredCount > 0) rateLimit = limits.v3_contributor ?? 120;
                    else if (activeCredCount > 0) rateLimit = limits.contributor ?? 60;
                    else rateLimit = limits.newbie ?? 10;

                    const quotaConf = conf.quota || {};
                    if (activeV3CredCount > 0) baseQuota = quotaConf.v3_contributor ?? 3000;
                    else if (activeCredCount > 0) baseQuota = quotaConf.contributor ?? 1500;
                    else baseQuota = quotaConf.newbie ?? 300;
                } catch (e) { }
            }

            const systemSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
            const conf = (() => {
                try { return JSON.parse(systemSetting?.value || '{}'); } catch { return {}; }
            })();
            const inc = (conf.quota?.increment_per_credential ?? 1000);
            const extra = Math.max(0, activeCredCount - 1) * inc;
            const totalQuota = baseQuota + extra;

            if (user.today_used >= totalQuota) {
                return reply.code(402).send({ error: { type: 'overloaded_error', message: `Daily quota exceeded (${user.today_used}/${totalQuota})` } });
            }

            const rateKey = `RATE_LIMIT:${user.id}`;
            const currentRate = await redis.incr(rateKey);
            if (currentRate === 1) await redis.expire(rateKey, 60);
            if (currentRate > rateLimit) {
                return reply.code(429).send({ error: { type: 'rate_limit_error', message: `Rate limit exceeded (${rateLimit}/min)` } });
            }
        }

        // 2. Transfrom Request
        const anthropicBody = req.body as any;
        const openAIBody = convertAnthropicToOpenAI(anthropicBody);

        // 3. Process Request using ProxyController logic
        // 创建修改后的请求对象，传递给 handleChatCompletion
        const modifiedReq = {
            ...req,
            body: openAIBody
        } as FastifyRequest;

        // 使用 ProxyController 的通用处理方法
        return ProxyController.handleChatCompletion(modifiedReq, reply);
    }
}
