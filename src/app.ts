/**
 * 主应用入口文件
 * 初始化 Fastify 服务器，配置中间件，注册路由，启动服务
 */
import 'dotenv/config'; // 加载环境变量
import Fastify from 'fastify'; // Fastify 框架
import cors from '@fastify/cors'; // CORS 中间件
import fastifyStatic from '@fastify/static'; // 静态文件服务
import path from 'path'; // 路径处理
import fs from 'fs'; // 文件系统
import { CredentialPoolManager } from './services/CredentialPoolManager'; // 凭证池管理器
import { CronService } from './services/CronService'; // 定时任务服务
import { ProxyController } from './controllers/ProxyController'; // 代理控制器
import { GoogleAIController } from './controllers/GoogleAIController'; // Google AI 控制器
import { AntigravityTokenManager } from './services/AntigravityTokenManager'; // 反重力令牌管理器
import adminRoutes from './routes/admin'; // 管理员路由
import authRoutes from './routes/auth'; // 认证路由
import credentialRoutes from './routes/credential'; // 凭证路由
import antigravityAdminRoutes from './routes/antigravityAdmin'; // 反重力管理员路由
import { getConfig } from './config/appConfig'; // 应用配置
import bcrypt from 'bcryptjs'; // 密码加密
import { redis } from './utils/redis'; // Redis 客户端
import { prisma } from './utils/prisma'; // 优化的 Prisma 客户端
import { monitoringMiddleware } from './middlewares/monitoring'; // 监控中间件

// --- 配置部分 ---
const { port: PORT } = getConfig();

// --- 初始化部分 ---
const app = Fastify({
  logger: true,
  trustProxy: true
});

const poolManager = new CredentialPoolManager();

/**
 * 主启动函数
 * 初始化 Fastify 应用，配置中间件，连接数据库，注册路由，启动服务器
 */
async function bootstrap() {
  console.log('[System] --- GEMINI PROXY FINAL FIX STARTING ---');
  try {
    // 注册 CORS 中间件，允许所有来源的请求
  await app.register(cors, {
    origin: '*', // 允许所有来源
    methods: ['GET', 'POST', 'PUT', 'DELETE'] // 允许的 HTTP 方法
  });

  // 应用监控中间件
  await monitoringMiddleware(app);

  // 静态文件路径配置
    const distPublic = path.join(process.cwd(), 'dist', 'public'); // 构建后的静态文件目录
    const legacyPublic = path.join(process.cwd(), 'public'); // 传统静态文件目录
    // 优先使用构建后的静态文件，如果不存在则使用传统目录
    const publicPath = fs.existsSync(path.join(distPublic, 'index.html')) ? distPublic : legacyPublic;

    console.log(`[System] 检查前端文件位置: ${publicPath}`);

    // 如果存在 index.html，则注册静态文件服务
    if (fs.existsSync(path.join(publicPath, 'index.html'))) {
      console.log(`[System] ✅ 前端文件已找到，正在提供服务: ${publicPath}`);
      await app.register(fastifyStatic, {
        root: publicPath, // 静态文件根目录
        prefix: '/', // 访问前缀
      });

      // 配置 404 处理
      app.setNotFoundHandler((req, reply) => {
        const url = req.raw.url || '';
        if (url.startsWith('/api') || url.startsWith('/v1')) {
          // API 请求返回 404
          reply.code(404).send({ error: '接口未找到', path: url });
        } else {
          // 非 API 请求返回 index.html，支持前端路由
          reply.sendFile('index.html');
        }
      });
    } else {
      console.error(`[System] ❌ 致命错误: index.html 缺失。检查了: ${distPublic} 和 ${legacyPublic}`);
      // 列出文件以进行调试
      try {
        console.log('/app 目录内容:', fs.readdirSync('/app'));
      } catch (e) { }
    }

    // --- 服务初始化 --- //
    await prisma.$connect(); // 连接 Prisma 数据库
    if (redis.status === 'ready' || redis.status === 'connect') console.log('[System] Redis 已连接。');
    await poolManager.syncToRedis(); // 将凭证池同步到 Redis
    new CronService(); // 初始化定时任务服务

    // --- 从环境变量初始化管理员账户 --- //
    const { admin } = getConfig();
    if (admin.username && admin.password) {
      // 检查是否已存在管理员账户
      const existingAdmin = await prisma.user.findFirst({
        where: {
          OR: [
            { username: admin.username },
            { email: admin.username }
          ]
        }
      });

      if (!existingAdmin) {
        // 创建新的管理员账户
        console.log(`[System] 从环境变量创建管理员用户: ${admin.username}`);
        const hashedPassword = await bcrypt.hash(admin.password, 10); // 密码加密
        await prisma.user.create({
          data: {
            email: admin.username,
            username: admin.username,
            password: hashedPassword,
            role: 'ADMIN', // 设置角色为管理员
            daily_limit: 999999 // 设置极高的日配额
          }
        });
        console.log('[System] 管理员用户创建成功。');
      } else {
        // 确保现有用户是管理员角色
        if (existingAdmin.role !== 'ADMIN') {
          console.log(`[System] 将现有用户 ${admin.username} 更新为管理员角色。`);
          await prisma.user.update({
            where: { id: existingAdmin.id },
            data: { role: 'ADMIN' }
          });
        }
      }
    }

    // --- 注册路由 --- //
    await app.register(authRoutes, { prefix: '/api/auth' }); // 认证路由
    await app.register(adminRoutes); // 管理员路由
    await app.register(credentialRoutes, { prefix: '/api/credentials' }); // 凭证管理路由
    await app.register(antigravityAdminRoutes, { prefix: '/api/antigravity' }); // 反重力管理路由

    // --- 公共 API 路由注册 --- //
    // OpenAI 兼容路由（支持自动检测三种格式: OpenAI/Gemini/Anthropic）
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
        return reply.code(404).send({ error: `未知动作: ${action}` });
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
        return reply.code(404).send({ error: `未知动作: ${action}` });
      }
    });

    app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

    // 启动服务器
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[System] 服务器正在监听 http://0.0.0.0:${PORT}`);
    (global as any).__appStartedAt = Date.now();
    // 启动后 3 秒执行反重力令牌刷新（预热）
    setTimeout(async () => {
      try {
        const mgr = new AntigravityTokenManager();
        await mgr.refreshAllActiveTokens();
        console.log('[System] 启动预热: 反重力令牌已刷新');
      } catch (e) {
        console.warn('[System] 启动预热失败:', (e as any)?.message || e);
      }
    }, 3000);

  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

/**
 * 优雅关闭函数
 * 关闭 Fastify 服务器，断开 Prisma 连接，断开 Redis 连接
 */
const shutdown = async () => {
  console.log('[System] 正在关闭服务...');
  await app.close(); // 关闭 Fastify 服务器
  await prisma.$disconnect(); // 断开 Prisma 数据库连接
  redis.disconnect(); // 断开 Redis 连接
  console.log('[System] 服务已关闭');
  process.exit(0); // 退出进程
};

// 监听 SIGINT 信号（Ctrl+C）
process.on('SIGINT', shutdown);
// 监听 SIGTERM 信号（终止信号）
process.on('SIGTERM', shutdown);

// 启动应用
bootstrap();
