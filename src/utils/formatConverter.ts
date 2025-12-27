/**
 * 多格式 API 请求/响应转换工具
 * 支持 OpenAI、Google AI Studio(Gemini)、Anthropic 三种格式的自动检测和转换
 */

// ============================================================
// 格式检测
// ============================================================

export type RequestFormat = 'openai' | 'gemini' | 'anthropic';

/**
 * 检测请求格式
 */
export function detectRequestFormat(body: any): RequestFormat {
    if (!body || typeof body !== 'object') {
        return 'openai';
    }

    // Gemini 格式特征:
    // - "contents" 数组包含 {role, parts} 对象
    // - 可能有 "systemInstruction"
    // - 可能有 "generationConfig"
    if (body.contents && Array.isArray(body.contents)) {
        return 'gemini';
    }
    if (body.systemInstruction || body.generationConfig) {
        return 'gemini';
    }

    // Anthropic 格式特征:
    // - 有 "system" 字段（字符串或数组，而非 messages[0] 的 role:system）
    // - 必须有 max_tokens（Anthropic API 必需参数）
    // - 不是从 OpenAI 格式判断，而是看独有特征
    if (body.messages && Array.isArray(body.messages)) {
        // 有 system 字段（不是 messages 里的 system role）
        if (typeof body.system === 'string' || Array.isArray(body.system)) {
            return 'anthropic';
        }
        // 检查消息内容格式（Anthropic 使用 content 数组包含 type 字段）
        const firstMsg = body.messages[0];
        if (firstMsg?.content && Array.isArray(firstMsg.content)) {
            const hasAnthropicTypes = firstMsg.content.some((c: any) =>
                c.type === 'text' || c.type === 'image' || c.type === 'tool_use' || c.type === 'tool_result'
            );
            if (hasAnthropicTypes) {
                return 'anthropic';
            }
        }
        // 默认 OpenAI - 不再仅凭模型名判断
        return 'openai';
    }

    return 'openai';
}

// ============================================================
// Gemini → OpenAI 转换
// ============================================================

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | any[];
}

export interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[];
    [key: string]: any;
}

/**
 * Gemini 格式转 OpenAI 格式
 */
export function geminiToOpenAI(geminiRequest: any, modelOverride?: string): OpenAIRequest {
    const openaiRequest: OpenAIRequest = {
        model: modelOverride || geminiRequest.model || 'gemini-2.5-pro',
        messages: []
    };

    // 转换 systemInstruction
    if (geminiRequest.systemInstruction) {
        let systemContent = '';
        if (typeof geminiRequest.systemInstruction === 'string') {
            systemContent = geminiRequest.systemInstruction;
        } else if (geminiRequest.systemInstruction.parts) {
            systemContent = geminiRequest.systemInstruction.parts
                .map((p: any) => p.text || '')
                .join('');
        }
        if (systemContent) {
            openaiRequest.messages.push({ role: 'system', content: systemContent });
        }
    }

    // 转换 contents
    const contents = geminiRequest.contents || [];
    for (const content of contents) {
        const role = content.role === 'model' ? 'assistant' : 'user';
        const parts = content.parts || [];

        if (parts.length === 1 && parts[0].text) {
            // 简单文本消息
            openaiRequest.messages.push({ role, content: parts[0].text });
        } else if (parts.length > 0) {
            // 多部分消息（可能包含图片）
            const contentParts: any[] = [];
            for (const part of parts) {
                if (part.text) {
                    contentParts.push({ type: 'text', text: part.text });
                } else if (part.inlineData) {
                    const mimeType = part.inlineData.mimeType || 'image/jpeg';
                    const data = part.inlineData.data || '';
                    contentParts.push({
                        type: 'image_url',
                        image_url: { url: `data:${mimeType};base64,${data}` }
                    });
                }
            }
            if (contentParts.length === 1 && contentParts[0].type === 'text') {
                openaiRequest.messages.push({ role, content: contentParts[0].text });
            } else if (contentParts.length > 0) {
                openaiRequest.messages.push({ role, content: contentParts });
            }
        }
    }

    // 转换 generationConfig
    if (geminiRequest.generationConfig) {
        const config = geminiRequest.generationConfig;
        if (config.temperature !== undefined) openaiRequest.temperature = config.temperature;
        if (config.topP !== undefined) openaiRequest.top_p = config.topP;
        if (config.maxOutputTokens !== undefined) openaiRequest.max_tokens = config.maxOutputTokens;
        if (config.stopSequences) openaiRequest.stop = config.stopSequences;
        if (config.candidateCount !== undefined) openaiRequest.n = config.candidateCount;
    }

    // 保留 stream 设置
    if (geminiRequest.stream !== undefined) {
        openaiRequest.stream = geminiRequest.stream;
    }

    return openaiRequest;
}

// ============================================================
// Anthropic → OpenAI 转换
// ============================================================

/**
 * Anthropic 格式转 OpenAI 格式
 */
export function anthropicToOpenAI(anthropicRequest: any): OpenAIRequest {
    const openaiRequest: OpenAIRequest = {
        model: mapAnthropicModel(anthropicRequest.model || 'claude-sonnet-4-5'),
        messages: []
    };

    // 转换 system
    if (anthropicRequest.system) {
        let systemContent = '';
        if (typeof anthropicRequest.system === 'string') {
            systemContent = anthropicRequest.system;
        } else if (Array.isArray(anthropicRequest.system)) {
            systemContent = anthropicRequest.system
                .filter((s: any) => s.type === 'text')
                .map((s: any) => s.text || '')
                .join('\n');
        }
        if (systemContent) {
            openaiRequest.messages.push({ role: 'system', content: systemContent });
        }
    }

    // 转换 messages
    const messages = anthropicRequest.messages || [];
    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';

        if (typeof msg.content === 'string') {
            openaiRequest.messages.push({ role, content: msg.content });
        } else if (Array.isArray(msg.content)) {
            const contentParts: any[] = [];
            for (const item of msg.content) {
                if (item.type === 'text') {
                    contentParts.push({ type: 'text', text: item.text || '' });
                } else if (item.type === 'image') {
                    const source = item.source || {};
                    if (source.type === 'base64') {
                        contentParts.push({
                            type: 'image_url',
                            image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data || ''}` }
                        });
                    }
                }
                // 忽略 thinking/tool_use/tool_result 等复杂类型
            }
            if (contentParts.length === 1 && contentParts[0].type === 'text') {
                openaiRequest.messages.push({ role, content: contentParts[0].text });
            } else if (contentParts.length > 0) {
                openaiRequest.messages.push({ role, content: contentParts });
            }
        }
    }

    // 转换参数
    if (anthropicRequest.max_tokens !== undefined) {
        openaiRequest.max_tokens = anthropicRequest.max_tokens;
    }
    if (anthropicRequest.temperature !== undefined) {
        openaiRequest.temperature = anthropicRequest.temperature;
    }
    if (anthropicRequest.top_p !== undefined) {
        openaiRequest.top_p = anthropicRequest.top_p;
    }
    if (anthropicRequest.stop_sequences) {
        openaiRequest.stop = anthropicRequest.stop_sequences;
    }
    if (anthropicRequest.stream !== undefined) {
        openaiRequest.stream = anthropicRequest.stream;
    }

    return openaiRequest;
}

/**
 * 映射 Anthropic 模型名到内部模型名
 */
function mapAnthropicModel(model: string): string {
    // 保持原样，让路由层处理
    return model;
}

// ============================================================
// OpenAI 响应 → Gemini 格式转换
// ============================================================

export function openaiResponseToGemini(openaiResponse: any): any {
    const candidates = [];
    const choices = openaiResponse.choices || [];

    for (const choice of choices) {
        const message = choice.message || {};
        const parts: any[] = [];

        // 处理 reasoning_content
        if (message.reasoning_content) {
            parts.push({ text: message.reasoning_content, thought: true });
        }

        // 处理 content
        if (message.content) {
            parts.push({ text: message.content });
        }

        candidates.push({
            content: {
                role: 'model',
                parts
            },
            finishReason: mapFinishReason(choice.finish_reason),
            index: choice.index || 0
        });
    }

    const geminiResponse: any = {
        candidates
    };

    // 添加使用统计
    if (openaiResponse.usage) {
        geminiResponse.usageMetadata = {
            promptTokenCount: openaiResponse.usage.prompt_tokens,
            candidatesTokenCount: openaiResponse.usage.completion_tokens,
            totalTokenCount: openaiResponse.usage.total_tokens
        };
    }

    return geminiResponse;
}

function mapFinishReason(reason: string | undefined): string {
    const mapping: Record<string, string> = {
        'stop': 'STOP',
        'length': 'MAX_TOKENS',
        'content_filter': 'SAFETY',
        'tool_calls': 'TOOL_CALL'
    };
    return mapping[reason || ''] || 'STOP';
}

// ============================================================
// OpenAI 响应 → Anthropic 格式转换
// ============================================================

export function openaiResponseToAnthropic(openaiResponse: any, model: string): any {
    const choice = openaiResponse.choices?.[0] || {};
    const message = choice.message || {};
    const content: any[] = [];

    // 处理 reasoning_content (作为 thinking block)
    if (message.reasoning_content) {
        content.push({
            type: 'thinking',
            thinking: message.reasoning_content
        });
    }

    // 处理 content
    if (message.content) {
        content.push({
            type: 'text',
            text: message.content
        });
    }

    const anthropicResponse: any = {
        id: openaiResponse.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: model,
        content,
        stop_reason: mapAnthropicStopReason(choice.finish_reason),
        stop_sequence: null
    };

    // 添加使用统计
    if (openaiResponse.usage) {
        anthropicResponse.usage = {
            input_tokens: openaiResponse.usage.prompt_tokens,
            output_tokens: openaiResponse.usage.completion_tokens
        };
    }

    return anthropicResponse;
}

function mapAnthropicStopReason(reason: string | undefined): string {
    const mapping: Record<string, string> = {
        'stop': 'end_turn',
        'length': 'max_tokens',
        'content_filter': 'stop_sequence',
        'tool_calls': 'tool_use'
    };
    return mapping[reason || ''] || 'end_turn';
}

// ============================================================
// 流式响应转换
// ============================================================

/**
 * 将 OpenAI SSE 流式数据块转换为 Gemini 格式
 */
export function openaiStreamChunkToGemini(chunk: any): string {
    const choices = chunk.choices || [];
    if (choices.length === 0) return '';

    const delta = choices[0].delta || {};
    const parts: any[] = [];

    if (delta.reasoning_content) {
        parts.push({ text: delta.reasoning_content, thought: true });
    }
    if (delta.content) {
        parts.push({ text: delta.content });
    }

    if (parts.length === 0) return '';

    const geminiChunk = {
        candidates: [{
            content: { role: 'model', parts },
            finishReason: choices[0].finish_reason ? mapFinishReason(choices[0].finish_reason) : undefined
        }]
    };

    // Gemini 流式格式使用 JSON Lines
    return JSON.stringify(geminiChunk) + '\n';
}

/**
 * 将 OpenAI SSE 流式数据块转换为 Anthropic 格式
 */
export function openaiStreamChunkToAnthropic(chunk: any, model: string, index: number): string {
    const choices = chunk.choices || [];
    if (choices.length === 0) return '';

    const delta = choices[0].delta || {};
    const events: string[] = [];

    // 第一个块发送 message_start
    if (index === 0) {
        events.push(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
                id: chunk.id || `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                model: model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        })}\n`);
    }

    // 发送 content_block_delta
    if (delta.content) {
        events.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta.content }
        })}\n`);
    }

    // 如果有 finish_reason，发送 message_stop
    if (choices[0].finish_reason) {
        events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n`);
    }

    return events.join('\n');
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 统一转换请求为 OpenAI 格式
 */
export function normalizeToOpenAI(body: any, modelOverride?: string): { format: RequestFormat; request: OpenAIRequest } {
    const format = detectRequestFormat(body);
    let request: OpenAIRequest;

    switch (format) {
        case 'gemini':
            request = geminiToOpenAI(body, modelOverride);
            break;
        case 'anthropic':
            request = anthropicToOpenAI(body);
            if (modelOverride) request.model = modelOverride;
            break;
        default:
            request = { ...body } as OpenAIRequest;
            if (modelOverride) request.model = modelOverride;
    }

    return { format, request };
}
