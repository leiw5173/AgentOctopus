import type { LoadedSkill } from '@agentoctopus/registry';

export interface LLMConfig {
  provider: 'openai' | 'gemini' | 'ollama';
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
    case 'gemini': return new GeminiChatClient(config);
    case 'ollama': return new OllamaChatClient(config);
    default: throw new Error(`Unknown chat provider: ${config.provider}`);
  }
}

export function createEmbedClient(config: LLMConfig): EmbedClient {
  switch (config.provider) {
    case 'openai': return new OpenAIEmbedClient(config);
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

export function skillToText(skill: LoadedSkill): string {
  return [
    `Name: ${skill.manifest.name}`,
    `Description: ${skill.manifest.description}`,
    `Tags: ${skill.manifest.tags.join(', ')}`,
    `Instructions: ${skill.instructions.slice(0, 300)}`,
  ].join('\n');
}
