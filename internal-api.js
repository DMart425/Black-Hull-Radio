const express = require('express');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

function jsonError(res, status, error, code) {
  const body = { ok: false, error };
  if (code) body.code = code;
  return res.status(status).json(body);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildMediaEmbed(media) {
  const title = clean(media?.title) || 'Untitled Media';
  const caption = clean(media?.caption);
  const opName = clean(media?.opName);
  const submittedBy = clean(media?.submittedBy);
  const siteUrl = clean(media?.siteUrl);
  const logoUrl = clean(media?.logoUrl);
  const imageUrl = clean(media?.imageUrl);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setFooter({ text: 'Black Hull Syndicate Media' })
    .setTimestamp(new Date());

  if (siteUrl) embed.setURL(siteUrl);
  if (caption) embed.setDescription(caption);

  const fields = [];
  if (opName) fields.push({ name: 'Operation', value: opName, inline: true });
  if (submittedBy) fields.push({ name: 'Submitted by', value: submittedBy, inline: true });
  if (fields.length) embed.addFields(fields);

  if (logoUrl) {
    embed.setThumbnail(logoUrl);
    embed.setAuthor({ name: 'Black Hull Syndicate', iconURL: logoUrl });
  } else {
    embed.setAuthor({ name: 'Black Hull Syndicate' });
  }

  if (imageUrl) embed.setImage(imageUrl);

  return embed;
}

function buildComponents(media) {
  const siteUrl = clean(media?.siteUrl);
  if (!siteUrl) return [];

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('View on Site')
        .setStyle(ButtonStyle.Link)
        .setURL(siteUrl)
    ),
  ];
}

async function fetchTargetChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error('Target channel was not found.');
  if (!channel.isTextBased()) throw new Error('Target channel is not text-based.');
  return channel;
}

function buildCustomEmbed(embedData) {
  const e = new EmbedBuilder();
  if (embedData.title)       e.setTitle(String(embedData.title).slice(0, 256));
  if (embedData.titleUrl)    e.setURL(embedData.titleUrl);
  if (embedData.description) e.setDescription(String(embedData.description).slice(0, 4096));
  if (typeof embedData.color === 'number') e.setColor(embedData.color);
  if (embedData.authorName) {
    const author = { name: String(embedData.authorName) };
    if (embedData.authorIconUrl) author.iconURL = embedData.authorIconUrl;
    if (embedData.authorUrl)     author.url     = embedData.authorUrl;
    e.setAuthor(author);
  }
  if (embedData.thumbnailUrl) e.setThumbnail(embedData.thumbnailUrl);
  if (embedData.imageUrl)     e.setImage(embedData.imageUrl);
  if (embedData.footerText) {
    const footer = { text: String(embedData.footerText) };
    if (embedData.footerIconUrl) footer.iconURL = embedData.footerIconUrl;
    e.setFooter(footer);
  }
  if (embedData.includeTimestamp) e.setTimestamp();
  if (Array.isArray(embedData.fields) && embedData.fields.length > 0) {
    e.addFields(
      embedData.fields.slice(0, 25).map((f) => ({
        name:   String(f.name  || '').slice(0, 256)  || '\u200b',
        value:  String(f.value || '').slice(0, 1024) || '\u200b',
        inline: Boolean(f.inline),
      }))
    );
  }
  return e;
}

async function handleApprovedEvent({ client, body }) {
  const media = body.media || {};
  const channelId = clean(body.channelId);
  const threadName = clean(body.threadName) || `Discussion: ${clean(media.title) || 'Media'}`;
  const createThread = Boolean(body.createThread);

  const channel = await fetchTargetChannel(client, channelId);
  const embed = buildMediaEmbed(media);
  const components = buildComponents(media);

  const sent = await channel.send({
    content: '**New approved media hit the board.**',
    embeds: [embed],
    components,
    allowedMentions: { parse: [] },
  });

  let threadId = null;

  if (createThread && typeof sent.startThread === 'function') {
    try {
      const thread = await sent.startThread({
        name: threadName.slice(0, 100),
        autoArchiveDuration: 1440,
      });
      threadId = thread?.id ?? null;
    } catch (error) {
      console.warn('[internal-api] thread creation failed:', error?.message || error);
    }
  }

  return {
    ok: true,
    messageId: sent.id,
    threadId,
    channelId: sent.channelId,
    postedAt: new Date().toISOString(),
  };
}

async function handleUpdatedEvent({ client, body }) {
  const media = body.media || {};
  const channelId = clean(body.channelId) || clean(body.discordSync?.channelId);
  const messageId = clean(body.discordSync?.messageId);

  if (!channelId || !messageId) {
    throw new Error('media.updated requires discordSync.channelId and discordSync.messageId.');
  }

  const channel = await fetchTargetChannel(client, channelId);
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) {
    throw new Error('Existing Discord media post was not found for media.updated.');
  }

  const embed = buildMediaEmbed(media);
  const components = buildComponents(media);

  await message.edit({
    content: '**Approved media updated on the board.**',
    embeds: [embed],
    components,
    allowedMentions: { parse: [] },
  });

  return {
    ok: true,
    messageId: message.id,
    threadId: clean(body.discordSync?.threadId) || null,
    channelId: message.channelId,
    postedAt: new Date().toISOString(),
  };
}

async function safelyDeleteThread(client, threadId) {
  if (!threadId) return;
  try {
    const thread = await client.channels.fetch(threadId);
    if (thread && typeof thread.delete === 'function') {
      await thread.delete('Media removed from site');
    }
  } catch {}
}

async function handleRemovedEvent({ client, body }) {
  const channelId = clean(body.channelId) || clean(body.discordSync?.channelId);
  const messageId = clean(body.discordSync?.messageId);
  const threadId = clean(body.discordSync?.threadId);

  if (!channelId || !messageId) {
    return {
      ok: true,
      removed: true,
      messageId: messageId || null,
      threadId: threadId || null,
      channelId: channelId || null,
      postedAt: new Date().toISOString(),
    };
  }

  try {
    const channel = await fetchTargetChannel(client, channelId);
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) await message.delete().catch(() => null);
    await safelyDeleteThread(client, threadId);
  } catch (error) {
    console.warn('[internal-api] media removal cleanup warning:', error?.message || error);
  }

  return {
    ok: true,
    removed: true,
    messageId: messageId || null,
    threadId: threadId || null,
    channelId: channelId || null,
    postedAt: new Date().toISOString(),
  };
}

function validateBody(body) {
  const media = body.media || {};
  const eventType = clean(body.eventType);

  if (body.version !== 1) return 'Invalid version';
  if (!eventType) return 'Missing eventType';
  if (!['media.approved', 'media.removed', 'media.updated'].includes(eventType)) {
    return 'Unsupported eventType';
  }
  if (!clean(body.eventId)) return 'Missing eventId';
  if (!clean(body.channelId) && !clean(body.discordSync?.channelId)) return 'Missing channelId';
  if (!clean(media.id)) return 'Missing media.id';
  if ((eventType === 'media.approved' || eventType === 'media.updated') && !clean(media.title)) return 'Missing media.title';
  if (eventType === 'media.updated' && !clean(body.discordSync?.messageId)) return 'Missing discordSync.messageId';
  return null;
}

function validateSystemActionBody(body) {
  const action = clean(body?.action);
  if (!action) return 'Missing action';
  if (!['system_heartbeat', 'ops_reminders_poll'].includes(action)) return 'Unsupported action';
  return null;
}

function startInternalApi({ port, client, handlers = {} }) {
  const app = express();
  const sharedSecret = process.env.MEDIA_SYNC_SHARED_SECRET || '';

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'black-hull-broadcast',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/internal/media-events', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const expected = `Bearer ${sharedSecret}`;

      if (!sharedSecret) {
        return jsonError(res, 500, 'MEDIA_SYNC_SHARED_SECRET is not configured', 'SECRET_MISSING');
      }

      if (auth !== expected) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }

      if (!client?.isReady?.()) {
        return jsonError(res, 503, 'Discord client is not ready', 'CLIENT_NOT_READY');
      }

      const body = req.body || {};
      const error = validateBody(body);
      if (error) {
        return jsonError(res, 400, error, 'BAD_REQUEST');
      }

      const eventType = clean(body.eventType);

      if (eventType === 'media.approved') {
        const result = await handleApprovedEvent({ client, body });
        return res.status(200).json(result);
      }

      if (eventType === 'media.updated') {
        const result = await handleUpdatedEvent({ client, body });
        return res.status(200).json(result);
      }

      if (eventType === 'media.removed') {
        const result = await handleRemovedEvent({ client, body });
        return res.status(200).json(result);
      }

      return jsonError(res, 400, 'Unsupported eventType', 'BAD_EVENT_TYPE');
    } catch (error) {
      console.error('[internal-api] media event failure:', error);
      return jsonError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  });


  app.post('/internal/system-actions', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const expected = `Bearer ${sharedSecret}`;

      if (!sharedSecret) {
        return jsonError(res, 500, 'MEDIA_SYNC_SHARED_SECRET is not configured', 'SECRET_MISSING');
      }

      if (auth !== expected) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }

      if (!client?.isReady?.()) {
        return jsonError(res, 503, 'Discord client is not ready', 'CLIENT_NOT_READY');
      }

      const body = req.body || {};
      const error = validateSystemActionBody(body);
      if (error) {
        return jsonError(res, 400, error, 'BAD_REQUEST');
      }

      const action = clean(body.action);

      if (action === 'system_heartbeat') {
        if (typeof handlers.runSystemHeartbeat !== 'function') {
          return jsonError(res, 501, 'System heartbeat handler is not available', 'HANDLER_MISSING');
        }

        const result = await handlers.runSystemHeartbeat();
        return res.status(200).json({ ok: true, action, ...result });
      }

      if (action === 'ops_reminders_poll') {
        if (typeof handlers.runOpsReminderPoll !== 'function') {
          return jsonError(res, 501, 'Ops reminder poll handler is not available', 'HANDLER_MISSING');
        }

        const result = await handlers.runOpsReminderPoll();
        return res.status(200).json({ ok: true, action, ...result });
      }

      return jsonError(res, 400, 'Unsupported action', 'BAD_ACTION');
    } catch (error) {
      console.error('[internal-api] system action failure:', error);
      return jsonError(res, 500, error?.message || 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  // ── Party key management (chief dashboard) ──────────────────────────────
  app.get('/internal/party-keys', (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!sharedSecret || auth !== `Bearer ${sharedSecret}`) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }

      if (typeof handlers.listPartyKeys !== 'function') {
        return jsonError(res, 501, 'Party key handler not available', 'HANDLER_MISSING');
      }

      const keys = handlers.listPartyKeys();
      return res.json({ ok: true, keys });
    } catch (error) {
      console.error('[internal-api] party-keys list failure:', error);
      return jsonError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  app.post('/internal/party-keys', (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!sharedSecret || auth !== `Bearer ${sharedSecret}`) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }

      const userId = clean((req.body || {}).userId);
      if (!userId) return jsonError(res, 400, 'Missing userId', 'BAD_REQUEST');

      if (typeof handlers.generatePartyKey !== 'function') {
        return jsonError(res, 501, 'Party key handler not available', 'HANDLER_MISSING');
      }

      const key = handlers.generatePartyKey(userId);

      // DM the member their key (best-effort — don't fail the request if DMs are closed)
      if (client) {
        client.users.fetch(userId).then((user) => user.send(
          `**Black Hull SnareHound — Party API Key**\n` +
          `Your personal key has been generated (or replaced) by a Chief via the dashboard.\n\n` +
          `\`\`\`\n${key}\n\`\`\`\n` +
          `Enter this in the SnareHound Party System settings along with the bot URL.\n` +
          `Keep this private — do not share it.`
        )).catch((dmErr) => {
          console.warn('[internal-api] party-key DM failed for', userId, dmErr.message);
        });
      }

      return res.json({ ok: true, key });
    } catch (error) {
      console.error('[internal-api] party-keys generate failure:', error);
      return jsonError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  app.delete('/internal/party-keys/:userId', (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!sharedSecret || auth !== `Bearer ${sharedSecret}`) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }

      const userId = clean(req.params.userId);
      if (!userId) return jsonError(res, 400, 'Missing userId', 'BAD_REQUEST');

      if (typeof handlers.revokePartyKey !== 'function') {
        return jsonError(res, 501, 'Party key handler not available', 'HANDLER_MISSING');
      }

      const revoked = handlers.revokePartyKey(userId);
      return res.json({ ok: true, revoked });
    } catch (error) {
      console.error('[internal-api] party-keys revoke failure:', error);
      return jsonError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  // ── Discord channel listing ───────────────────────────────────────────────
  app.get('/internal/channels', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!sharedSecret || auth !== `Bearer ${sharedSecret}`) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }
      if (!client?.isReady?.()) {
        return jsonError(res, 503, 'Discord client is not ready', 'CLIENT_NOT_READY');
      }
      const guildId = process.env.GUILD_ID;
      if (!guildId) return jsonError(res, 500, 'GUILD_ID not configured', 'CONFIG_ERROR');
      const guild = await client.guilds.fetch(guildId);
      await guild.channels.fetch();
      const channels = guild.channels.cache
        .filter((c) => c.isTextBased() && !c.isThread())
        .map((c) => ({ id: c.id, name: c.name, parentName: c.parent?.name ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.json({ ok: true, channels });
    } catch (error) {
      console.error('[internal-api] channels list failure:', error);
      return jsonError(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  // ── Embed Discord operations ──────────────────────────────────────────────
  app.post('/internal/embeds/send', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!sharedSecret || auth !== `Bearer ${sharedSecret}`) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }
      if (!client?.isReady?.()) {
        return jsonError(res, 503, 'Discord client is not ready', 'CLIENT_NOT_READY');
      }
      const body = req.body || {};
      const channelId = clean(body.channelId);
      if (!channelId) return jsonError(res, 400, 'Missing channelId', 'BAD_REQUEST');
      if (!body.embed || typeof body.embed !== 'object') {
        return jsonError(res, 400, 'Missing embed payload', 'BAD_REQUEST');
      }
      const channel = await fetchTargetChannel(client, channelId);
      const embed = buildCustomEmbed(body.embed);
      const message = await channel.send({ embeds: [embed] });
      return res.json({ ok: true, channelId: channel.id, messageId: message.id });
    } catch (error) {
      console.error('[internal-api] embed send failure:', error);
      return jsonError(res, 500, error.message || 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  app.patch('/internal/embeds/send', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!sharedSecret || auth !== `Bearer ${sharedSecret}`) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }
      if (!client?.isReady?.()) {
        return jsonError(res, 503, 'Discord client is not ready', 'CLIENT_NOT_READY');
      }
      const body = req.body || {};
      const channelId = clean(body.channelId);
      const messageId = clean(body.messageId);
      if (!channelId || !messageId) return jsonError(res, 400, 'Missing channelId or messageId', 'BAD_REQUEST');
      if (!body.embed || typeof body.embed !== 'object') {
        return jsonError(res, 400, 'Missing embed payload', 'BAD_REQUEST');
      }
      const channel = await fetchTargetChannel(client, channelId);
      const message = await channel.messages.fetch(messageId);
      const embed = buildCustomEmbed(body.embed);
      await message.edit({ embeds: [embed] });
      return res.json({ ok: true, channelId, messageId });
    } catch (error) {
      console.error('[internal-api] embed edit failure:', error);
      if (error.code === 10008) {
        return jsonError(res, 404, 'Discord message not found — it may have been deleted', 'MESSAGE_NOT_FOUND');
      }
      return jsonError(res, 500, error.message || 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  app.delete('/internal/embeds/send', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      if (!sharedSecret || auth !== `Bearer ${sharedSecret}`) {
        return jsonError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
      }
      if (!client?.isReady?.()) {
        return jsonError(res, 503, 'Discord client is not ready', 'CLIENT_NOT_READY');
      }
      const body = req.body || {};
      const channelId = clean(body.channelId);
      const messageId = clean(body.messageId);
      if (!channelId || !messageId) return jsonError(res, 400, 'Missing channelId or messageId', 'BAD_REQUEST');
      const channel = await fetchTargetChannel(client, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (message) await message.delete();
      return res.json({ ok: true });
    } catch (error) {
      console.error('[internal-api] embed delete failure:', error);
      if (error.code === 10008) return res.json({ ok: true, note: 'Message already deleted' });
      return jsonError(res, 500, error.message || 'Internal server error', 'INTERNAL_ERROR');
    }
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`[internal-api] listening on port ${port}`);
  });
}

module.exports = { startInternalApi };
