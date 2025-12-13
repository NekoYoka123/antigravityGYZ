import { FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient, CredentialStatus } from '@prisma/client';
import Redis from 'ioredis';
import { stream } from 'undici';
import { CredentialPoolManager } from '../services/CredentialPoolManager';
import { PassThrough, Transform } from 'stream';
import { getUserAgent } from '../utils/system';
import { mergeSafetySettings, transformTools } from '../utils/gemini_transforms';
import { antigravityTokenManager } from '../services/AntigravityTokenManager';
import { AntigravityService } from '../services/AntigravityService';
import { isAntigravityModel, extractRealModelName, getAntigravityModelNames, ANTIGRAVITY_SUFFIX } from '../config/antigravityConfig';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const poolManager = new CredentialPoolManager();

// --- Model Configuration (Ported from gcli2api/config.py) ---

const DEFAULT_SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

function getAvailableModels() {
    // Cloud Code 渠道模型
    const cloudCodeModels = [
        "gemini-2.5-flash-真流-[星星公益站-任何收费都是骗子]",
        "gemini-2.5-flash-假流-[星星公益站-任何收费都是骗子]",
        "gemini-2.5-pro-真流-[星星公益站-任何收费都是骗子]",
        "gemini-2.5-pro-假流-[星星公益站-任何收费都是骗子]",
        "gemini-3-pro-preview-真流-[星星公益站-任何收费都是骗子]",
        "gemini-3-pro-preview-假流-[星星公益站-任何收费都是骗子]"
    ];

    // 反重力渠道模型
    const antigravityModels = getAntigravityModelNames();

    return [...cloudCodeModels, ...antigravityModels];
}

export class ProxyController {
    private static modelsCache: { data: any[]; expiresAt: number } | null = null;

    static async handleChatCompletion(req: FastifyRequest, reply: FastifyReply) {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return reply.code(401).send({ error: 'Missing API Key' });
        }
        const apiKeyStr = authHeader.replace('Bearer ', '').trim();

        // 0. Fast Health Check (Before DB/Auth)
        // Intercept "Hi" messages immediately to speed up connection tests
        try {
            const body = req.body as any;
            const messages = body.messages || [];
            if (messages.length === 1 && messages[0].role === 'user' && messages[0].content === 'Hi') {
                return reply.send({
                    choices: [{ message: { role: 'assistant', content: 'Gemini Proxy 正常工作中' } }]
                });
            }
        } catch (e) { }

        // 1. Auth & Rate Limiting
        const apiKeyData = await prisma.apiKey.findUnique({
            where: { key: apiKeyStr },
            include: { user: true }
        });

        if (!apiKeyData || !apiKeyData.is_active) {
            return reply.code(401).send({ error: 'Invalid or disabled API Key' });
        }

        const user = apiKeyData.user;

        if (!user.is_active) {
            return reply.code(403).send({ error: '🚫 您的账户已被禁用，请联系管理员解封。' });
        }

        const isAdminKey = (apiKeyData as any).type === 'ADMIN';

        const forceBindSetting = await prisma.systemSetting.findUnique({ where: { key: 'FORCE_DISCORD_BIND' } });
        const forceDiscordBind = forceBindSetting ? forceBindSetting.value === 'true' : false;
        if (forceDiscordBind && !isAdminKey) {
            const userFull = await prisma.user.findUnique({ where: { id: user.id } }) as any;
            if (!userFull?.discordId) {
                return reply.code(403).send({ error: '请先绑定 Discord 账户后再使用服务' });
            }
        }

        // Fetch counts for permissions
        const activeCredCount = await prisma.googleCredential.count({
            where: { owner_id: user.id, status: CredentialStatus.ACTIVE }
        });
        const activeV3CredCount = await prisma.googleCredential.count({
            where: { owner_id: user.id, status: CredentialStatus.ACTIVE, supports_v3: true }
        });

        // --- Access Control Logic (Shared Mode) ---
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'ENABLE_SHARED_MODE' } });
        const isSharedMode = setting ? setting.value === 'true' : true; // Default to Shared

        if (!isSharedMode && !isAdminKey) {
            const isContributor = activeCredCount > 0;
            const isAdmin = user.role === 'ADMIN';

            if (!isAdmin && !isContributor) {
                return reply.code(403).send({
                    error: 'Access Denied. Shared Mode is disabled. Please upload a valid credential to use the service.'
                });
            }
        }

        if (!isAdminKey) {
            // Fetch System Config
            const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'SYSTEM_CONFIG' } });
            let rateLimit = 10; // Default Newbie
            let baseQuota = 300; // Default Newbie Quota

            if (configSetting) {
                try {
                    const conf = JSON.parse(configSetting.value);
                    const limits = conf.rate_limit || {};

                    // Rate Limit Logic (Keep as is, based on level/V3)
                    if (activeV3CredCount > 0) rateLimit = limits.v3_contributor ?? 120;
                    else if (activeCredCount > 0) rateLimit = limits.contributor ?? 60;
                    else rateLimit = limits.newbie ?? 10;

                    const quotaConf = conf.quota || {};
                    if (activeV3CredCount > 0) {
                        baseQuota = quotaConf.v3_contributor ?? 3000;
                    } else if (activeCredCount > 0) {
                        baseQuota = quotaConf.contributor ?? 1500;
                    } else {
                        baseQuota = quotaConf.newbie ?? 300;
                    }
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
                return reply.code(402).send({ error: `Daily quota exceeded (${user.today_used}/${totalQuota})` });
            }

            const rateKey = `RATE_LIMIT:${user.id}`;
            const currentRate = await redis.incr(rateKey);
            if (currentRate === 1) await redis.expire(rateKey, 60);
            if (currentRate > rateLimit) {
                return reply.code(429).send({ error: `Rate limit exceeded (${rateLimit}/min)` });
            }
        }

        // 2. Parse Request
        const openAIBody = req.body as any;
        if (!openAIBody.messages && typeof openAIBody.prompt === 'string') {
            openAIBody.messages = [{ role: 'user', content: String(openAIBody.prompt) }];
        }
        // Clamp temperature in incoming body to sane range for Antigravity path
        if (typeof openAIBody.temperature === 'number') {
            openAIBody.temperature = Math.min(1.0, Math.max(0.1, openAIBody.temperature));
        }
        const requestedModel = openAIBody.model;
        const isStreaming = openAIBody.stream === true;

        // 检查是否是反重力渠道模型
        if (isAntigravityModel(requestedModel)) {
            return ProxyController.handleAntigravityRequest(req, reply, openAIBody, user, isAdminKey);
        }

        // Model Mapping Logic (Cloud Code 渠道)
        let realModelName = requestedModel;
        let useFakeStream = false;

        if (requestedModel.includes('-[星星公益站-任何收费都是骗子]')) {
            // Remove suffix
            let base = requestedModel.replace('-[星星公益站-任何收费都是骗子]', '');

            // Check strategy
            if (base.includes('-假流')) {
                useFakeStream = true;
                realModelName = base.replace('-假流', '');
            } else if (base.includes('-真流')) {
                realModelName = base.replace('-真流', '');
            } else {
                realModelName = base;
            }
        }

        // V3 Logic
        const isV3Model = realModelName.includes('gemini-3') || realModelName.includes('gemini-exp');
        let poolType: 'GLOBAL' | 'V3' = 'GLOBAL';

        if (isV3Model) {
            // Check V3 Permissions
            const isAdmin = user.role === 'ADMIN';
            const hasV3Creds = activeV3CredCount > 0;

            if (!isAdmin && !hasV3Creds && !isAdminKey) {
                return reply.code(403).send({
                    error: '🔒 此模型 (Gemini 3.0) 仅限管理员或上传了 3.0 凭证的用户使用。请先贡献 3.0 凭证！'
                });
            }
            poolType = 'V3';
        }

        try {
            // 3. Transform Request 
            const modifiedBody = { ...openAIBody, model: realModelName };
            const geminiPayload = ProxyController.transformOpenAIToGemini(modifiedBody);

            // 4. Execute
            if (isStreaming) {
                if (useFakeStream) {
                    await ProxyController.handleFakeStreamRequest(req, reply, realModelName, geminiPayload, user, isAdminKey, poolType);
                } else {
                    await ProxyController.handleStreamRequest(req, reply, realModelName, geminiPayload, user, isAdminKey, poolType);
                }
            } else {
                await ProxyController.handleStandardRequest(req, reply, realModelName, geminiPayload, user, isAdminKey, poolType);
            }

        } catch (err: any) {
            console.error('[Proxy] Error:', err);
            const errPayload = { error: { message: err.message || 'Internal Server Error', type: 'server_error' } };
            if (!reply.raw.headersSent) {
                reply.code(500).send(errPayload);
            }
        }
    }

    static async handleListModels(req: FastifyRequest, reply: FastifyReply) {
        const now = Date.now();
        if (ProxyController.modelsCache && ProxyController.modelsCache.expiresAt > now) {
            return reply.send({ object: 'list', data: ProxyController.modelsCache.data });
        }
        const models = getAvailableModels();

        const data = models.map(id => ({
            id,
            object: 'model',
            created: Math.floor(Date.now() / 1000), // Dynamic created time
            owned_by: 'google',
            permission: [],
            root: id,
            parent: null,
        }));

        ProxyController.modelsCache = { data, expiresAt: now + 5 * 60 * 1000 };
        return reply.send({ object: 'list', data });
    }

    // --- Antigravity 渠道处理 ---

    private static async handleAntigravityRequest(
        req: FastifyRequest,
        reply: FastifyReply,
        openAIBody: any,
        user: any,
        isAdminKey: boolean
    ) {
        const requestedModel = openAIBody.model;
        const isStreaming = openAIBody.stream === true;

        const realModel = extractRealModelName(requestedModel);
        const group = realModel.includes('gemini-3') ? 'gemini3' : 'claude';
        
        let claudeLimit = 100;
        let gemini3Limit = 200;
        try {
            const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_CONFIG' } });
            if (configSetting) {
                const config = JSON.parse(configSetting.value);
                claudeLimit = config.claude_limit ?? 100;
                gemini3Limit = config.gemini3_limit ?? 200;
            }
        } catch (e) {
            console.error('Failed to load ANTIGRAVITY_CONFIG', e);
        }
        
        const limit = group === 'gemini3' ? gemini3Limit : claudeLimit;
        const todayStr = new Date().toISOString().split('T')[0];
        const usageKey = `USAGE:${todayStr}:${user.id}:antigravity:${group}`;

        const strictSetting = await prisma.systemSetting.findUnique({ where: { key: 'ANTIGRAVITY_STRICT_MODE' } });
        const strictMode = strictSetting ? strictSetting.value === 'true' : false;

        if (!isAdminKey && user.role !== 'ADMIN' && strictMode) {
            const hasAccess = await antigravityTokenManager.hasAntigravityAccess(user.id);
            if (!hasAccess) {
                console.warn('[Antigravity] Strict mode enabled, user without valid credential blocked:', user.id);
                return reply.code(403).send({
                    error: {
                        message: '🔒 已开启反重力严格模式：仅上传过有效凭证的用户可以使用反重力渠道。',
                        type: 'forbidden'
                    }
                });
            }
        }

        if (!isAdminKey && strictMode) {
            const userOverride = group === 'gemini3' ? user.ag_gemini3_limit : user.ag_claude_limit;
            const effectiveLimit = (userOverride && userOverride > 0) ? userOverride : limit;

            const current = parseInt((await redis.get(usageKey)) || '0', 10);
            if (current >= effectiveLimit) {
                return reply.code(402).send({
                    error: { message: `Antigravity ${group} daily limit reached (${current}/${effectiveLimit})`, type: 'quota_exceeded' }
                });
            }
        }

        // 获取 Antigravity Token (从公共池)
        const token = await antigravityTokenManager.getToken();
        if (!token) {
            return reply.code(503).send({
                error: { message: '没有可用的反重力渠道 Token，请联系管理员添加', type: 'service_unavailable' }
            });
        }

        console.log(`[Antigravity] 处理请求: ${requestedModel} -> ${realModel}, streaming: ${isStreaming}`);

        const responseId = 'chatcmpl-' + crypto.randomUUID();
        const created = Math.floor(Date.now() / 1000);

        try {
            if (isStreaming) {
                // 流式响应
                reply.raw.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });

                let tokenUsed = false;
                let agUsageCounted = false;

                await AntigravityService.generateStreamResponse(
                    openAIBody.messages,
                    realModel,
                    openAIBody,
                    openAIBody.tools,
                    token,
                    async (data) => {
                        // 记录 Token 使用（不再计入 CLI 综合负载的 today_used）
                        if (!tokenUsed) {
                            await prisma.antigravityToken.update({
                                where: { id: token.id },
                                data: { total_used: { increment: 1 }, last_used_at: new Date() }
                            }).catch(() => { });
                            tokenUsed = true;
                        }
                        if (!agUsageCounted && (data.type === 'text' || data.type === 'thinking')) {
                            try {
                                const newCount = await redis.incr(usageKey);
                                if (newCount === 1) {
                                    const now = new Date();
                                    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
                                    const seconds = Math.floor((tomorrow.getTime() - now.getTime()) / 1000);
                                    await redis.expire(usageKey, seconds);
                                }
                                await redis.hincrby(`AG_GLOBAL:${todayStr}`, group, 1);
                                await redis.expire(`AG_GLOBAL:${todayStr}`, 86400);
                            } catch {}
                            agUsageCounted = true;
                        }

                        if (data.type === 'text' || data.type === 'thinking') {
                            const chunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created,
                                model: requestedModel,
                                choices: [{
                                    index: 0,
                                    delta: { content: data.content },
                                    finish_reason: null
                                }]
                            };
                            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        } else if (data.type === 'tool_calls') {
                            const chunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created,
                                model: requestedModel,
                                choices: [{
                                    index: 0,
                                    delta: { tool_calls: data.tool_calls },
                                    finish_reason: null
                                }]
                            };
                            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        } else if (data.type === 'usage') {
                            // 发送结束 chunk
                            const endChunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created,
                                model: requestedModel,
                                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                                usage: data.usage
                            };
                            reply.raw.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                        }
                    }
                );

                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();

            } else {
                // 非流式响应
                const { content, toolCalls, usage } = await AntigravityService.generateResponse(
                    openAIBody.messages,
                    realModel,
                    openAIBody,
                    openAIBody.tools,
                    token
                );

                // 记录 Token 使用（不计入 CLI 综合负载 today_used）
                await prisma.antigravityToken.update({
                    where: { id: token.id },
                    data: { total_used: { increment: 1 }, last_used_at: new Date() }
                }).catch(() => { });
                try {
                    const newCount = await redis.incr(usageKey);
                    if (newCount === 1) {
                        const now = new Date();
                        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
                        const seconds = Math.floor((tomorrow.getTime() - now.getTime()) / 1000);
                        await redis.expire(usageKey, seconds);
                    }
                    await redis.hincrby(`AG_GLOBAL:${todayStr}`, group, 1);
                    await redis.expire(`AG_GLOBAL:${todayStr}`, 86400);
                } catch {}

                const message: any = { role: 'assistant', content };
                if (toolCalls.length > 0) {
                    message.tool_calls = toolCalls;
                }

                return reply.send({
                    id: responseId,
                    object: 'chat.completion',
                    created,
                    model: requestedModel,
                    choices: [{
                        index: 0,
                        message,
                        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
                    }],
                    usage
                });
            }

        } catch (error: any) {
            console.error('[Antigravity] 请求失败:', error.message);

            // 处理 429 错误 (Token 冷却)
            if (error.message.includes('429')) {
                await antigravityTokenManager.markAsCooling(token.id);
            }
            if (error.message.includes('403')) {
                await antigravityTokenManager.markAsDead(token.id);
            }

            const msg = String(error.message || '');
            let status = 500;
            let type = 'api_error';
            let outMsg = msg || 'Antigravity request failed';
            const jsonStart = msg.indexOf('{');
            if (msg.includes('403')) {
                status = 403;
                type = 'permission_denied';
                if (jsonStart >= 0) {
                    try {
                        const inner = JSON.parse(msg.slice(jsonStart));
                        outMsg = inner.error?.message || outMsg;
                    } catch {}
                }
            } else if (msg.includes('404')) {
                status = 404;
                type = 'not_found';
                if (jsonStart >= 0) {
                    try {
                        const inner = JSON.parse(msg.slice(jsonStart));
                        outMsg = inner.error?.message || outMsg;
                    } catch {}
                }
            }

            if (!reply.raw.headersSent) {
                return reply.code(status).send({
                    error: { message: outMsg, type, code: status }
                });
            } else {
                const errChunk = {
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created,
                    model: requestedModel,
                    choices: [{
                        index: 0,
                        delta: { content: `\n\n[${type}: ${outMsg}]` },
                        finish_reason: 'stop'
                    }]
                };
                reply.raw.write(`data: ${JSON.stringify(errChunk)}\n\n`);
                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();
            }
        }
    }

    // --- Transformation Logic (Ported from openai_transfer.py) ---

    private static transformOpenAIToGemini(openaiRequest: any) {
        const contents: any[] = [];
        let systemInstructions: string[] = [];
        let tools: any[] = [];

        // 1. Messages Processing
        for (const msg of openaiRequest.messages) {
            if (msg.role === 'system') {
                systemInstructions.push(msg.content);
            } else if (msg.role === 'tool') {
                // Convert tool response
                contents.push({
                    role: 'user',
                    parts: [{
                        functionResponse: {
                            name: msg.name, // OpenAI requires name for tool role
                            response: typeof msg.content === 'string' ? { result: msg.content } : msg.content
                        }
                    }]
                });
            } else if (msg.role === 'user' || msg.role === 'assistant') {
                const role = msg.role === 'assistant' ? 'model' : 'user';
                const parts: any[] = [];

                // Handle Content
                if (msg.content) {
                    if (Array.isArray(msg.content)) {
                        for (const part of msg.content) {
                            if (part.type === 'text') parts.push({ text: part.text });
                            else if (part.type === 'image_url') {
                                const url = part.image_url.url;
                                if (url.startsWith('data:')) {
                                    const [meta, data] = url.split(',');
                                    const mimeType = meta.split(':')[1].split(';')[0];
                                    parts.push({ inlineData: { mimeType, data } });
                                }
                            }
                        }
                    } else {
                        parts.push({ text: msg.content });
                    }
                }

                // Handle Tool Calls (Assistant only)
                if (msg.tool_calls) {
                    for (const toolCall of msg.tool_calls) {
                        parts.push({
                            functionCall: {
                                name: toolCall.function.name,
                                args: typeof toolCall.function.arguments === 'string'
                                    ? JSON.parse(toolCall.function.arguments)
                                    : toolCall.function.arguments
                            }
                        });
                    }
                }

                if (parts.length > 0) {
                    contents.push({ role, parts });
                }
            }
        }

        // Default message if empty (Gemini requirement)
        if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
        }

        // 2. Generation Config
        const generationConfig: any = {
            topK: 64 // Default from gcli2api
        };
        if (openaiRequest.temperature != null) generationConfig.temperature = openaiRequest.temperature;
        if (openaiRequest.top_p != null) generationConfig.topP = openaiRequest.top_p;
        if (openaiRequest.max_tokens != null) generationConfig.maxOutputTokens = openaiRequest.max_tokens;
        if (openaiRequest.stop != null) generationConfig.stopSequences = Array.isArray(openaiRequest.stop) ? openaiRequest.stop : [openaiRequest.stop];

        // JSON Mode
        if (openaiRequest.response_format && openaiRequest.response_format.type === 'json_object') {
            generationConfig.responseMimeType = "application/json";
        }

        // Thinking (Heuristic based on model name or explicit config)
        if (openaiRequest.model.includes('thinking')) {
            generationConfig.thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: 1024
            };
        }

        // 3. Tools Definition
        if (openaiRequest.tools) {
            const transformedTools = transformTools(openaiRequest.tools);
            if (transformedTools.length > 0) {
                tools = transformedTools;
            }
        }

        // Google Search Tool
        if (openaiRequest.model.includes('search')) {
            // Only add if not already present (check structure)
            const hasSearch = tools.some(t => t.googleSearch);
            if (!hasSearch) {
                tools.push({ googleSearch: {} });
            }
        }

        // 4. Construct Payload
        const payload: any = {
            contents,
            generationConfig,
            safetySettings: mergeSafetySettings(openaiRequest.safety_settings || openaiRequest.safetySettings || [])
        };

        if (systemInstructions.length > 0) {
            payload.systemInstruction = { parts: [{ text: systemInstructions.join('\n\n') }] };
        }

        if (tools.length > 0) {
            payload.tools = tools;
        }

        // Tool Config (tool_choice)
        if (openaiRequest.tool_choice) {
            if (openaiRequest.tool_choice === 'auto') payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
            else if (openaiRequest.tool_choice === 'none') payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
            else if (openaiRequest.tool_choice === 'required') payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
            else if (typeof openaiRequest.tool_choice === 'object') {
                payload.toolConfig = {
                    functionCallingConfig: {
                        mode: 'ANY',
                        allowedFunctionNames: [openaiRequest.tool_choice.function.name]
                    }
                };
            }
        }

        return payload;
    }

    // --- Response Conversion Logic ---

    private static convertGeminiResponseToOpenAI(geminiResponse: any, model: string, usageMetadata?: any) {
        const choices = (geminiResponse.candidates || []).map((candidate: any) => {
            const parts = candidate.content?.parts || [];
            let content = '';
            let reasoning_content = '';
            const toolCalls: any[] = [];

            for (const part of parts) {
                if (part.functionCall) {
                    toolCalls.push({
                        id: 'call_' + crypto.randomUUID(),
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args)
                        }
                    });
                } else if (part.text) {
                    if (part.thought) reasoning_content += part.text;
                    else content += part.text;
                }
            }

            const message: any = { role: 'assistant' };
            if (content) message.content = content;
            if (reasoning_content) message.reasoning_content = reasoning_content;
            if (toolCalls.length > 0) message.tool_calls = toolCalls;

            return {
                index: candidate.index || 0,
                message,
                finish_reason: candidate.finishReason === 'STOP' ? 'stop' : 'length'
            };
        });

        let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        if (usageMetadata) {
            usage = {
                prompt_tokens: usageMetadata.promptTokenCount || 0,
                completion_tokens: usageMetadata.candidatesTokenCount || 0,
                total_tokens: usageMetadata.totalTokenCount || 0
            };
        }

        return {
            id: 'chatcmpl-' + crypto.randomUUID(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices,
            usage
        };
    }

    private static convertGeminiChunkToOpenAI(geminiChunk: any, model: string, id: string, usageMetadata?: any) {
        const choices: any[] = [];
        const candidates = geminiChunk.candidates || [];

        for (const candidate of candidates) {
            const parts = candidate.content?.parts || [];
            let finishReason = null;

            if (candidate.finishReason === 'STOP') finishReason = 'stop';
            else if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length';
            else if (candidate.finishReason) finishReason = 'stop';

            // Extract text, reasoning, tools
            let content = '';
            let reasoning = '';
            const toolCalls: any[] = [];

            for (const part of parts) {
                if (part.functionCall) {
                    toolCalls.push({
                        index: 0,
                        id: 'call_' + crypto.randomUUID(), // Stream tool calls usually need distinct IDs
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args)
                        }
                    });
                } else if (part.text) {
                    if (part.thought) reasoning += part.text;
                    else content += part.text;
                }
            }

            const delta: any = {};
            if (content) delta.content = content;
            if (reasoning) delta.reasoning_content = reasoning;
            if (toolCalls.length > 0) delta.tool_calls = toolCalls;

            choices.push({
                index: candidate.index || 0,
                delta,
                finish_reason: finishReason
            });
        }

        const chunk: any = {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices
        };

        if (usageMetadata) {
            chunk.usage = {
                prompt_tokens: usageMetadata.promptTokenCount || 0,
                completion_tokens: usageMetadata.candidatesTokenCount || 0,
                total_tokens: usageMetadata.totalTokenCount || 0
            };
        }

        return chunk;
    }

    // --- Helper: Parse Quota Reset Timestamp (Ported from utils.py) ---
    private static parseQuotaResetTimestamp(errorResponse: any): number | null {
        try {
            const error = errorResponse.error || {};
            const details = error.details || [];

            for (const detail of details) {
                if (detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo') {
                    const metadata = detail.metadata || {};
                    let resetTimestampStr = metadata.quotaResetTimeStamp;

                    if (resetTimestampStr) {
                        if (resetTimestampStr.endsWith('Z')) {
                            resetTimestampStr = resetTimestampStr.replace('Z', '+00:00');
                        }
                        const resetDate = new Date(resetTimestampStr);
                        return resetDate.getTime();
                    }
                } else if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
                    const retryDelayStr = detail.retryDelay;
                    if (retryDelayStr && retryDelayStr.endsWith('s')) {
                        const delaySeconds = parseFloat(retryDelayStr.slice(0, -1));
                        if (!isNaN(delaySeconds)) {
                            return Date.now() + (delaySeconds * 1000);
                        }
                    }
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    private static createErrorResponse(message: string, statusCode: number = 500): any {
        return { error: { message, type: 'api_error', code: statusCode } };
    }

    private static async recordSuccessfulCall(credentialId: number, modelName: string, userId: number) {
        let key = 'other';
        if (modelName.includes('gemini-2.5-flash')) key = 'gemini-2.5-flash';
        else if (modelName.includes('gemini-2.5-pro')) key = 'gemini-2.5-pro';
        else if (modelName.includes('gemini-3-pro-preview')) key = 'gemini-3-pro-preview';

        const todayStr = new Date().toISOString().split('T')[0];
        const statsKey = `USER_STATS:${userId}:${todayStr}`;

        try {
            await redis.hincrby(statsKey, key, 1);
            await redis.expire(statsKey, 172800);
        } catch (e) {}
    }

    // --- Core Request Execution (Ported from google_chat_api.py: send_gemini_request) ---
    private static async sendGeminiRequest(
        modelName: string,
        payload: any,
        isStreaming: boolean,
        credentialId: number,
        accessToken: string,
        projectId: string,
        onStreamChunk?: (chunkStr: string) => Promise<void>
    ): Promise<any> {
        const MAX_RETRIES = 5; // From gcli2api config
        const RETRY_INTERVAL = 1000; // 1 second, from gcli2api config

        const baseUrl = process.env.GOOGLE_CLOUD_CODE_URL || 'https://cloudcode-pa.googleapis.com';
        const action = isStreaming ? 'streamGenerateContent' : 'generateContent';
        let endpoint = `${baseUrl}/v1internal:${action}`;
        if (isStreaming) {
            endpoint += '?alt=sse';
        }

        const finalPayload = {
            model: modelName,
            project: projectId,
            request: payload
        };

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': getUserAgent()
        };

        for (let attempt = 0; attempt < MAX_RETRIES + 1; attempt++) {
            try {
                if (isStreaming) {
                    return await new Promise<void>((resolve, reject) => {
                        const bufferLine = { val: '' };
                        stream(endpoint, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(finalPayload),
                            opaque: { resolve, reject, onStreamChunk, bufferLine, credentialId }
                        }, ({ statusCode, body, opaque }: any) => {
                            const { resolve, reject, onStreamChunk, bufferLine, credentialId } = opaque;

                            if (statusCode !== 200) {
                                let errBody = '';
                                const errStream = new PassThrough();
                                errStream.setEncoding('utf8');
                                errStream.on('data', c => errBody += c);
                                errStream.on('end', async () => {
                                    // Simplified 429/Error handling for retries
                                    if (statusCode === 429) {
                                        try {
                                            const errJson = JSON.parse(errBody);
                                            const cooldown = ProxyController.parseQuotaResetTimestamp(errJson);
                                            if (cooldown !== null) {
                                                await poolManager.markAsCooling(credentialId, cooldown);
                                            } else {
                                                await poolManager.markAsCooling(credentialId);
                                            }
                                        } catch (e) {
                                            await poolManager.markAsCooling(credentialId);
                                        }
                                    } else if (statusCode >= 400 && statusCode < 500) {
                                        await poolManager.markAsDead(credentialId);
                                    }
                                    reject(new Error(`Upstream API Error ${statusCode}: ${errBody}`));
                                });
                                return errStream;
                            }

                            const transformer = new Transform({
                                writableObjectMode: true,
                                transform(chunk, encoding, callback) {
                                    bufferLine.val += chunk.toString();
                                    const lines = bufferLine.val.split('\n');
                                    bufferLine.val = lines.pop() || '';
                                    (async () => {
                                        for (const line of lines) {
                                            if (line.trim()) await onStreamChunk(line);
                                        }
                                        callback();
                                    })();
                                },
                                flush(callback) {
                                    if (bufferLine.val.trim()) {
                                        (async () => {
                                            await onStreamChunk(bufferLine.val);
                                            callback();
                                        })();
                                    } else {
                                        callback();
                                    }
                                }
                            });
                            transformer.on('end', () => resolve());
                            return transformer;
                        });
                    });
                } else {
                    const { request } = require('undici');
                    const { statusCode, body } = await request(endpoint, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(finalPayload)
                    });

                    if (statusCode !== 200) {
                        const errText = await body.text();
                        if (statusCode === 429) {
                            try {
                                const errJson = JSON.parse(errText);
                                const cooldown = ProxyController.parseQuotaResetTimestamp(errJson);
                                if (cooldown !== null) {
                                    await poolManager.markAsCooling(credentialId, cooldown);
                                } else {
                                    await poolManager.markAsCooling(credentialId);
                                }
                            } catch (e) {
                                await poolManager.markAsCooling(credentialId);
                            }
                        } else if (statusCode >= 400 && statusCode < 500) {
                            await poolManager.markAsDead(credentialId);
                        }
                        throw new Error(`Upstream API Error ${statusCode}: ${errText}`);
                    }

                    const rawData = await body.json() as any;
                    // Google API returns { response: { ... }, usageMetadata: { ... } }
                    // We need to merge them or just return the whole thing and handle extraction later.
                    // Let's return the whole thing to be safe and consistent with streaming logic potentially.
                    return rawData;
                }
            } catch (e: any) {
                console.warn(`[Proxy] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${e.message}`);
                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, RETRY_INTERVAL));
                } else {
                    throw e; // Max retries reached
                }
            }
        }
        throw new Error('Max retries exceeded and failed to get a response.');
    }

    // --- Strategy Handlers (Ported from openai_router.py) ---
    private static async handleStandardRequest(req: FastifyRequest, reply: FastifyReply, modelName: string, geminiPayload: any, user: any, isAdminKey: boolean, poolType: 'GLOBAL' | 'V3' = 'GLOBAL') {
        const cred = await poolManager.getRoundRobinCredential(poolType);
        if (!cred) {
            return reply.code(500).send(ProxyController.createErrorResponse('No valid credentials available', 500));
        }

        try {
            const googleResponse = await ProxyController.sendGeminiRequest(
                modelName, geminiPayload, false, cred.credentialId, cred.accessToken, cred.projectId
            );

            // Record successful call
            if (!isAdminKey) {
                await prisma.user.update({ where: { id: user.id }, data: { today_used: { increment: 1 } } }).catch(() => { });
            }
            await ProxyController.recordSuccessfulCall(cred.credentialId, modelName, user.id);

            // Extract inner response and usageMetadata
            const geminiResponse = googleResponse.response || googleResponse;
            const usageMetadata = googleResponse.usageMetadata;

            const openaiResponse = ProxyController.convertGeminiResponseToOpenAI(geminiResponse, modelName, usageMetadata);
            return reply.send(openaiResponse);
        } catch (error: any) {
            console.error('[Proxy] Standard request error:', error);
            return reply.code(500).send(ProxyController.createErrorResponse(error.message, 500));
        }
    }

    private static async handleStreamRequest(req: FastifyRequest, reply: FastifyReply, modelName: string, geminiPayload: any, user: any, isAdminKey: boolean, poolType: 'GLOBAL' | 'V3' = 'GLOBAL') {
        const cred = await poolManager.getRoundRobinCredential(poolType);
        if (!cred) {
            reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
            reply.raw.end(JSON.stringify(ProxyController.createErrorResponse('No valid credentials available', 500)));
            return;
        }

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const responseId = 'chatcmpl-' + crypto.randomUUID();
        let successRecorded = false;

        try {
            await ProxyController.sendGeminiRequest(
                modelName, geminiPayload, true, cred.credentialId, cred.accessToken, cred.projectId,
                async (chunkStr) => {
                    if (!successRecorded) {
                        if (!isAdminKey) {
                            await prisma.user.update({ where: { id: user.id }, data: { today_used: { increment: 1 } } }).catch(() => { });
                        }
                        await ProxyController.recordSuccessfulCall(cred.credentialId, modelName, user.id);
                        successRecorded = true;
                    }

                    if (chunkStr.startsWith('data: ')) {
                        const jsonStr = chunkStr.substring(6);
                        try {
                            const geminiChunk = JSON.parse(jsonStr);
                            const data = geminiChunk.response || geminiChunk; // Handle potential wrapper
                            const usageMetadata = geminiChunk.usageMetadata; // Extract usage if available

                            const openaiChunk = ProxyController.convertGeminiChunkToOpenAI(data, modelName, responseId, usageMetadata);
                            reply.raw.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                        } catch (e) {
                            console.error('Error parsing/converting stream chunk:', e);
                            // Optionally send error chunk to client
                        }
                    }
                }
            );
        } catch (error: any) {
            console.error('[Proxy] Stream request error:', error);
            const errPayload = ProxyController.createErrorResponse(error.message, 500);
            reply.raw.write(`data: ${JSON.stringify(errPayload)}\n\n`);
        } finally {
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
        }
    }

    private static async handleFakeStreamRequest(req: FastifyRequest, reply: FastifyReply, modelName: string, geminiPayload: any, user: any, isAdminKey: boolean, poolType: 'GLOBAL' | 'V3' = 'GLOBAL') {
        const cred = await poolManager.getRoundRobinCredential(poolType);
        if (!cred) {
            reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
            reply.raw.end(JSON.stringify(ProxyController.createErrorResponse('No valid credentials available', 500)));
            return;
        }

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const responseId = 'chatcmpl-' + crypto.randomUUID();
        const created = Math.floor(Date.now() / 1000);

        // Heartbeat: Keep connection alive while waiting for generation
        const heartbeatInterval = setInterval(() => {
            const heartbeat = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
            };
            reply.raw.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
        }, 2000); // Slower heartbeat to reduce noise

        try {
            const geminiResponse = await ProxyController.sendGeminiRequest(
                modelName, geminiPayload, false, cred.credentialId, cred.accessToken, cred.projectId
            );

            clearInterval(heartbeatInterval);

            if (!isAdminKey) {
                await prisma.user.update({ where: { id: user.id }, data: { today_used: { increment: 1 } } }).catch(() => { });
            }
            await ProxyController.recordSuccessfulCall(cred.credentialId, modelName, user.id);

            // Extract content (Fix: Handle .response wrapper and Safety)
            const data = geminiResponse.response || geminiResponse;
            const candidates = data.candidates || [];
            const candidate = candidates[0] || {};
            const parts = candidate.content?.parts || [];

            let content = '';
            let reasoning = '';

            for (const part of parts) {
                if (part.text) {
                    if (part.thought) reasoning += part.text;
                    else content += part.text;
                }
            }

            if (!content && !reasoning) {
                content = '';
                if (candidate.finishReason === 'SAFETY') {
                    content = '🚫 [该回复因安全策略被拦截 / Content blocked by safety filters]';
                } else if (candidate.finishReason === 'RECITATION') {
                    content = '🚫 [该回复因版权/引用原因被拦截 / Content blocked by recitation check]';
                } else if (!reasoning) {
                    content = '[No text content returned from model. Raw status: ' + (candidate.finishReason || 'UNKNOWN') + ']';
                }
            }

            // Helper: Send full content at once
            const sendFullChunk = (text: string, isReasoning: boolean) => {
                if (!text) return;

                const delta: any = {};
                if (isReasoning) delta.reasoning_content = text;
                else delta.content = text;

                const chunk = {
                    id: responseId, object: "chat.completion.chunk", created, model: modelName,
                    choices: [{ index: 0, delta, finish_reason: null }]
                };
                reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
            };

            // 1. Send Reasoning (if any)
            if (reasoning) {
                sendFullChunk(reasoning, true);
            }

            // 2. Send Content (if any)
            if (content) {
                sendFullChunk(content, false);
            }

            // End chunk
            const usageMetadata = geminiResponse.usageMetadata;
            let usage = undefined;
            if (usageMetadata) {
                usage = {
                    prompt_tokens: usageMetadata.promptTokenCount || 0,
                    completion_tokens: usageMetadata.candidatesTokenCount || 0,
                    total_tokens: usageMetadata.totalTokenCount || 0
                };
            }

            const endChunk: any = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [{ index: 0, delta: {}, finish_reason: candidate.finishReason === 'STOP' ? 'stop' : 'length' }]
            };
            if (usage) endChunk.usage = usage;

            reply.raw.write(`data: ${JSON.stringify(endChunk)}\n\n`);

        } catch (error: any) {
            clearInterval(heartbeatInterval);
            console.error('[Proxy] Fake stream request error:', error);
            const errPayload = ProxyController.createErrorResponse(error.message, 500);
            reply.raw.write(`data: ${JSON.stringify(errPayload)}\n\n`);
        } finally {
            clearInterval(heartbeatInterval);
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
        }
    }

    private static async handleAntiTruncationStream(req: FastifyRequest, reply: FastifyReply, modelName: string, geminiPayload: any, user: any, isAdminKey: boolean, poolType: 'GLOBAL' | 'V3' = 'GLOBAL') {
        // Ported from gcli2api/anti_truncation.py#apply_anti_truncation_to_stream
        // This is complex and involves recursive calls to sendGeminiRequest for "Continue" prompts.
        // For now, it will be a simplified pass-through to sendGeminiRequest with streaming.
        // Full anti-truncation logic will require more complex state management and message history.
        console.warn("Anti-truncation stream is not fully implemented yet, falling back to standard streaming.");
        await ProxyController.handleStreamRequest(req, reply, modelName, geminiPayload, user, isAdminKey, poolType);
    }
}
