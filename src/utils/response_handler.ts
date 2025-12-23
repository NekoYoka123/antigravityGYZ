
import { FastifyReply } from 'fastify';

export interface ResponseHandler {
    sendResponse(reply: FastifyReply, statusCode: number, body: any): Promise<void>;
    startStream(reply: FastifyReply): void;
    sendStreamChunk(reply: FastifyReply, chunk: any): Promise<void>;
    endStream(reply: FastifyReply): void;
    sendError(reply: FastifyReply, statusCode: number, error: any): Promise<void>;
}

export class OpenAIResponseHandler implements ResponseHandler {
    async sendResponse(reply: FastifyReply, statusCode: number, body: any) {
        if (!reply.raw.headersSent) {
            reply.code(statusCode).send(body);
        }
    }

    startStream(reply: FastifyReply) {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
    }

    async sendStreamChunk(reply: FastifyReply, chunk: any) {
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    endStream(reply: FastifyReply) {
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
    }


    async sendError(reply: FastifyReply, statusCode: number, error: any) {
        const msg = error.body || error.message || 'Internal Error';
        const type = statusCode === 403 ? 'permission_denied' : (statusCode === 404 ? 'not_found' : 'server_error');

        if (!reply.raw.headersSent) {
            reply.code(statusCode).send({
                error: { message: msg, type, code: statusCode }
            });
        } else {
            console.error('[ResponseHandler] Stream Error:', msg);
            reply.raw.end();
        }
    }
}

import {
    convertOpenAIToAnthropicResponse,
    convertOpenAIToAnthropicStreamEvents,
    convertOpenAIToGoogleResponse,
    convertOpenAIToGoogleStreamChunk
} from './adapters';

export class AnthropicResponseHandler implements ResponseHandler {
    async sendResponse(reply: FastifyReply, statusCode: number, body: any) {
        if (!reply.raw.headersSent) {
            const anthropicBody = convertOpenAIToAnthropicResponse(body);
            reply.code(statusCode).send(anthropicBody);
        }
    }

    startStream(reply: FastifyReply) {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
    }

    async sendStreamChunk(reply: FastifyReply, chunk: any) {
        const events = convertOpenAIToAnthropicStreamEvents(chunk);
        for (const event of events) {
            reply.raw.write(`event: ${event.type}\n`);
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
    }

    endStream(reply: FastifyReply) {
        // Anthropic stream end needs message_stop event?
        // convertOpenAIToAnthropicStreamEvents doesn't track state well enough for message_stop yet.
        // But let's send a generic message_stop if needed or just end.
        // Actually Anthropic documentation says: event: message_stop, data: {"type": "message_stop"}
        reply.raw.write(`event: message_stop\ndata: {"type": "message_stop", "amazon-bedrock-invocationMetrics": {"inputTokenCount": 0, "outputTokenCount": 0, "invocationLatency": 0, "firstByteLatency": 0}}\n\n`);
        reply.raw.end();
    }

    async sendError(reply: FastifyReply, statusCode: number, error: any) {
        if (!reply.raw.headersSent) {
            const msg = error.body || error.message || 'Error';
            const type = statusCode === 429 ? 'rate_limit_error' : (statusCode === 401 ? 'authentication_error' : 'api_error');
            reply.code(statusCode).send({
                type: 'error',
                error: { type, message: msg }
            });
        } else {
            reply.raw.end();
        }
    }
}

export class GoogleResponseHandler implements ResponseHandler {
    async sendResponse(reply: FastifyReply, statusCode: number, body: any) {
        if (!reply.raw.headersSent) {
            const googleBody = convertOpenAIToGoogleResponse(body);
            reply.code(statusCode).send(googleBody);
        }
    }

    startStream(reply: FastifyReply) {
        reply.raw.writeHead(200, {
            // Google AI Studio uses SSE usually.
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
    }

    async sendStreamChunk(reply: FastifyReply, chunk: any) {
        const googleChunk = convertOpenAIToGoogleStreamChunk(chunk);
        if (googleChunk) {
            reply.raw.write(`data: ${JSON.stringify(googleChunk)}\n\n`);
        }
    }

    endStream(reply: FastifyReply) {
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
    }

    async sendError(reply: FastifyReply, statusCode: number, error: any) {
        const msg = error.body || error.message || 'Error';
        if (!reply.raw.headersSent) {
            reply.code(statusCode).send({
                error: { message: msg, code: statusCode, status: 'INTERNAL' }
            });
        } else {
            reply.raw.end();
        }
    }
}

