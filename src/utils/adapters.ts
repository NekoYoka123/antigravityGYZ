
import { randomUUID } from 'crypto';

// --- Anthropic Adapters ---

export function convertAnthropicToOpenAI(body: any): any {
    const messages = [];
    if (body.system) {
        messages.push({ role: 'system', content: body.system });
    }
    if (Array.isArray(body.messages)) {
        messages.push(...body.messages);
    }

    return {
        model: body.model,
        messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens, // Anthropic matches OpenAI key roughly
        stream: body.stream,
        stop: body.stop_sequences,
        top_p: body.top_p,
        top_k: body.top_k, // OpenAI doesn't officially support top_k via API usually, but we pass it through
        tools: body.tools, // Recent Anthropic supports tools, structure is similar but might need deeper transformation if strictly enforcing schemas
        tool_choice: body.tool_choice
    };
}

export function convertOpenAIToAnthropicResponse(openaiResp: any): any {
    const choice = openaiResp.choices[0];
    const message = choice.message;

    // Construct content array
    const content = [];
    if (message.content) {
        content.push({ type: 'text', text: message.content });
    }
    // Handle tools if any (Anthropic expects tools in content or separate tool_use blocks)
    // For simplicity, we map standard text. Tool mapping needs more complex logic if tool_calls exist.
    if (message.tool_calls) {
        for (const tc of message.tool_calls) {
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments || '{}')
            });
        }
    }

    return {
        id: openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: mapFinishReasonToAnthropic(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0
        }
    };
}

export function convertOpenAIToAnthropicStreamEvents(openaiChunk: any): any[] {
    const events = [];
    const choice = openaiChunk.choices[0];
    const delta = choice.delta;

    // Basic mapping for text deltas
    // Note: A real implementation would need state tracking to emit 'message_start' only once, etc.
    // However, for a simple adapter, we might just emit 'content_block_delta'.
    // The Controller calling this will handle the lifecycle events (message_start, message_stop).

    if (delta.content) {
        events.push({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta.content }
        });
    }

    // Reasoning content handling (Antigravity specific) - map to text for Anthropic or custom block?
    // User requested "compatibility", usually standard clients don't see reasoning.
    // We will append it to text or ignore it? 
    // Let's assume we treat it as text for now to be visible, or ignore if clients crash.
    // Standard Anthropic doesn't have reasoning field yet.
    // Let's prepend or append? Or just send as text delta.
    if (delta.reasoning_content) {
        events.push({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `\n<thinking>\n${delta.reasoning_content}\n</thinking>\n` }
        });
    }

    return events;
}

function mapFinishReasonToAnthropic(reason: string | null): string | null {
    if (reason === 'stop') return 'end_turn';
    if (reason === 'length') return 'max_tokens';
    if (reason === 'tool_calls') return 'tool_use';
    return null;
}


// --- Google Adapters ---

export function convertGoogleToOpenAI(body: any, modelParam: string): any {
    // google: { contents: [{ role: 'user', parts: [{ text: '...' }] }], generationConfig: { ... } }
    const messages = [];
    if (Array.isArray(body.contents)) {
        for (const c of body.contents) {
            const role = c.role === 'model' ? 'assistant' : (c.role === 'user' ? 'user' : 'user');
            let content = '';
            // Aggregate text parts
            if (c.parts) {
                for (const p of c.parts) {
                    if (p.text) content += p.text;
                }
            }
            messages.push({ role, content });

            // TODO: Handle system instructions if passed in 'system_instruction' field (Google specific)
        }
    }

    if (body.system_instruction) {
        let sysContent = '';
        if (body.system_instruction.parts) {
            for (const p of body.system_instruction.parts) {
                if (p.text) sysContent += p.text;
            }
        }
        if (sysContent) {
            messages.unshift({ role: 'system', content: sysContent });
        }
    }

    const config = body.generationConfig || {};

    return {
        model: modelParam,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        top_p: config.topP,
        top_k: config.topK,
        stop: config.stopSequences,
        stream: false // overridden by controller method usually
    };
}

export function convertOpenAIToGoogleResponse(openaiResp: any): any {
    const choice = openaiResp.choices[0];
    const message = choice.message;

    return {
        candidates: [{
            content: {
                role: 'model',
                parts: [{ text: message.content || '' }]
            },
            finishReason: mapFinishReasonToGoogle(choice.finish_reason),
            index: 0
        }],
        usageMetadata: {
            promptTokenCount: openaiResp.usage?.prompt_tokens,
            candidatesTokenCount: openaiResp.usage?.completion_tokens,
            totalTokenCount: openaiResp.usage?.total_tokens
        }
    };
}

export function convertOpenAIToGoogleStreamChunk(openaiChunk: any): any {
    const choice = openaiChunk.choices[0];
    const delta = choice.delta;

    if (!delta.content && !delta.reasoning_content) return null; // No content update

    let text = delta.content || '';
    if (delta.reasoning_content) {
        text = `\n[Thinking: ${delta.reasoning_content}]\n` + text; // crude visualization
    }

    return {
        candidates: [{
            content: {
                role: 'model',
                parts: [{ text }]
            },
            finishReason: null, // Stream chunks usually don't have finish reason until end
            index: 0
        }]
    };
}

function mapFinishReasonToGoogle(reason: string | null): string {
    if (reason === 'stop') return 'STOP';
    if (reason === 'length') return 'MAX_TOKENS';
    if (reason === 'tool_calls') return 'STOP'; // Google uses function call status usually, but STOP is safe default
    return 'STOP';
}
