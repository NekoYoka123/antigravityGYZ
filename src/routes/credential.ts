/**
 * 凭证路由模块
 * 提供凭证上传、查询、删除、检查等功能
 */
import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { CredentialService } from '../services/CredentialService';
import { CredentialPoolManager } from '../services/CredentialPoolManager';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { redis } from '../utils/redis';

const prisma = new PrismaClient();
const credentialService = new CredentialService();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// 凭证上传验证模式
const UploadSchema = z.object({
  json_content: z.string().min(1), // JSON 格式的凭证内容
  require_v3: z.boolean().optional() // 是否要求支持 Gemini 3.0
});

export default async function credentialRoutes(fastify: FastifyInstance) {

  // --- 认证中间件 ---
  /**
   * 认证中间件
   * 验证 JWT 令牌，确保用户已登录
   */
  fastify.addHook('preHandler', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw { statusCode: 401, message: '未授权' };
    }
    const token = authHeader.replace('Bearer ', '');
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      req.user = decoded;
    } catch (e) {
      throw { statusCode: 401, message: '无效令牌' };
    }
  });

  /**
   * 获取当前用户的凭证列表
   * GET /api/credentials
   * @returns 凭证列表，包含所有状态的凭证
   */
  fastify.get('/', async (req, reply) => {
    const creds = await prisma.googleCredential.findMany({
      where: { owner_id: req.user!.id }, // 返回所有状态的凭证（包括 DEAD）
      select: { 
        id: true, 
        created_at: true, 
        status: true, 
        fail_count: true, 
        supports_v3: true, 
        google_email: true 
      }
    });
    return creds;
  });


  /**
   * 上传新的凭证
   * POST /api/credentials
   * @param json_content JSON 格式的凭证内容
   * @param require_v3 是否要求支持 Gemini 3.0
   * @returns 上传结果，包含凭证信息和验证状态
   */
  fastify.post('/', async (req, reply) => {
    try {
      const body = UploadSchema.parse(req.body);
      const result = await credentialService.uploadAndVerify(req.user!.id, body.json_content, body.require_v3);

      // 凭证服务内部已经处理了 Redis 同步，无需额外操作
      // CredentialService 会调用 poolManager.addCredential 添加到池中

      return result;
    } catch (e: any) {
      req.log.error(e);
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * 删除用户自己的凭证
   * DELETE /api/credentials/:id
   * @param id 凭证 ID
   * @returns 删除结果
   */
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const credentialId = Number(id);

    // 验证凭证所有权
    const cred = await prisma.googleCredential.findFirst({
      where: { id: credentialId, owner_id: req.user!.id }
    });

    if (!cred) return reply.code(404).send({ error: '凭证未找到' });

    // 事务：硬删除凭证 + 降级用户
    await prisma.$transaction(async (tx) => {
      // 1. 硬删除凭证
      await tx.googleCredential.delete({
        where: { id: credentialId }
      });

      // 2. 从 Redis 中移除凭证 (尽力而为)
      await redis.lrem('GLOBAL_CREDENTIAL_POOL', 0, String(credentialId));

      // 3. 检查用户是否还有其他活跃凭证
      const count = await tx.googleCredential.count({
        where: {
          owner_id: req.user!.id,
          status: 'ACTIVE'
        }
      });

      // 4. 如果没有活跃凭证，降级用户
      if (count === 0) {
        await tx.user.update({
          where: { id: req.user!.id },
          data: { level: 0 }
        });
      }
    });

    return { success: true, message: '凭证已撤销' };
  });

  /**
   * 检查凭证是否支持 Gemini 3.0
   * POST /api/credentials/:id/check-v3
   * @param id 凭证 ID
   * @returns 检查结果，包含是否支持和可能的错误信息
   */
  fastify.post('/:id/check-v3', async (req, reply) => {
    const { id } = req.params as { id: string };
    const credentialId = Number(id);

    const cred = await prisma.googleCredential.findFirst({
      where: { id: credentialId, owner_id: req.user!.id }
    });

    if (!cred) return reply.code(404).send({ error: '凭证未找到' });

    try {
      const result = await credentialService.checkV3Support(cred);
      return { success: true, supports_v3: result.supported, error: result.error };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 上传前检查凭证是否支持 Gemini 3.0
   * POST /api/credentials/check-raw
   * @param json_content 原始 JSON 格式的凭证内容
   * @param require_v3 是否要求支持 Gemini 3.0
   * @returns 检查结果，包含是否支持和可能的错误信息
   */
  fastify.post('/check-raw', async (req, reply) => {
    try {
      const body = UploadSchema.parse(req.body);
      // 解析 JSON 获取详情
      let parsed;
      try { parsed = JSON.parse(body.json_content); } catch (e) { throw new Error('无效的 JSON 格式'); }

      // 模拟凭证对象用于服务检查
      const credMock = {
        client_id: parsed.client_id || parsed.web?.client_id || parsed.installed?.client_id,
        client_secret: parsed.client_secret || parsed.web?.client_secret || parsed.installed?.client_secret,
        refresh_token: parsed.refresh_token,
        project_id: parsed.project_id
      };

      if (!credMock.client_id || !credMock.client_secret || !credMock.refresh_token) {
        throw new Error('缺少必要字段 (client_id, client_secret, refresh_token)');
      }

      const result = await credentialService.checkV3Support(credMock);

      // 如果不支持，返回错误原因以便前端显示
      return {
        success: true,
        supports_v3: result.supported,
        error: result.error
      };

    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}
