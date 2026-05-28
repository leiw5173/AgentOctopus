import { type LoadedSkill, getRequiredEnvVars } from '@agentoctopus/registry';

export interface LLMConfig {
  provider: 'openai' | 'gemini' | 'ollama' | 'anthropic';
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface EmbedClient {
  embed(text: string): Promise<number[]>;
}

export interface ChatClient {
  chat(systemPrompt: string, userMessage: string): Promise<string>;
}

export function createChatClient(config: LLMConfig): ChatClient {
  switch (config.provider) {
    case 'openai': return new OpenAIChatClient(config);
    case 'anthropic': return new AnthropicChatClient(config);
    case 'gemini': return new GeminiChatClient(config);
    case 'ollama': return new OllamaChatClient(config);
    default: throw new Error(`Unknown chat provider: ${config.provider}`);
  }
}

export function createEmbedClient(config: LLMConfig): EmbedClient {
  switch (config.provider) {
    case 'openai': return new OpenAIEmbedClient(config);
    case 'anthropic': return new AnthropicEmbedClient(config);
    case 'gemini': return new GeminiEmbedClient(config);
    case 'ollama': return new OllamaEmbedClient(config);
    default: throw new Error(`Unknown embed provider: ${config.provider}`);
  }
}

class OpenAIChatClient implements ChatClient {
  constructor(private config: LLMConfig) {}
  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    const { OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl });
    const response = await client.chat.completions.create({
      model: this.config.model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
    });
    return response.choices[0]?.message?.content ?? '';
  }
}

class OpenAIEmbedClient implements EmbedClient {
  constructor(private config: LLMConfig) {}
  async embed(text: string): Promise<number[]> {
    const { OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.config.apiKey, baseURL: this.config.baseUrl });
    const response = await client.embeddings.create({
      model: this.config.model || 'text-embedding-3-small',
      input: text,
    });
    return response.data[0]?.embedding ?? [];
  }
}

class GeminiChatClient implements ChatClient {
  constructor(private config: LLMConfig) {}
  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genai = new GoogleGenerativeAI(this.config.apiKey ?? '');
    const model = genai.getGenerativeModel({ model: this.config.model });
    const result = await model.generateContent(`${systemPrompt}\n\n${userMessage}`);
    return result.response.text();
  }
}

class GeminiEmbedClient implements EmbedClient {
  constructor(private config: LLMConfig) {}
  async embed(text: string): Promise<number[]> {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genai = new GoogleGenerativeAI(this.config.apiKey ?? '');
    const model = genai.getGenerativeModel({ model: this.config.model || 'text-embedding-004' });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }
}

class OllamaChatClient implements ChatClient {
  constructor(private config: LLMConfig) {}
  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    const { Ollama } = await import('ollama');
    const client = new Ollama({ host: this.config.baseUrl });
    const response = await client.chat({
      model: this.config.model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
    });
    return response.message.content;
  }
}

class OllamaEmbedClient implements EmbedClient {
  constructor(private config: LLMConfig) {}
  async embed(text: string): Promise<number[]> {
    const { Ollama } = await import('ollama');
    const client = new Ollama({ host: this.config.baseUrl });
    const response = await client.embeddings({ model: this.config.model, prompt: text });
    return response.embedding;
  }
}

class AnthropicChatClient implements ChatClient {
  constructor(private config: LLMConfig) {}
  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    // Use fetch to avoid dependency on @anthropic-ai/sdk
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const content = data.content?.[0];
    return content && content.type === 'text' ? content.text ?? '' : '';
  }
}

class AnthropicEmbedClient implements EmbedClient {
  constructor(private config: LLMConfig) {}
  async embed(text: string): Promise<number[]> {
    // Anthropic doesn't have a native embeddings API, use OpenAI-compatible endpoint
    const response = await fetch(`${this.config.baseUrl ?? 'https://api.openai.com/v1'}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model: this.config.model || 'text-embedding-3-small',
        input: text,
      }),
    });
    const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    return data.data?.[0]?.embedding ?? [];
  }
}

export function skillToText(skill: LoadedSkill): string {
  const parts = [
    `Name: ${skill.manifest.name}`,
    `Description: ${skill.manifest.description}`,
    `Tags: ${Array.isArray(skill.manifest.tags) ? skill.manifest.tags.join(', ') : ''}`,
    `Adapter: ${skill.manifest.adapter}`,
  ];
  if (skill.manifest.endpoint) {
    parts.push(`Endpoint: ${skill.manifest.endpoint}`);
  }
  if (skill.manifest.auth && skill.manifest.auth !== 'none') {
    parts.push(`Auth: ${skill.manifest.auth}`);
  }
  // Include credential labels — they describe what the skill connects to
  const envVars = getRequiredEnvVars(skill.manifest);
  if (envVars.length > 0) {
    parts.push(`Credentials: ${envVars.map(e => e.label || e.key).join(', ')}`);
  }
  return parts.join('\n');
}
