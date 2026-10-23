// Asks Claude (Anthropic API) for a review and streams its answer. The API
// key is the one an admin saved on the Access page or, while there is none,
// ANTHROPIC_API_KEY. The SDK is loaded only when it is first needed, so the
// server runs without it.

export const DEFAULT_MODEL = 'claude-opus-5-5';

async function sdkClient (apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

/**
 * The message of an Anthropic API error, without the status and JSON around
 * it: the SDK's error.message is "<status> <JSON body>" when the body is not
 * the usual { error: { message } }.
 */
export function apiErrorMessage (err) {
  const body = err?.error;
  const message = body?.error?.message ?? body?.message;
  if (typeof message === 'string' && message) return message;
  return String(err?.message ?? err).replace(/^\d{3} /, '');
}

/** A readable message for an error of the Anthropic API when checking a key. */
function keyError (err, model) {
  if (err.status === 401) return 'Anthropic did not accept this API key';
  if (err.status === 403) return `This API key may not use ${model}`;
  if (err.status === 404) return `Anthropic does not know the model ${model}`;
  if (err.code === 'ERR_MODULE_NOT_FOUND') return 'The Anthropic SDK is not installed on the server: run npm install';
  return `Could not check the key with Anthropic: ${apiErrorMessage(err)}`;
}

export class ClaudeReviewer {
  /**
   * @param env { apiKey, model } from ANTHROPIC_API_KEY / ANALYSIS_MODEL
   * @param createClient (apiKey) => Anthropic client; tests replace it
   */
  constructor (pool, env = {}, { createClient = sdkClient } = {}) {
    this.pool = pool;
    this.envKey = env.apiKey || '';
    this.model = env.model || DEFAULT_MODEL;
    this.createClient = createClient;
    this.setting = null; // { apiKey, source: 'settings' | 'environment', updatedAt, updatedBy }
    this.client = null;
  }

  get available () {
    return Boolean(this.setting?.apiKey);
  }

  async load () {
    const { rows: [r] } = await this.pool.query('SELECT * FROM anthropic_config');
    this.setting = r
      ? { apiKey: r.api_key, source: 'settings', updatedAt: r.updated_at, updatedBy: r.updated_by }
      : this.envKey ? { apiKey: this.envKey, source: 'environment' } : null;
    this.client = null;
  }

  /** Checks the key with Anthropic (a free model lookup), then saves it; throws a readable error if it does not work. */
  async configure (apiKey, by) {
    apiKey = String(apiKey || '').trim();
    if (!apiKey) throw new Error('Enter an Anthropic API key');
    try {
      const client = await this.createClient(apiKey);
      await client.models.retrieve(this.model);
    } catch (err) {
      throw new Error(keyError(err, this.model));
    }
    await this.pool.query(
      `INSERT INTO anthropic_config (id, api_key, updated_by) VALUES (true, $1, $2)
       ON CONFLICT (id) DO UPDATE SET api_key = EXCLUDED.api_key, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [apiKey, by || null]);
    await this.load();
  }

  /** Forgets the saved key (ANTHROPIC_API_KEY applies again, if set). */
  async remove () {
    await this.pool.query('DELETE FROM anthropic_config');
    await this.load();
  }

  /** The setting, for admins: never the key, only its last characters. */
  view () {
    const s = this.setting;
    return {
      keySet: this.available,
      keyEnd: s ? s.apiKey.slice(-4) : null,
      source: s?.source ?? null,
      model: this.model,
      updatedAt: s?.updatedAt ?? null,
      updatedBy: s?.updatedBy ?? null,
    };
  }

  /**
   * Streams the answer to the last of `messages` ([{ role, content }], the
   * first holding the records) to onText; resolves to { text, stopReason,
   * model, usage }.
   */
  async review ({ system, messages, onText, signal }) {
    if (!this.available) throw new Error('No Anthropic API key is set');
    if (!this.client) this.client = await this.createClient(this.setting.apiKey);
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      // A declined request is retried on Anthropic's recommended model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // The guide is the same for every review: cache it.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      // The first message holds the records: cache it for follow-up questions.
      messages: messages.map((m, i) => (i === 0
        ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral', ttl: '1h' } }] }
        : m)),
    }, { signal });
    stream.on('text', (delta) => onText(delta));
    const message = await stream.finalMessage();
    return {
      text: message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      stopReason: message.stop_reason,
      model: message.model,
      usage: message.usage,
    };
  }
}
