
/**
 * Anthropic 控制器
 * 处理 Anthropic 格式的 AI 请求，将其转换为 OpenAI 格式后转发给 ProxyController
 */
import { FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient, CredentialStatus } from '@prisma/client';
import { ProxyController } from './ProxyController';
import { convertAnthropicToOpenAI } from '../utils/adapters';
import { redis } from '../utils/redis';

const prisma = new PrismaClient();

/**
 * Anthropic 控制器类
 * 负责处理 Anthropic API 格式的请求
 */
export class AnthropicController {
    /**
     * 处理 Anthropic Messages API 请求
     * 将 Anthropic 格式转换为 OpenAI 格式，然后使用 ProxyController 处理
     * @param req Fastify 请求对象
     * @param reply Fastify 响应对象
     */
    static async handleMessages(req: FastifyRequest, reply: FastifyReply) {
        // 1. 认证处理（支持 x-api-key 或 Authorization 头）
        let apiKeyStr = '';
        if (req.headers['x-api-key']) {
            apiKeyStr = Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key'];
        } else if (req.headers.authorization?.startsWith('Bearer ')) {
            apiKeyStr = req.headers.authorization.replace('Bearer ', '').trim();
        }

        // 缺少 API 密钥时返回 401 错误
        if (!apiKeyStr) {
            return reply.code(401).send({ error: { type: 'authentication_error', message: '缺少 API 密钥' } });
        }

        // 验证 API 密钥有效性
        const apiKeyData = await prisma.apiKey.findUnique({
            where: { key: apiKeyStr },
            include: { user: true }
        });

        // 无效或已禁用的 API 密钥返回 401 错误
        if (!apiKeyData || !apiKeyData.is_active) {
            return reply.code(401).send({ error: { type: 'authentication_error', message: '无效或已禁用的 API 密钥' } });
        }

        const user = apiKeyData.user;
        // 已禁用的用户返回 401 错误
        if (!user.is_active) {
            return reply.code(401).send({ error: { type: 'permission_error', message: '🚫 您的账户已被禁用，请联系管理员解封。' } });
        }

        // 检查是否为管理员密钥
        const isAdminKey = (apiKeyData as any).type === 'ADMIN';

        // 检查是否强制要求 Discord 绑定
        const forceBindSetting = await prisma.systemSetting.findUnique({ where: { key: 'FORCE_DISCORD_BIND' } });
        const forceDiscordBind = forceBindSetting ? forceBindSetting.value === 'true' : false;
        if (forceDiscordBind && !isAdminKey) {
            const userFull = await prisma.user.findUnique({ where: { id: user.id } }) as any;
            if (!userFull?.discordId) {
                return reply.code(401).send({ error: { type: 'permission_error', message: '请先绑定 Discord 账户后再使用服务' } });
            }
        }

        // 获取用户凭证计数（用于权限检查和配额计算）
        // 冷却的凭证仍然算入配额增量，只有 DEAD 的不算
        const activeCredCount = await prisma.googleCredential.count({
            where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] } }
        });
        const activeV3CredCount = await prisma.googleCredential.count({
            where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] }, supports_v3: true }
        });

        // 配额和速率限制逻辑（与 ProxyController 保持一致）
        if (!isAdminKey) {
            const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
            let rateLimit = 10; // 默认萌新速率限制
            let baseQuota = 300; // 默认萌新配额

            if (configSetting) {
                try {
                    const conf = JSON.parse(configSetting.value);
                    const limits = conf.rate_limit || {};
                    // 根据用户等级设置速率限制
                    if (activeV3CredCount > 0) rateLimit = limits.v3_contributor ?? 120; // V3贡献者
                    else if (activeCredCount > 0) rateLimit = limits.contributor ?? 60; // 贡献者
                    else rateLimit = limits.newbie ?? 10; // 萌新

                    const quotaConf = conf.quota || {};
                    // 根据用户等级设置基础配额
                    if (activeV3CredCount > 0) baseQuota = quotaConf.v3_contributor ?? 3000; // V3贡献者
                    else if (activeCredCount > 0) baseQuota = quotaConf.contributor ?? 1500; // 贡献者
                    else baseQuota = quotaConf.newbie ?? 300; // 萌新
                } catch (e) {
                    console.error('解析系统配置失败:', e);
                }
            }

            // 计算额外凭证带来的配额增量
            const systemSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
            const conf = (() => {
                try { return JSON.parse(systemSetting?.value || '{}'); } catch { return {}; }
            })();
            const inc = (conf.quota?.increment_per_credential ?? 1000); // 每个额外凭证的配额增量
            const extra = Math.max(0, activeCredCount - 1) * inc; // 减去第一个凭证，只计算额外凭证
            const totalQuota = baseQuota + extra; // 总配额

            // 检查用户今日使用量是否超过总配额
            if (user.today_used >= totalQuota) {
                return reply.code(402).send({ error: { type: 'overloaded_error', message: `每日配额已用完 (${user.today_used}/${totalQuota})` } });
            }

            // 速率限制检查：使用 Redis 实现每分钟请求数限制
            const rateKey = `RATE_LIMIT:${user.id}`;
            const currentRate = await redis.incr(rateKey);
            if (currentRate === 1) {
                await redis.expire(rateKey, 60); // 设置 60 秒过期
            }
            if (currentRate > rateLimit) {
                return reply.code(429).send({ error: { type: 'rate_limit_error', message: `速率限制已超出 (${rateLimit}/分钟)` } });
            }
        }

        // 2. 请求格式转换：将 Anthropic 格式转换为 OpenAI 格式
        const anthropicBody = req.body as any;
        const openAIBody = convertAnthropicToOpenAI(anthropicBody);

        // 3. 使用 ProxyController 处理请求
        // 创建修改后的请求对象，将转换后的 OpenAI 格式作为请求体
        const modifiedReq = {
            ...req,
            body: openAIBody
        } as FastifyRequest;

        // 调用 ProxyController 的通用处理方法处理请求
        return ProxyController.handleChatCompletion(modifiedReq, reply);
    }
}
