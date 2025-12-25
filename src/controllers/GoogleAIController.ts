/**
 * GoogleAI 控制器
 * 处理 Google AI API 格式的请求，支持 Gemini 模型的内容生成
 */
import { FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient, CredentialStatus } from '@prisma/client';
import { PassThrough, Transform } from 'stream';
import { getUserAgent } from '../utils/system';
import { makeHttpError, isHttpError } from '../utils/http';
import { CredentialPoolManager } from '../services/CredentialPoolManager';
import { extractRealModelName, isAntigravityModel } from '../config/antigravityConfig';
import { ProxyController } from './ProxyController';
import { redis } from '../utils/redis';

const prisma = new PrismaClient();
const poolManager = new CredentialPoolManager();

/**
 * 检查是否是 Gemini 3.0 模型名称
 * @param name 模型名称
 * @returns 是否是 V3 模型
 */
function isV3ModelName(name: string): boolean {
  return name.includes('gemini-3') || name.includes('gemini-exp');
}

/**
 * 处理模型名称，移除 CLI 后缀和流策略标记
 * @param model 原始模型名称
 * @returns 包含真实模型名称和流策略的对象
 */
function stripCliSuffixAndStrategy(model: string): { real: string; fakeStream: boolean } {
  let m = model.replace('-[星星公益站-CLI渠道]', '')
    .replace('-[星星公益站-任何收费都是骗子]', '')
    .replace('-[星星公益站-所有收费都骗子]', '');
  let fake = false;
  if (m.includes('-假流')) {
    fake = true;
    m = m.replace('-假流', '');
  } else if (m.includes('-真流')) {
    m = m.replace('-真流', '');
  }
  return { real: m, fakeStream: fake };
}

/**
 * 验证请求的 API 密钥
 * @param req Fastify 请求对象
 * @param reply Fastify 响应对象
 * @returns 包含 API 密钥和用户信息的对象，验证失败返回 null
 */
async function verifyAuth(req: FastifyRequest, reply: FastifyReply): Promise<{ apiKey: any; user: any } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    await reply.code(401).send({ error: '缺少 API 密钥' });
    return null;
  }
  const apiKeyStr = authHeader.replace('Bearer ', '').trim();
  const apiKeyData = await prisma.apiKey.findUnique({ where: { key: apiKeyStr }, include: { user: true } });
  if (!apiKeyData || !apiKeyData.is_active) {
    await reply.code(401).send({ error: '无效或已禁用的 API 密钥' });
    return null;
  }
  const user = apiKeyData.user;
  if (!user.is_active) {
    await reply.code(401).send({ error: '🚫 您的账户已被禁用，请联系管理员解封。' });
    return null;
  }
  return { apiKey: apiKeyData, user };
}

/**
 * GoogleAI 控制器类
 * 负责处理 Google AI API 格式的请求
 */
export class GoogleAIController {
  /**
   * 列出可用模型
   * @param req Fastify 请求对象
   * @param reply Fastify 响应对象
   */
  static async listModels(req: FastifyRequest, reply: FastifyReply) {
    // 优先从 ProxyController 的缓存获取模型列表
    const models = (ProxyController as any).modelsCache?.data
      ? (ProxyController as any).modelsCache.data.map((m: any) => m.id)
      : (function () { const fn = (ProxyController as any).handleListModels; return null; })() || [];
    // 缓存为空时，从 ProxyController 获取最新模型列表
    const ids = models.length > 0 ? models : (function get() {
      // 备用方案：直接调用 getAvailableModels 函数
      return (require('./ProxyController') as any).getAvailableModels
        ? (require('./ProxyController') as any).getAvailableModels()
        : [];
    })();
    // 处理模型名称，移除后缀和策略标记
    const plain = ids.map((id: string) => stripCliSuffixAndStrategy(id).real);
    // 返回模型列表，包括原始模型名称和处理后的纯模型名称
    return reply.send({ models: ids, plain_models: Array.from(new Set(plain)) });
  }

  /**
   * 处理非流式内容生成请求
   * @param req Fastify 请求对象
   * @param reply Fastify 响应对象
   */
  static async generateContent(req: FastifyRequest, reply: FastifyReply) {
    // 验证 API 密钥
    const auth = await verifyAuth(req, reply);
    if (!auth) return;
    const { apiKey, user } = auth;
    const isAdminKey = (apiKey as any).type === 'ADMIN';
    const body = req.body as any;
    const modelParam = (req.params as any).model as string;

    // 检查是否是反重力渠道模型，不支持该渠道
    if (isAntigravityModel(modelParam)) {
      return reply.code(400).send({ error: 'GoogleAI 端点不支持反重力渠道模型' });
    }

    // 处理模型名称，获取真实模型名称和流策略
    const stripped = stripCliSuffixAndStrategy(modelParam);
    const realModelName = stripped.real;
    const isV3 = isV3ModelName(realModelName);
    let poolType: 'GLOBAL' | 'V3' = 'GLOBAL';

    // 获取用户的凭证计数
    const activeCredCount = await prisma.googleCredential.count({
      where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] } }
    });
    const activeV3CredCount = await prisma.googleCredential.count({
      where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] }, supports_v3: true }
    });

    // V3 模型权限检查
    if (isV3) {
      const isAdmin = user.role === 'ADMIN';
      const hasV3Creds = activeV3CredCount > 0;
      const openAccessSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_GEMINI3_OPEN_ACCESS' } });
      const enableOpenAccess = openAccessSetting ? openAccessSetting.value === 'true' : false;
      if (!enableOpenAccess) {
        if (!isAdmin && !hasV3Creds && !isAdminKey) {
          return reply.code(401).send({ error: '🔒 此模型 (Gemini 3.0) 仅限管理员或上传了 3.0 凭证的用户使用。' });
        }
      }
      poolType = 'V3';
    }

    // CLI 共享模式检查
    const cliSharedSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_CLI_SHARED_MODE' } });
    let isCliSharedMode = cliSharedSetting ? cliSharedSetting.value === 'true' : true;
    if (cliSharedSetting == null) {
      // 兼容旧键
      const legacy = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_SHARED_MODE' } });
      isCliSharedMode = legacy ? legacy.value === 'true' : true;
    }
    if (!isCliSharedMode && !isAdminKey) {
      const isAdmin = user.role === 'ADMIN';
      const hasCliCredential = activeCredCount > 0;
      if (!isAdmin && !hasCliCredential) {
        return reply.code(401).send({ error: '🔒 已关闭 CLI 共享模式：仅上传 CLI 凭证的用户可以使用 Cloud Code 渠道。' });
      }
    }

    // 非管理员用户增加使用计数
    if (!isAdminKey) {
      await prisma.user.update({ where: { id: user.id }, data: { today_used: { increment: 1 } } }).catch(() => { });
    }

    // 获取凭证
    const cred = await poolManager.getRoundRobinCredential(poolType, user.id, 30000);
    if (!cred) {
      return reply.code(500).send({ error: '没有可用的有效凭证' });
    }

    const finalPayload = {
      model: realModelName,
      project: cred.projectId,
      request: body
    };

    try {
      // 调用 ProxyController 的 sendGeminiRequest 方法发送请求
      const googleResponse = await (ProxyController as any).sendGeminiRequest(
        realModelName, body, false, cred.credentialId, cred.accessToken, cred.projectId
      );
      // 记录成功调用
      await (ProxyController as any).recordSuccessfulCall(cred.credentialId, realModelName, user.id);
      const resp = reply.send(googleResponse);
      // 释放凭证锁
      try { await poolManager.releaseLock(cred.credentialId, user.id); } catch { }
      return resp;
    } catch (error: any) {
      if (isHttpError(error)) {
        const r = reply.code(error.statusCode || 500).send({ error: error.body || error.message });
        try { await poolManager.releaseLock(cred.credentialId, user.id); } catch { }
        return r;
      }
      const r = reply.code(500).send({ error: error.message || '内部错误' });
      try { await poolManager.releaseLock(cred.credentialId, user.id); } catch { }
      return r;
    }
  }

  /**
   * 处理流式内容生成请求
   * @param req Fastify 请求对象
   * @param reply Fastify 响应对象
   */
  static async streamGenerateContent(req: FastifyRequest, reply: FastifyReply) {
    // 验证 API 密钥
    const auth = await verifyAuth(req, reply);
    if (!auth) return;
    const { apiKey, user } = auth;
    const isAdminKey = (apiKey as any).type === 'ADMIN';
    const body = req.body as any;
    const modelParam = (req.params as any).model as string;

    // 检查是否是反重力渠道模型，不支持该渠道
    if (isAntigravityModel(modelParam)) {
      reply.code(400).send({ error: 'GoogleAI 端点不支持反重力渠道模型' });
      return;
    }

    // 处理模型名称，获取真实模型名称和流策略
    const stripped = stripCliSuffixAndStrategy(modelParam);
    const realModelName = stripped.real;
    const isV3 = isV3ModelName(realModelName);
    let poolType: 'GLOBAL' | 'V3' = 'GLOBAL';

    // 获取用户的凭证计数
    const activeCredCount = await prisma.googleCredential.count({
      where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] } }
    });
    const activeV3CredCount = await prisma.googleCredential.count({
      where: { owner_id: user.id, status: { in: [CredentialStatus.ACTIVE, CredentialStatus.COOLING] }, supports_v3: true }
    });

    // V3 模型权限检查
    if (isV3) {
      const isAdmin = user.role === 'ADMIN';
      const hasV3Creds = activeV3CredCount > 0;
      const openAccessSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_GEMINI3_OPEN_ACCESS' } });
      const enableOpenAccess = openAccessSetting ? openAccessSetting.value === 'true' : false;
      if (!enableOpenAccess) {
        if (!isAdmin && !hasV3Creds && !isAdminKey) {
          reply.code(401).send({ error: '🔒 此模型 (Gemini 3.0) 仅限管理员或上传了 3.0 凭证的用户使用。' });
          return;
        }
      }
      poolType = 'V3';
    }

    // CLI 共享模式检查
    const cliSharedSetting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_CLI_SHARED_MODE' } });
    let isCliSharedMode = cliSharedSetting ? cliSharedSetting.value === 'true' : true;
    if (cliSharedSetting == null) {
      // 兼容旧键
      const legacy = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_SHARED_MODE' } });
      isCliSharedMode = legacy ? legacy.value === 'true' : true;
    }
    if (!isCliSharedMode && !isAdminKey) {
      const isAdmin = user.role === 'ADMIN';
      const hasCliCredential = activeCredCount > 0;
      if (!isAdmin && !hasCliCredential) {
        reply.code(401).send({ error: '🔒 已关闭 CLI 共享模式：仅上传 CLI 凭证的用户可以使用 Cloud Code 渠道。' });
        return;
      }
    }

    // 非管理员用户增加使用计数
    if (!isAdminKey) {
      await prisma.user.update({ where: { id: user.id }, data: { today_used: { increment: 1 } } }).catch(() => { });
    }

    // 获取凭证
    const cred = await poolManager.getRoundRobinCredential(poolType, user.id, 60000);
    if (!cred) {
      reply.code(500).send({ error: '没有可用的有效凭证' });
      return;
    }

    // 设置流式响应头
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    try {
      // 调用 ProxyController 的 sendGeminiRequest 方法发送流式请求
      await (ProxyController as any).sendGeminiRequest(
        realModelName, body, true, cred.credentialId, cred.accessToken, cred.projectId,
        async (line: string) => {
          // 直接透传原生行
          reply.raw.write(`${line}\n`);
        }
      );
      // 记录成功调用
      await (ProxyController as any).recordSuccessfulCall(cred.credentialId, realModelName, user.id);
      // 发送结束标记
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      // 释放凭证锁
      try { await poolManager.releaseLock(cred.credentialId, user.id); } catch { }
    } catch (error: any) {
      const status = isHttpError(error) ? error.statusCode : 500;
      const msg = isHttpError(error) ? (error.body || error.message) : (error.message || '内部错误');
      // 发送错误信息
      reply.raw.write(`data: ${JSON.stringify({ error: msg, code: status })}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      // 释放凭证锁
      try { await poolManager.releaseLock(cred.credentialId, user.id); } catch { }
    }
  }
}
