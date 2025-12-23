import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import path from 'path';
import fs from 'fs';
import { CredentialPoolManager } from './services/CredentialPoolManager';
import { CronService } from './services/CronService';
import { ProxyController } from './controllers/ProxyController';
import { GoogleAIController } from './controllers/GoogleAIController';
import { AntigravityTokenManager } from './services/AntigravityTokenManager';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import credentialRoutes from './routes/credential';
import antigravityAdminRoutes from './routes/antigravityAdmin';
import { getConfig } from './config/appConfig';
import bcrypt from 'bcryptjs';

// --- Configuration ---
const { port: PORT, redisUrl: REDIS_URL } = getConfig();

// --- Initialization ---
const app = Fastify({
  logger: true,
  trustProxy: true
});

const prisma = new PrismaClient();
const redis = new Redis(REDIS_URL);
const poolManager = new CredentialPoolManager();

// --- Main Bootstrap ---
async function bootstrap() {
  console.log('--- GEMINI PROXY FINAL FIX STARTING ---');
  try {
    await app.register(cors, {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    });

    const distPublic = path.join(process.cwd(), 'dist', 'public');
    const legacyPublic = path.join(process.cwd(), 'public');
    const publicPath = fs.existsSync(path.join(distPublic, 'index.html')) ? distPublic : legacyPublic;

    console.log(`[System] Checking frontend at: ${publicPath}`);

    if (fs.existsSync(path.join(publicPath, 'index.html'))) {
      console.log(`[System] ✅ Frontend FOUND at: ${publicPath}. Serving...`);
      await app.register(fastifyStatic, {
        root: publicPath,
        prefix: '/',
      });

      app.setNotFoundHandler((req, reply) => {
        const url = req.raw.url || '';
        if (url.startsWith('/api') || url.startsWith('/v1')) {
          reply.code(404).send({ error: 'Endpoint Not Found', path: url });
        } else {
          reply.sendFile('index.html');
        }
      });
    } else {
      console.error(`[System] ❌ FATAL: index.html missing. Checked: ${distPublic} and ${legacyPublic}`);
      // List files to debug what happened
      try {
        console.log('Contents of /app:', fs.readdirSync('/app'));
      } catch (e) { }
    }

    // Services
    await prisma.$connect();
    if (redis.status === 'ready' || redis.status === 'connect') console.log('[System] Redis connected.');
    await poolManager.syncToRedis();
    new CronService();

    // Initialize Admin from Env
    const { admin } = getConfig();
    if (admin.username && admin.password) {
      const existingAdmin = await prisma.user.findFirst({
        where: {
          OR: [
            { username: admin.username },
            { email: admin.username }
          ]
        }
      });

      if (!existingAdmin) {
        console.log(`[System] Creating admin user from env: ${admin.username}`);
        const hashedPassword = await bcrypt.hash(admin.password, 10);
        await prisma.user.create({
          data: {
            email: admin.username,
            username: admin.username,
            password: hashedPassword,
            role: 'ADMIN',
            daily_limit: 999999
          }
        });
        console.log('[System] Admin user created successfully.');
      } else {
        // Optional: Update password or role if exists?
        // For now, just ensure role is ADMIN
        if (existingAdmin.role !== 'ADMIN') {
          console.log(`[System] Updating existing user ${admin.username} to ADMIN role.`);
          await prisma.user.update({
            where: { id: existingAdmin.id },
            data: { role: 'ADMIN' }
          });
        }
      }
    }

    // Routes
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.register(adminRoutes);
    await app.register(credentialRoutes, { prefix: '/api/credentials' });
    await app.register(antigravityAdminRoutes, { prefix: '/api/antigravity' });

    // Public OpenAI-compatible Routes (支持自动检测三种格式: OpenAI/Gemini/Anthropic)
    app.post('/v1/chat/completions', ProxyController.handleUniversalRequest);

    // 智能模型列表：根据查询参数或请求头判断返回格式
    // 用法：/v1/models?format=gemini 或 /v1/models?format=anthropic
    app.get('/v1/models', async (req, reply) => {
      const query = req.query as any;
      const format = query.format?.toLowerCase();

      // 1. 显式指定格式（推荐）
      if (format === 'gemini') {
        return ProxyController.handleListModelsGemini(req, reply);
      }
      if (format === 'anthropic') {
        return ProxyController.handleListModelsAnthropic(req, reply);
      }

      // 2. 自动检测（通过请求头）
      const isGeminiClient = req.headers['x-goog-api-key'] ||
        (req.headers['user-agent'] && req.headers['user-agent'].includes('generativelanguage'));
      const isAnthropicClient = req.headers['x-api-key'] &&
        req.headers['anthropic-version'];

      if (isGeminiClient) {
        return ProxyController.handleListModelsGemini(req, reply);
      }
      if (isAnthropicClient) {
        return ProxyController.handleListModelsAnthropic(req, reply);
      }

      // 3. 默认 OpenAI 格式
      return ProxyController.handleListModels(req, reply);
    });

    // 额外的 Gemini 格式模型列表端点（v1beta 兼容）
    app.get('/v1beta/models', ProxyController.handleListModelsGemini);

    // Gemini 原生格式路由 (Google AI Studio 兼容)
    app.post('/v1/models/:model\\::action', async (req, reply) => {
      const { action } = req.params as { model: string; action: string };
      if (action === 'generateContent') {
        return ProxyController.handleGeminiNative(req, reply);
      } else if (action === 'streamGenerateContent') {
        return ProxyController.handleGeminiNativeStream(req, reply);
      } else {
        return reply.code(404).send({ error: `Unknown action: ${action}` });
      }
    });

    // Anthropic 原生格式路由 (Claude API 兼容)
    app.get('/v1/models/anthropic', ProxyController.handleListModelsAnthropic); // 专用端点
    app.post('/v1/messages', ProxyController.handleAnthropicNative);

    // 向后兼容: /googleai 路由 (CLI/Cloud Code 专用)
    app.get('/googleai/models', GoogleAIController.listModels);
    app.post('/googleai/models/:model\\::action', async (req, reply) => {
      const { action } = req.params as { model: string; action: string };
      if (action === 'generateContent') {
        return GoogleAIController.generateContent(req, reply);
      } else if (action === 'streamGenerateContent') {
        return GoogleAIController.streamGenerateContent(req, reply);
      } else {
        return reply.code(404).send({ error: `Unknown action: ${action}` });
      }
    });

    app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[System] Server listening on http://0.0.0.0:${PORT}`);
    (global as any).__appStartedAt = Date.now();
    setTimeout(async () => {
      try {
        const mgr = new AntigravityTokenManager();
        await mgr.refreshAllActiveTokens();
        console.log('[System] Startup warm-up: Antigravity tokens refreshed');
      } catch (e) {
        console.warn('[System] Startup warm-up failed:', (e as any)?.message || e);
      }
    }, 3000);

  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap();
