require('dotenv').config();
const { startInternalApi } = require('./internal-api');
const { startPartyApi, generateKeyForUser, revokeKeyForUser, revokeAllKeys, listKeys } = require('./party-api');
const activityTracker = require('./activity-tracker');

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
} = require('@discordjs/voice');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const commandChannelId = process.env.COMMAND_CHANNEL_ID || '1487965611685314700';
const adminCommandChannelId = process.env.ADMIN_COMMAND_CHANNEL_ID || '1490421177213260036';
const audioDir = path.resolve(process.env.AUDIO_DIR || './audio');
const volume = Number(process.env.VOLUME || '0.15');
const mediaSyncPort = Number(process.env.MEDIA_SYNC_PORT || '3001');
const rsiNewsChannelId = process.env.RSI_NEWS_CHANNEL_ID || '1368817161971171389';
const rsiCommLinkFeedUrl = (process.env.RSI_COMM_LINK_FEED_URL || 'https://robertsspaceindustries.com/en/comm-link/rss').trim();
const rsiNewsPollMinutes = Math.max(2, Number(process.env.RSI_NEWS_POLL_MINUTES || '10'));
const rsiStatusChannelId = process.env.RSI_STATUS_CHANNEL_ID || '1490468151614374032';
const rsiStatusFeedUrl = (process.env.RSI_STATUS_FEED_URL || 'https://status.robertsspaceindustries.com/index.xml').trim();
const rsiStatusPollMinutes = Math.max(2, Number(process.env.RSI_STATUS_POLL_MINUTES || '10'));
const rsiPatchNotesChannelId = process.env.RSI_PATCH_NOTES_CHANNEL_ID || '1490469269211840653';
const rsiPatchNotesHubUrl = (process.env.RSI_PATCH_NOTES_HUB_URL || 'https://robertsspaceindustries.com/en/patch-notes').trim();
const rsiPatchNotesForumUrl = (process.env.RSI_PATCH_NOTES_FORUM_URL || 'https://robertsspaceindustries.com/spectrum/community/SC/forum/190048').trim();
const rsiPatchNotesPollMinutes = Math.max(2, Number(process.env.RSI_PATCH_NOTES_POLL_MINUTES || '10'));
const opsReminderChannelId = (process.env.OPS_REMINDER_CHANNEL_ID || '1368992696487641438').trim();
const opsReminderPollMinutes = Math.max(1, Number(process.env.OPS_REMINDER_POLL_MINUTES || '2'));
const opsReminderLookaheadDays = Math.max(1, Number(process.env.OPS_REMINDER_LOOKAHEAD_DAYS || '7'));
const opsReminderStagingLeadMinutes = Math.max(1, Number(process.env.OPS_REMINDER_STAGING_LEAD_MINUTES || '30'));
const stateDir = path.resolve(process.env.STATE_DIR || './state');
const rsiNewsStatePath = path.resolve(stateDir, process.env.RSI_NEWS_STATE_FILE || 'rsi-comm-link-state.json');
const rsiStatusStatePath = path.resolve(stateDir, process.env.RSI_STATUS_STATE_FILE || 'rsi-status-state.json');
const rsiPatchNotesStatePath = path.resolve(stateDir, process.env.RSI_PATCH_NOTES_STATE_FILE || 'rsi-patch-notes-state.json');
const opsReminderStatePath = path.resolve(stateDir, process.env.OPS_REMINDER_STATE_FILE || 'ops-reminders-state.json');
const opsReminderWindowMinutes = parseReminderWindowsMinutes(process.env.OPS_REMINDER_WINDOWS_MINUTES || '1440,60,15');
const siteBaseUrl = (process.env.BHS_SITE_BASE_URL || '').trim().replace(/\/+$/u, '');
const siteSharedSecret = (process.env.BHS_SITE_SHARED_SECRET || process.env.MEDIA_SYNC_SHARED_SECRET || '').trim();
const siteRequestTimeoutMs = Math.max(3000, Number(process.env.BHS_SITE_TIMEOUT_MS || '10000'));
const systemHeartbeatMinutes = Math.max(1, Number(process.env.BHS_SYSTEM_HEARTBEAT_MINUTES || '2'));
const adminRoleIds = (process.env.DISCORD_ADMIN_ROLE_IDS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
const officerRoleIds = (process.env.DISCORD_OFFICER_ROLE_IDS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
const staffRoleIds = [...new Set([...adminRoleIds, ...officerRoleIds])];
const partyApiPort = Math.max(1024, Number(process.env.PARTY_API_PORT || '3002'));
const partyKeyOwnerUserId = (process.env.PARTY_KEY_OWNER_USER_ID || process.env.BOT_OWNER_USER_ID || '').trim();
const staffOnlyCommands = new Set(['ops', 'system', 'memberadmin']);
const adminOnlyCommands = new Set(['partykey']);
const adminChannelCommands = new Set([...staffOnlyCommands, ...adminOnlyCommands]);
const memberChannelCommands = new Set(['radio', 'roll', 'fleet']);
let botRuntimeConfig = {
  key: 'default',
  channelRouting: {},
  featureToggles: {},
  roleRules: {},
  snippetMetadata: {},
  updatedBy: null,
  updatedAt: null,
  loadedAt: null,
  source: 'env-defaults',
};

if (!token || !guildId) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
  process.exit(1);
}

const allowedExtensions = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

function displayName(filePath) {
  return path.basename(filePath);
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value, maxLength = 100) {
  const cleaned = cleanText(value);
  if (!cleaned || cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function cleanOpCode(value) {
  return cleanText(value).toUpperCase();
}

function formatOpDisplayTitle(opCode, title) {
  const cleanedCode = cleanOpCode(opCode);
  const cleanedTitle = cleanText(title) || 'Untitled Operation';
  return cleanedCode ? `${cleanedCode} · ${cleanedTitle}` : cleanedTitle;
}

function formatOpStateLabel(value) {
  const cleaned = cleanText(value).toLowerCase();
  if (!cleaned) {
    return 'Unknown';
  }
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

function buildRollCommand() {
  const command = new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Roll 1-100 for 2 to 20 selected members and announce the winner.');

  for (let index = 1; index <= 20; index += 1) {
    command.addUserOption((option) =>
      option
        .setName(`member${index}`)
        .setDescription(index <= 2 ? `Entrant ${index} (required)` : `Entrant ${index}`)
        .setRequired(index <= 2)
    );
  }

  return command;
}

function collectRollEntrants(interaction) {
  const entrants = [];
  const duplicates = [];
  const seenIds = new Set();

  for (let index = 1; index <= 20; index += 1) {
    const user = interaction.options.getUser(`member${index}`);
    if (!user) {
      continue;
    }

    if (seenIds.has(user.id)) {
      duplicates.push(user);
      continue;
    }

    seenIds.add(user.id);
    entrants.push({
      id: user.id,
      mention: user.toString(),
      label: cleanText(user.globalName) || cleanText(user.username) || user.toString(),
    });
  }

  return { entrants, duplicates };
}

function rollD100() {
  return Math.floor(Math.random() * 100) + 1;
}

function runRandomRoll(entrants, maxRounds = 25) {
  const rounds = [];
  let contenders = [...entrants];

  for (let roundNumber = 1; roundNumber <= maxRounds; roundNumber += 1) {
    const results = contenders.map((name) => ({
      name,
      roll: rollD100(),
    }));

    const highestRoll = Math.max(...results.map((entry) => entry.roll));
    const leaders = results.filter((entry) => entry.roll === highestRoll);

    rounds.push({
      roundNumber,
      isRollOff: roundNumber > 1,
      highestRoll,
      results,
      leaders,
    });

    if (leaders.length === 1) {
      return {
        rounds,
        winner: leaders[0],
        resolved: true,
      };
    }

    contenders = leaders.map((entry) => entry.name);
  }

  return {
    rounds,
    winner: null,
    resolved: false,
  };
}

function formatRandomRollMessage(entrants, rounds, startedBy, winner, resolved) {
  const lines = [
    '## Random Roll',
    `Started by ${startedBy}`,
    `Entrants (${entrants.length}): ${entrants.map((entry) => entry.mention).join(', ')}`,
    '',
  ];

  for (const round of rounds) {
    const heading = round.isRollOff
      ? `### Roll-off ${round.roundNumber - 1}`
      : '### Opening Round';

    lines.push(heading);

    for (const result of round.results) {
      lines.push(`- ${result.name.mention} — ${result.roll}`);
    }

    if (round.leaders.length > 1) {
      lines.push(`Tie for high roll at **${round.highestRoll}**: ${round.leaders.map((entry) => entry.name.mention).join(', ')}`);
      lines.push('Roll-off initiated.');
    } else {
      lines.push(`Top roll: **${round.highestRoll}**`);
    }

    lines.push('');
  }

  if (resolved && winner) {
    if (rounds.length > 1) {
      lines.push(`## Winner: ${winner.name.mention} after ${rounds.length - 1} roll-off${rounds.length - 1 === 1 ? '' : 's'} (**${winner.roll}**)`);
    } else {
      lines.push(`## Winner: ${winner.name.mention} (**${winner.roll}**)`);
    }
  } else {
    const finalRound = rounds[rounds.length - 1];
    const tiedNames = finalRound?.leaders?.map((entry) => entry.name.mention).join(', ') || 'the tied entrants';
    lines.push(`## Roll-off unresolved after ${rounds.length} rounds. Tied entrants: ${tiedNames}`);
    lines.push('Run the command again to continue the duel.');
  }

  return lines.join('\n');
}

function parseReminderWindowsMinutes(value) {
  const parsed = cleanText(value)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.round(entry));

  const unique = [...new Set(parsed)].sort((left, right) => right - left);
  return unique.length ? unique : [1440, 60, 15];
}

function formatReminderWindowLabel(minutes) {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days}-day`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}-hour`;
  }

  return `${minutes}-minute`;
}

function formatReminderLabel(value) {
  if (typeof value === 'number') {
    return formatReminderWindowLabel(value);
  }

  const cleaned = cleanText(value).toLowerCase();
  if (cleaned === '24h') return '24-hour';
  if (cleaned === '1h') return '1-hour';
  if (cleaned === '15m') return '15-minute';
  if (cleaned === 'now') return 'manual';
  return 'manual';
}

function reminderTimingToWindowKey(value) {
  const cleaned = cleanText(value).toLowerCase();
  if (cleaned === '24h') return '1440';
  if (cleaned === '1h') return '60';
  if (cleaned === '15m') return '15';
  if (cleaned === 'now') return 'manual';
  return '';
}

function formatReminderWindowSummary(windows) {
  if (!Array.isArray(windows) || !windows.length) {
    return 'Disabled';
  }

  return windows.map((minutes) => formatReminderWindowLabel(minutes)).join(', ');
}

function ensureDirectorySync(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function decodeHtmlEntities(value) {
  return cleanText(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#x27;/gu, "'")
    .replace(/&#x2F;/gu, '/')
    .replace(/&#(\d+);/gu, (_, codePoint) => String.fromCodePoint(Number(codePoint)))
    .replace(/&#x([\da-fA-F]+);/gu, (_, codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)));
}

function stripHtml(value) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/p>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeArticleUrl(value) {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return '';
  }

  try {
    return new URL(cleaned, 'https://robertsspaceindustries.com').toString();
  } catch {
    return cleaned;
  }
}

function looksLikeCommLinkArticleUrl(value) {
  const url = normalizeArticleUrl(value);
  return /robertsspaceindustries\.com\/(?:en\/)?comm-link\/[a-z-]+\/\d+-/iu.test(url);
}

function looksLikeRsiStatusUrl(value) {
  const url = normalizeArticleUrl(value);
  return /status\.robertsspaceindustries\.com\//iu.test(url)
    || /statuspage\.io\//iu.test(url);
}

function looksLikePatchNotesArticleUrl(value) {
  const url = normalizeArticleUrl(value);
  return /robertsspaceindustries\.com\/(?:en\/)?patch-notes(?:\/|$)/iu.test(url)
    || /robertsspaceindustries\.com\/comm-link\/patch-notes\//iu.test(url)
    || /robertsspaceindustries\.com\/spectrum\/community\/SC\/forum\/\d+\/thread\/.+(?:patch-notes|release-notes)/iu.test(url);
}

function looksLikePatchNotesTitle(value) {
  const text = cleanText(value);
  return /(?:patch\s*notes|release\s*notes|hotfix\s*notes)/iu.test(text);
}

function extractTitleFromAnchorHtml(anchorHtml) {
  const cleaned = stripHtml(anchorHtml)
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned;
}

function parseDateString(value) {
  const parsed = Date.parse(cleanText(value));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function extractXmlTag(block, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'iu');
  const match = block.match(regex);
  return match ? match[1] : '';
}

function parseXmlFeedItems(text) {
  const xml = cleanText(text);
  if (!xml || (!xml.includes('<item') && !xml.includes('<entry'))) {
    return [];
  }

  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/giu) || xml.match(/<entry\b[\s\S]*?<\/entry>/giu) || [];
  const items = [];

  for (const block of itemBlocks) {
    const title = stripHtml(extractXmlTag(block, 'title'));
    const linkTag = extractXmlTag(block, 'link');
    const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/iu);
    const link = normalizeArticleUrl(hrefMatch?.[1] || stripHtml(linkTag));
    const guid = stripHtml(extractXmlTag(block, 'guid'));
    const description = stripHtml(extractXmlTag(block, 'description') || extractXmlTag(block, 'summary') || extractXmlTag(block, 'content'));
    const pubDate = stripHtml(extractXmlTag(block, 'pubDate') || extractXmlTag(block, 'published') || extractXmlTag(block, 'updated'));

    if (!title || !looksLikeCommLinkArticleUrl(link)) {
      continue;
    }

    items.push({
      key: cleanText(guid) || link,
      title,
      link,
      description,
      pubDate,
    });
  }

  return items;
}

function collectJsonLdArticles(node, results) {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      collectJsonLdArticles(entry, results);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const url = normalizeArticleUrl(node.url || node.mainEntityOfPage?.['@id'] || '');
  const title = stripHtml(node.headline || node.name || '');
  if (title && looksLikeCommLinkArticleUrl(url)) {
    results.push({
      key: cleanText(node.identifier || node['@id'] || url) || url,
      title,
      link: url,
      description: stripHtml(node.description || node.articleBody || ''),
      pubDate: cleanText(node.datePublished || node.dateCreated || node.dateModified || ''),
    });
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectJsonLdArticles(value, results);
    }
  }
}

function parseJsonLdFeedItems(html) {
  const items = [];
  const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/giu) || [];

  for (const scriptBlock of scripts) {
    const jsonMatch = scriptBlock.match(/<script[^>]*>([\s\S]*?)<\/script>/iu);
    const rawJson = cleanText(jsonMatch?.[1]);
    if (!rawJson) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawJson);
      collectJsonLdArticles(parsed, items);
    } catch {}
  }

  return items;
}

function parseHtmlFeedItems(html) {
  const items = [];
  const seen = new Set();
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match = linkRegex.exec(html);

  while (match) {
    const link = normalizeArticleUrl(match[1]);
    const title = stripHtml(match[2]);
    const key = link;

    if (title && looksLikeCommLinkArticleUrl(link) && !seen.has(key)) {
      seen.add(key);
      items.push({
        key,
        title,
        link,
        description: '',
        pubDate: '',
      });
    }

    match = linkRegex.exec(html);
  }

  return items;
}

function dedupeFeedItems(items) {
  const unique = [];
  const seen = new Set();

  for (const item of items) {
    const key = cleanText(item?.key) || cleanText(item?.link);
    const title = cleanText(item?.title);
    const link = normalizeArticleUrl(item?.link);

    if (!key || !title || !looksLikeCommLinkArticleUrl(link) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push({
      key,
      title,
      link,
      description: truncateText(stripHtml(item?.description || ''), 350),
      pubDate: cleanText(item?.pubDate || ''),
    });
  }

  return unique;
}

function parseRsiCommLinkFeed(feedText) {
  const xmlItems = parseXmlFeedItems(feedText);
  if (xmlItems.length) {
    return dedupeFeedItems(xmlItems);
  }

  const jsonLdItems = parseJsonLdFeedItems(feedText);
  if (jsonLdItems.length) {
    return dedupeFeedItems(jsonLdItems);
  }

  return dedupeFeedItems(parseHtmlFeedItems(feedText));
}

function readWatcherState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed?.initialized),
      lastItemKey: cleanText(parsed?.lastItemKey),
      lastCheckedAt: cleanText(parsed?.lastCheckedAt),
      lastPostedAt: cleanText(parsed?.lastPostedAt),
    };
  } catch {
    return {
      initialized: false,
      lastItemKey: '',
      lastCheckedAt: '',
      lastPostedAt: '',
    };
  }
}

function writeWatcherState(statePath, state) {
  ensureDirectorySync(stateDir);
  const payload = {
    initialized: Boolean(state?.initialized),
    lastItemKey: cleanText(state?.lastItemKey),
    lastCheckedAt: new Date().toISOString(),
    lastPostedAt: cleanText(state?.lastPostedAt),
  };
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2));
}

function normalizeOpsReminderMessageEntries(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const entry of values) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const windowKey = cleanText(entry.window);
    const messageId = cleanText(entry.messageId);
    if (!windowKey || !messageId) {
      continue;
    }

    const dedupeKey = `${windowKey}:${messageId}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push({ window: windowKey, messageId });
  }

  return normalized;
}

function normalizeOpsReminderState(state) {
  const reminders = {};
  const rawReminders = state?.reminders && typeof state.reminders === 'object' ? state.reminders : {};

  for (const [opId, entry] of Object.entries(rawReminders)) {
    const cleanedOpId = cleanText(opId);
    if (!cleanedOpId || !entry || typeof entry !== 'object') {
      continue;
    }

    reminders[cleanedOpId] = {
      startTime: cleanText(entry.startTime),
      sent: Array.isArray(entry.sent)
        ? [...new Set(entry.sent.map((value) => cleanText(value)).filter(Boolean))]
        : [],
      messages: normalizeOpsReminderMessageEntries(entry.messages),
    };
  }

  return {
    initialized: Boolean(state?.initialized),
    lastCheckedAt: cleanText(state?.lastCheckedAt),
    lastPostedAt: cleanText(state?.lastPostedAt),
    reminders,
  };
}

function readOpsReminderState() {
  try {
    const raw = fs.readFileSync(opsReminderStatePath, 'utf8');
    return normalizeOpsReminderState(JSON.parse(raw));
  } catch {
    return normalizeOpsReminderState({});
  }
}

function writeOpsReminderState(state) {
  ensureDirectorySync(stateDir);
  const normalized = normalizeOpsReminderState(state);
  const payload = {
    initialized: normalized.initialized,
    lastCheckedAt: new Date().toISOString(),
    lastPostedAt: normalized.lastPostedAt,
    reminders: normalized.reminders,
  };
  fs.writeFileSync(opsReminderStatePath, JSON.stringify(payload, null, 2));
}

function readRsiNewsState() {
  return readWatcherState(rsiNewsStatePath);
}

function writeRsiNewsState(state) {
  writeWatcherState(rsiNewsStatePath, state);
}

function buildRsiCommLinkEmbed(item) {
  const embed = new EmbedBuilder()
    .setTitle(truncateText(item.title, 256))
    .setURL(item.link)
    .setAuthor({ name: 'RSI Comm-Link' })
    .setFooter({ text: 'robertsspaceindustries.com' });

  if (item.description) {
    embed.setDescription(truncateText(item.description, 4000));
  }

  const parsedDate = item.pubDate ? Date.parse(item.pubDate) : NaN;
  if (!Number.isNaN(parsedDate)) {
    embed.setTimestamp(new Date(parsedDate));
  }

  return embed;
}

let rsiNewsPollTimer = null;
let rsiNewsPollInFlight = false;

async function fetchRsiCommLinkItems() {
  const response = await fetch(rsiCommLinkFeedUrl, {
    headers: {
      'User-Agent': 'Black Hull Broadcast/1.0 (+Discord bot)',
      Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`RSI Comm-Link returned ${response.status}.`);
  }

  const feedText = await response.text();
  const items = parseRsiCommLinkFeed(feedText);

  if (!items.length) {
    throw new Error('No Comm-Link items were parsed from the RSI feed page.');
  }

  return items;
}

async function pollRsiCommLink(client, { startup = false } = {}) {
  if (rsiNewsPollInFlight) {
    return;
  }

  rsiNewsPollInFlight = true;

  try {
    if (!client?.isReady?.()) {
      throw new Error('Discord client is not ready.');
    }

    const channel = await client.channels.fetch(rsiNewsChannelId);
    if (!channel?.isTextBased?.()) {
      throw new Error(`RSI news channel is not text-based: ${rsiNewsChannelId}`);
    }

    const items = await fetchRsiCommLinkItems();
    const newestItem = items[0];
    const state = readRsiNewsState();

    if (!state.initialized || !state.lastItemKey) {
      writeRsiNewsState({
        initialized: true,
        lastItemKey: newestItem.key,
        lastPostedAt: '',
      });
      console.log(`RSI Comm-Link watcher seeded with: ${newestItem.title}`);
      return;
    }

    const pending = [];
    for (const item of items) {
      if (item.key === state.lastItemKey) {
        break;
      }
      pending.push(item);
    }

    if (!pending.length) {
      writeRsiNewsState({
        initialized: true,
        lastItemKey: state.lastItemKey,
        lastPostedAt: state.lastPostedAt,
      });
      return;
    }

    const itemsToPost = pending.slice(0, 5).reverse();
    for (const item of itemsToPost) {
      await channel.send({
        content: 'New RSI Comm-Link post:',
        embeds: [buildRsiCommLinkEmbed(item)],
      });
    }

    writeRsiNewsState({
      initialized: true,
      lastItemKey: newestItem.key,
      lastPostedAt: new Date().toISOString(),
    });

    console.log(`Posted ${itemsToPost.length} new RSI Comm-Link item(s)${startup ? ' during startup check' : ''}.`);
  } catch (error) {
    console.error('RSI Comm-Link watcher error:', error.message || error);
  } finally {
    rsiNewsPollInFlight = false;
  }
}

async function startRsiCommLinkWatcher(client) {
  if (rsiNewsPollTimer) {
    clearInterval(rsiNewsPollTimer);
    rsiNewsPollTimer = null;
  }

  await pollRsiCommLink(client, { startup: true });
  rsiNewsPollTimer = setInterval(() => {
    pollRsiCommLink(client).catch((error) => {
      console.error('RSI Comm-Link interval error:', error.message || error);
    });
  }, rsiNewsPollMinutes * 60 * 1000);
}

function parseRsiStatusFeed(feedText) {
  const xml = cleanText(feedText);
  if (!xml.includes('<item') && !xml.includes('<entry')) {
    return [];
  }

  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/giu) || xml.match(/<entry\b[\s\S]*?<\/entry>/giu) || [];
  const items = [];

  for (const block of itemBlocks) {
    const title = stripHtml(extractXmlTag(block, 'title'));
    const linkTag = extractXmlTag(block, 'link');
    const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/iu);
    const link = normalizeArticleUrl(hrefMatch?.[1] || stripHtml(linkTag));
    const guid = stripHtml(extractXmlTag(block, 'guid') || extractXmlTag(block, 'id'));
    const description = truncateText(stripHtml(extractXmlTag(block, 'description') || extractXmlTag(block, 'summary') || extractXmlTag(block, 'content')), 3500);
    const pubDate = cleanText(extractXmlTag(block, 'pubDate') || extractXmlTag(block, 'published') || extractXmlTag(block, 'updated'));

    if (!title || !looksLikeRsiStatusUrl(link)) {
      continue;
    }

    items.push({
      key: cleanText(guid) || link,
      title,
      link,
      description,
      pubDate,
    });
  }

  return items;
}

function readRsiStatusState() {
  return readWatcherState(rsiStatusStatePath);
}

function writeRsiStatusState(state) {
  writeWatcherState(rsiStatusStatePath, state);
}

function buildRsiStatusEmbed(item) {
  const embed = new EmbedBuilder()
    .setTitle(truncateText(item.title, 256))
    .setURL(item.link)
    .setAuthor({ name: 'RSI Status' })
    .setFooter({ text: 'status.robertsspaceindustries.com' });

  if (item.description) {
    embed.setDescription(truncateText(item.description, 4000));
  }

  const parsedDate = item.pubDate ? Date.parse(item.pubDate) : NaN;
  if (!Number.isNaN(parsedDate)) {
    embed.setTimestamp(new Date(parsedDate));
  }

  return embed;
}

let rsiStatusPollTimer = null;
let rsiStatusPollInFlight = false;
let lastRsiStatusParseWarningAt = 0;

async function fetchRsiStatusItems() {
  const response = await fetch(rsiStatusFeedUrl, {
    headers: {
      'User-Agent': 'Black Hull Broadcast/1.0 (+Discord bot)',
      Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`RSI Status returned ${response.status}.`);
  }

  const feedText = await response.text();
  const items = parseRsiStatusFeed(feedText);
  return items;
}

async function pollRsiStatus(client, { startup = false } = {}) {
  if (rsiStatusPollInFlight) {
    return;
  }

  rsiStatusPollInFlight = true;

  try {
    if (!client?.isReady?.()) {
      throw new Error('Discord client is not ready.');
    }

    const channel = await client.channels.fetch(rsiStatusChannelId);
    if (!channel?.isTextBased?.()) {
      throw new Error(`RSI status channel is not text-based: ${rsiStatusChannelId}`);
    }

    const items = await fetchRsiStatusItems();
    if (!items.length) {
      const now = Date.now();
      if (!lastRsiStatusParseWarningAt || now - lastRsiStatusParseWarningAt >= 30 * 60 * 1000) {
        lastRsiStatusParseWarningAt = now;
        console.warn('RSI Status watcher warning: feed parsed successfully but no status items were found.');
      }
      return;
    }

    const newestItem = items[0];
    const state = readRsiStatusState();

    if (!state.initialized || !state.lastItemKey) {
      writeRsiStatusState({ initialized: true, lastItemKey: newestItem.key, lastPostedAt: '' });
      console.log(`RSI Status watcher seeded with: ${newestItem.title}`);
      return;
    }

    const pending = [];
    for (const item of items) {
      if (item.key === state.lastItemKey) {
        break;
      }
      pending.push(item);
    }

    if (!pending.length) {
      writeRsiStatusState({ initialized: true, lastItemKey: state.lastItemKey, lastPostedAt: state.lastPostedAt });
      return;
    }

    const itemsToPost = pending.slice(0, 5).reverse();
    for (const item of itemsToPost) {
      await channel.send({
        content: 'New RSI status update:',
        embeds: [buildRsiStatusEmbed(item)],
      });
    }

    writeRsiStatusState({ initialized: true, lastItemKey: newestItem.key, lastPostedAt: new Date().toISOString() });
    console.log(`Posted ${itemsToPost.length} new RSI status item(s)${startup ? ' during startup check' : ''}.`);
  } catch (error) {
    console.error('RSI Status watcher error:', error.message || error);
  } finally {
    rsiStatusPollInFlight = false;
  }
}

async function startRsiStatusWatcher(client) {
  if (rsiStatusPollTimer) {
    clearInterval(rsiStatusPollTimer);
    rsiStatusPollTimer = null;
  }

  await pollRsiStatus(client, { startup: true });
  rsiStatusPollTimer = setInterval(() => {
    pollRsiStatus(client).catch((error) => {
      console.error('RSI Status interval error:', error.message || error);
    });
  }, rsiStatusPollMinutes * 60 * 1000);
}

function parsePatchNotesHubItems(html) {
  const items = [];
  const seen = new Set();
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match = linkRegex.exec(html);

  while (match) {
    const link = normalizeArticleUrl(match[1]);
    const title = extractTitleFromAnchorHtml(match[2]);
    const key = link;
    const isRsiPatchUrl = /robertsspaceindustries\.com\/(?:en\/)?patch-notes(?:\/|$)/iu.test(link);

    if (title && (isRsiPatchUrl || looksLikePatchNotesTitle(title)) && !seen.has(key)) {
      seen.add(key);
      items.push({ key, title, link, description: '', pubDate: '' });
    }

    match = linkRegex.exec(html);
  }

  return items;
}

function parsePatchNotesForumItems(html) {
  const items = [];
  const seen = new Set();
  const threadRegex = /<a[^>]+href=["']([^"']*\/spectrum\/community\/SC\/forum\/\d+\/thread\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match = threadRegex.exec(html);

  while (match) {
    const link = normalizeArticleUrl(match[1]);
    const title = extractTitleFromAnchorHtml(match[2]);
    const key = link;
    const looksLikeSpectrumThread = /\/spectrum\/community\/SC\/forum\/\d+\/thread\//iu.test(link);
    const looksLikePatchLink = /(?:patch-notes|release-notes|hotfix)/iu.test(link);

    if (title && looksLikeSpectrumThread && (looksLikePatchLink || looksLikePatchNotesTitle(title)) && !seen.has(key)) {
      seen.add(key);
      items.push({ key, title, link, description: '', pubDate: '' });
    }

    match = threadRegex.exec(html);
  }

  return items;
}

function dedupePatchNotesItems(items) {
  const unique = [];
  const seen = new Set();

  for (const item of items) {
    const key = cleanText(item?.key) || cleanText(item?.link);
    const title = cleanText(item?.title);
    const link = normalizeArticleUrl(item?.link);
    const patchUrl = looksLikePatchNotesArticleUrl(link);
    const patchTitle = looksLikePatchNotesTitle(title);
    const patchContextLink = /robertsspaceindustries\.com\/(?:en\/)?patch-notes(?:\/|$)/iu.test(link)
      || /robertsspaceindustries\.com\/comm-link\/patch-notes\//iu.test(link)
      || /robertsspaceindustries\.com\/spectrum\/community\/SC\/forum\/\d+\/thread\//iu.test(link);

    if (!key || !title || (!patchUrl && !(patchTitle && patchContextLink)) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push({
      key,
      title: cleanText(item.title),
      link,
      description: truncateText(stripHtml(item?.description || ''), 3500),
      pubDate: cleanText(item?.pubDate || ''),
    });
  }

  return unique;
}

function readRsiPatchNotesState() {
  return readWatcherState(rsiPatchNotesStatePath);
}

function writeRsiPatchNotesState(state) {
  writeWatcherState(rsiPatchNotesStatePath, state);
}

function buildRsiPatchNotesEmbed(item) {
  const embed = new EmbedBuilder()
    .setTitle(truncateText(item.title, 256))
    .setURL(item.link)
    .setAuthor({ name: 'RSI Patch Notes' })
    .setFooter({ text: item.link.includes('/spectrum/') ? 'Spectrum Patch Notes' : 'robertsspaceindustries.com/patch-notes' });

  if (item.description) {
    embed.setDescription(truncateText(item.description, 4000));
  }

  const parsedDate = item.pubDate ? Date.parse(item.pubDate) : NaN;
  if (!Number.isNaN(parsedDate)) {
    embed.setTimestamp(new Date(parsedDate));
  }

  return embed;
}

let rsiPatchNotesPollTimer = null;
let rsiPatchNotesPollInFlight = false;
let lastRsiPatchNotesParseWarningAt = 0;

async function fetchPatchNotesSource(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Black Hull Broadcast/1.0 (+Discord bot)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Patch notes source returned ${response.status}: ${url}`);
  }

  return response.text();
}

async function fetchRsiPatchNotesItems() {
  const [forumResult, hubResult] = await Promise.allSettled([
    fetchPatchNotesSource(rsiPatchNotesForumUrl),
    fetchPatchNotesSource(rsiPatchNotesHubUrl),
  ]);

  const forumItems = forumResult.status === 'fulfilled' ? parsePatchNotesForumItems(forumResult.value) : [];
  const hubItems = hubResult.status === 'fulfilled' ? parsePatchNotesHubItems(hubResult.value) : [];
  const items = dedupePatchNotesItems([...forumItems, ...hubItems]);

  if (!items.length) {
    return [];
  }

  return items;
}

async function pollRsiPatchNotes(client, { startup = false } = {}) {
  if (rsiPatchNotesPollInFlight) {
    return;
  }

  rsiPatchNotesPollInFlight = true;

  try {
    if (!client?.isReady?.()) {
      throw new Error('Discord client is not ready.');
    }

    const channel = await client.channels.fetch(rsiPatchNotesChannelId);
    if (!channel?.isTextBased?.()) {
      throw new Error(`RSI patch notes channel is not text-based: ${rsiPatchNotesChannelId}`);
    }

    const items = await fetchRsiPatchNotesItems();
    if (!items.length) {
      const now = Date.now();
      if (!lastRsiPatchNotesParseWarningAt || now - lastRsiPatchNotesParseWarningAt >= 30 * 60 * 1000) {
        lastRsiPatchNotesParseWarningAt = now;
        console.warn('RSI Patch Notes watcher warning: sources fetched but no patch note items were found.');
      }
      return;
    }

    const newestItem = items[0];
    const state = readRsiPatchNotesState();

    if (!state.initialized || !state.lastItemKey) {
      writeRsiPatchNotesState({ initialized: true, lastItemKey: newestItem.key, lastPostedAt: '' });
      console.log(`RSI Patch Notes watcher seeded with: ${newestItem.title}`);
      return;
    }

    const pending = [];
    for (const item of items) {
      if (item.key == state.lastItemKey) {
        break;
      }
      pending.push(item);
    }

    if (!pending.length) {
      writeRsiPatchNotesState({ initialized: true, lastItemKey: state.lastItemKey, lastPostedAt: state.lastPostedAt });
      return;
    }

    const itemsToPost = pending.slice(0, 8).reverse();
    for (const item of itemsToPost) {
      await channel.send({
        content: 'New RSI patch notes post:',
        embeds: [buildRsiPatchNotesEmbed(item)],
      });
    }

    writeRsiPatchNotesState({ initialized: true, lastItemKey: newestItem.key, lastPostedAt: new Date().toISOString() });
    console.log(`Posted ${itemsToPost.length} new RSI patch notes item(s)${startup ? ' during startup check' : ''}.`);
  } catch (error) {
    console.error('RSI Patch Notes watcher error:', error.message || error);
  } finally {
    rsiPatchNotesPollInFlight = false;
  }
}

async function startRsiPatchNotesWatcher(client) {
  if (rsiPatchNotesPollTimer) {
    clearInterval(rsiPatchNotesPollTimer);
    rsiPatchNotesPollTimer = null;
  }

  await pollRsiPatchNotes(client, { startup: true });
  rsiPatchNotesPollTimer = setInterval(() => {
    pollRsiPatchNotes(client).catch((error) => {
      console.error('RSI Patch Notes interval error:', error.message || error);
    });
  }, rsiPatchNotesPollMinutes * 60 * 1000);
}

function extractRoleIdsFromMember(member) {
  if (!member || typeof member !== 'object') {
    return [];
  }

  const roles = member.roles;

  if (Array.isArray(roles)) {
    return roles.map((roleId) => cleanText(roleId)).filter(Boolean);
  }

  if (roles && Array.isArray(roles.valueOf?.())) {
    return roles.valueOf().map((roleId) => cleanText(roleId)).filter(Boolean);
  }

  if (roles?.cache && typeof roles.cache.keys === 'function') {
    return [...roles.cache.keys()].map((roleId) => cleanText(roleId)).filter(Boolean);
  }

  return [];
}

function hasAnyRole(memberRoleIds, allowedRoleIds) {
  if (!memberRoleIds.length || !allowedRoleIds.length) {
    return false;
  }

  return memberRoleIds.some((roleId) => allowedRoleIds.includes(roleId));
}

function ensureStaffRoleConfig() {
  if (!staffRoleIds.length) {
    throw new Error('DISCORD_ADMIN_ROLE_IDS or DISCORD_OFFICER_ROLE_IDS is not configured on the bot.');
  }
}

function canUseStaffCommand(interaction) {
  ensureStaffRoleConfig();
  const memberRoleIds = extractRoleIdsFromMember(interaction.member);
  return hasAnyRole(memberRoleIds, staffRoleIds);
}

function ensureAdminRoleConfig() {
  if (!adminRoleIds.length) {
    throw new Error('DISCORD_ADMIN_ROLE_IDS is not configured on the bot.');
  }
}

function canUseAdminCommand(interaction) {
  ensureAdminRoleConfig();
  const memberRoleIds = extractRoleIdsFromMember(interaction.member);
  return hasAnyRole(memberRoleIds, adminRoleIds);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function readLibrary() {
  if (!fs.existsSync(audioDir)) {
    throw new Error(`Audio folder not found: ${audioDir}`);
  }

  return fs
    .readdirSync(audioDir)
    .filter((file) => allowedExtensions.has(path.extname(file).toLowerCase()))
    .map((file) => path.join(audioDir, file))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

let requestQueue = [];
let shuffleQueue = [];
let currentTrack = null;
let currentRequestedBy = null;
let connection = null;
let lastPlayed = null;

const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

function refillShuffleQueue() {
  shuffleQueue = readLibrary();
  shuffle(shuffleQueue);

  if (lastPlayed && shuffleQueue.length > 1 && shuffleQueue[0] === lastPlayed) {
    const swapIndex = Math.floor(Math.random() * (shuffleQueue.length - 1)) + 1;
    [shuffleQueue[0], shuffleQueue[swapIndex]] = [shuffleQueue[swapIndex], shuffleQueue[0]];
  }
}

function getNextTrack() {
  if (requestQueue.length > 0) {
    return { filePath: requestQueue.shift(), requestedBy: null };
  }

  if (shuffleQueue.length === 0) {
    refillShuffleQueue();
  }

  return { filePath: shuffleQueue.shift(), requestedBy: null };
}

function isVoiceConnectionReady() {
  return Boolean(connection && connection.state?.status === VoiceConnectionStatus.Ready);
}

function disconnectFromVoice(guildIdForConnection) {
  const activeConnection = getVoiceConnection(guildIdForConnection) || connection;

  try {
    player.stop(true);
  } catch {}

  currentTrack = null;
  currentRequestedBy = null;

  if (activeConnection) {
    try {
      activeConnection.destroy();
    } catch {}
  }

  connection = null;
}

function playTrack(trackInfo) {
  currentTrack = trackInfo.filePath;
  currentRequestedBy = trackInfo.requestedBy || null;
  lastPlayed = currentTrack;

  const resource = createAudioResource(currentTrack, { inlineVolume: true });
  resource.volume.setVolume(volume);
  player.play(resource);

  console.log(`Now playing: ${displayName(currentTrack)}`);
}

function playNext() {
  const trackInfo = getNextTrack();
  playTrack(trackInfo);
}

function buildPreviewQueue(count) {
  const preview = [...requestQueue, ...shuffleQueue];

  while (preview.length < count) {
    const extra = readLibrary();
    shuffle(extra);

    const lastPreview = preview.length ? preview[preview.length - 1] : currentTrack;
    if (lastPreview && extra.length > 1 && extra[0] === lastPreview) {
      const swapIndex = Math.floor(Math.random() * (extra.length - 1)) + 1;
      [extra[0], extra[swapIndex]] = [extra[swapIndex], extra[0]];
    }

    preview.push(...extra);
  }

  return preview.slice(0, count);
}

function matchTrack(query) {
  const library = readLibrary();
  const normalized = normalizeText(query);

  const exact = library.find((track) => displayName(track).toLowerCase() === normalized);
  if (exact) return { match: exact, suggestions: [] };

  const exactNoExt = library.find((track) => {
    const noExt = path.parse(displayName(track)).name.toLowerCase();
    return noExt === normalized;
  });
  if (exactNoExt) return { match: exactNoExt, suggestions: [] };

  const partials = library.filter((track) => displayName(track).toLowerCase().includes(normalized));

  if (partials.length === 1) {
    return { match: partials[0], suggestions: [] };
  }

  if (partials.length > 1) {
    return { match: null, suggestions: partials.slice(0, 5) };
  }

  return { match: null, suggestions: [] };
}

function ensureSiteApiConfigured() {
  if (!siteBaseUrl) {
    throw new Error('BHS_SITE_BASE_URL is not configured.');
  }

  if (!siteSharedSecret) {
    throw new Error('BHS_SITE_SHARED_SECRET or MEDIA_SYNC_SHARED_SECRET is not configured.');
  }
}

function formatSiteTransportError(error, routePath) {
  if (error?.name === 'AbortError') {
    return `Website request timed out after ${Math.round(siteRequestTimeoutMs / 1000)}s (${routePath}).`;
  }

  const message = error instanceof Error ? error.message : String(error || 'Unknown website request failure.');
  return `Website request failed (${routePath}): ${message}`;
}

function formatWebsiteEndpointError(response, payload, text) {
  if (payload && typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }

  const fallback = `Website endpoint returned ${response.status}.`;
  const snippet = truncateText(cleanText(text), 120);
  return snippet ? `${fallback} ${snippet}` : fallback;
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

async function refreshBotRuntimeConfig() {
  if (!siteBaseUrl || !siteSharedSecret) {
    return botRuntimeConfig;
  }

  try {
    const payload = await fetchSiteJson('/api/internal/bot-config');
    const config = payload && typeof payload === 'object' ? payload.config : null;

    if (!config || typeof config !== 'object') {
      console.warn('[bot-config] Internal endpoint returned no config payload; using defaults.');
      return botRuntimeConfig;
    }

    botRuntimeConfig = {
      key: cleanText(config.key) || 'default',
      channelRouting: asPlainObject(config.channelRouting),
      featureToggles: asPlainObject(config.featureToggles),
      roleRules: asPlainObject(config.roleRules),
      snippetMetadata: asPlainObject(config.snippetMetadata),
      updatedBy: cleanText(config.updatedBy) || null,
      updatedAt: cleanText(config.updatedAt) || null,
      loadedAt: new Date().toISOString(),
      source: 'website-config',
    };

    console.log(`[bot-config] Loaded config '${botRuntimeConfig.key}' from website.`);
    return botRuntimeConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[bot-config] Failed to load website config (${message}); using defaults.`);
    return botRuntimeConfig;
  }
}

async function fetchSiteJson(routePath, searchParams = {}) {
  ensureSiteApiConfigured();

  const url = new URL(routePath, `${siteBaseUrl}/`);
  for (const [key, value] of Object.entries(searchParams)) {
    const cleaned = cleanText(value);
    if (cleaned) {
      url.searchParams.set(key, cleaned);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), siteRequestTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${siteSharedSecret}`,
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new Error(formatWebsiteEndpointError(response, payload, text));
    }

    return payload || {};
  } catch (error) {
    throw new Error(formatSiteTransportError(error, routePath));
  } finally {
    clearTimeout(timeout);
  }
}

async function postSiteJson(routePath, body = {}) {
  ensureSiteApiConfigured();

  const url = new URL(routePath, `${siteBaseUrl}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), siteRequestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${siteSharedSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new Error(formatWebsiteEndpointError(response, payload, text));
    }

    return payload || {};
  } catch (error) {
    throw new Error(formatSiteTransportError(error, routePath));
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemHeartbeatServices(client) {
  const nowIso = new Date().toISOString();
  const botHealthy = Boolean(client?.isReady?.());
  const opsStatus = !lastOpsReminderPollAttemptAt
    ? 'warning'
    : lastOpsReminderPollError
      ? 'error'
      : 'healthy';

  return {
    nowIso,
    services: [
      {
        service: 'bot',
        status: botHealthy ? 'healthy' : 'error',
        statusNote: botHealthy ? `Discord client ready as ${client.user?.tag || 'unknown bot'}.` : 'Discord client is not ready.',
        details: {
          uptimeSeconds: Math.round(process.uptime()),
          voiceChannelId: connection?.joinConfig?.channelId || null,
          currentTrack: currentTrack ? displayName(currentTrack) : null,
          lastSystemHeartbeatAt,
          lastSystemHeartbeatError: lastSystemHeartbeatError || null,
        },
        checkedAt: nowIso,
        lastSuccessAt: botHealthy ? nowIso : null,
        lastFailureAt: botHealthy ? null : nowIso,
      },
      {
        service: 'internal_api',
        status: internalApiStartedAt ? 'healthy' : 'error',
        statusNote: internalApiStartedAt ? `Internal API listening on port ${mediaSyncPort}.` : 'Internal API has not started.',
        details: { port: mediaSyncPort, startedAt: internalApiStartedAt },
        checkedAt: nowIso,
        lastSuccessAt: internalApiStartedAt || null,
        lastFailureAt: internalApiStartedAt ? null : nowIso,
      },
      {
        service: 'ops_reminders',
        status: opsStatus,
        statusNote: lastOpsReminderPollError || (lastOpsReminderPollSucceededAt ? 'Ops reminder watcher is polling normally.' : 'Ops reminder watcher has not completed a successful poll yet.'),
        details: {
          lastAttemptAt: lastOpsReminderPollAttemptAt,
          lastSuccessAt: lastOpsReminderPollSucceededAt,
          pollMinutes: opsReminderPollMinutes,
          windows: opsReminderWindowMinutes,
        },
        checkedAt: nowIso,
        lastSuccessAt: lastOpsReminderPollSucceededAt || null,
        lastFailureAt: lastOpsReminderPollError ? nowIso : null,
      },
    ],
  };
}

async function postSystemHeartbeat(client) {
  ensureSiteApiConfigured();

  const heartbeat = buildSystemHeartbeatServices(client);

  await postSiteJson('/api/internal/system/heartbeat', {
    source: 'black-hull-radio',
    services: heartbeat.services,
  });

  lastSystemHeartbeatAt = heartbeat.nowIso;
  lastSystemHeartbeatError = '';
  return heartbeat;
}

async function sendSystemHeartbeatSafe(client) {
  try {
    await postSystemHeartbeat(client);
  } catch (error) {
    lastSystemHeartbeatError = error instanceof Error ? error.message : String(error);
    console.error('System heartbeat failed:', lastSystemHeartbeatError);
  }
}

async function fetchMemberShips(discordUserId) {
  return fetchSiteJson('/api/internal/ships', { discordUserId });
}

async function fetchFleetSummary() {
  return fetchSiteJson('/api/internal/fleet');
}

async function fetchFleetShipDetail(ship) {
  return fetchSiteJson('/api/internal/fleet', { ship });
}

async function fetchFleetAutocomplete(query) {
  return fetchSiteJson('/api/internal/fleet', { mode: 'autocomplete', q: query });
}

async function fetchRoster(status) {
  return fetchSiteJson('/api/internal/roster', status ? { status } : {});
}

async function fetchAdminQueue(actorDiscordUserId) {
  return fetchSiteJson('/api/internal/adminqueue', { actorDiscordUserId });
}

async function fetchAuthCheck(discordUserId, actorDiscordUserId) {
  return fetchSiteJson('/api/internal/authcheck', { discordUserId, actorDiscordUserId });
}

async function fetchMemberLookup(discordUserId, actorDiscordUserId) {
  return fetchSiteJson('/api/internal/memberlookup', { discordUserId, actorDiscordUserId });
}

async function fetchRemoved(discordUserId, actorDiscordUserId) {
  return fetchSiteJson('/api/internal/removed', discordUserId ? { discordUserId, actorDiscordUserId } : { actorDiscordUserId });
}

async function fetchOpsReminderFeed() {
  return fetchSiteJson('/api/internal/ops-reminders', { lookaheadDays: String(opsReminderLookaheadDays) });
}

async function fetchOpAdminAutocomplete(query, actorDiscordUserId) {
  return fetchSiteJson('/api/internal/op-admin', { mode: 'autocomplete', q: query, actorDiscordUserId });
}

async function submitSetOpState(code, newStatus, actorDiscordUserId) {
  return postSiteJson('/api/internal/op-admin', { code, newStatus, actorDiscordUserId });
}

async function submitSetOpTime(code, year, month, day, hour, minute, actorDiscordUserId) {
  return postSiteJson('/api/internal/op-admin', { code, year, month, day, hour, minute, actorDiscordUserId });
}

async function submitForceOpReminder(code, timing, actorDiscordUserId) {
  return postSiteJson('/api/internal/op-admin', { code, manualReminderTiming: timing, actorDiscordUserId });
}

async function submitRepostOp(code, actorDiscordUserId) {
  return postSiteJson('/api/internal/op-admin', { code, manualRepost: true, actorDiscordUserId });
}

async function submitSetRank(targetDiscordUserId, rankTitle, actorDiscordUserId) {
  return postSiteJson('/api/internal/rank-admin', { targetDiscordUserId, rankTitle, actorDiscordUserId });
}

function formatSetRankMessage(payload, actorMention, targetMention) {
  const target = payload?.target || {};
  const displayName = cleanText(target?.rsiName) || cleanText(target?.discordName) || targetMention || 'Unknown member';
  const previousRank = cleanText(target?.previousRankTitle) || 'Unranked';
  const newRank = cleanText(target?.newRankTitle) || 'Unknown';
  const warning = cleanText(payload?.warning);

  const lines = [
    `**${displayName}**`,
    payload?.noChange
      ? `No change — already **${newRank}**.`
      : `Rank changed from **${previousRank}** to **${newRank}** by ${actorMention}.`,
  ];

  if (normalizeText(newRank) === 'inactive') {
    lines.push('Inactive members are moved to Inactive / Reserve and website access is blocked.');
  }

  if (warning) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join('\n');
}

function formatSetOpStateMessage(payload, actorMention) {
  const op = payload?.op || {};
  const code = cleanOpCode(op.code) || 'BH-????';
  const title = cleanText(op.title) || 'Untitled Operation';
  const url = cleanText(op.url);
  const previousState = formatOpStateLabel(payload?.previousStatus);
  const newState = formatOpStateLabel(payload?.newStatus);
  const warning = cleanText(payload?.warning);

  const lines = [
    `**${code}** · **${title}**`,
    payload?.noChange
      ? `No change — already **${newState.toUpperCase()}**.`
      : `State changed from **${previousState.toUpperCase()}** to **${newState.toUpperCase()}** by ${actorMention}.`,
  ];

  if (url) {
    lines.push(url);
  }

  if (warning) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join('\n');
}

function formatRepostOpMessage(payload, actorMention, channelMention) {
  const op = payload?.op || {};
  const code = cleanOpCode(op.code) || 'BH-????';
  const title = cleanText(op.title) || 'Untitled Operation';
  const url = cleanText(op.url);
  const warning = cleanText(payload?.warning);
  const hadPrevious = Boolean(cleanText(op.previousMessageId));

  const lines = [
    `**${code}** · **${title}**`,
    hadPrevious
      ? `Tracked Discord op post replaced by ${actorMention} in ${channelMention}.`
      : `Fresh Discord op post created by ${actorMention} in ${channelMention}.`,
  ];

  if (url) {
    lines.push(url);
  }

  if (warning) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join('\n');
}

function formatSetOpTimeMessage(payload, actorMention) {
  const op = payload?.op || {};
  const code = cleanOpCode(op.code) || 'BH-????';
  const title = cleanText(op.title) || 'Untitled Operation';
  const url = cleanText(op.url);
  const previousAbsolute = formatDiscordAbsoluteTimestamp(payload?.previousStartTime) || 'Unknown';
  const previousRelative = formatDiscordRelativeTimestamp(payload?.previousStartTime);
  const nextAbsolute = formatDiscordAbsoluteTimestamp(payload?.newStartTime) || 'Unknown';
  const nextRelative = formatDiscordRelativeTimestamp(payload?.newStartTime);
  const localPreview = cleanText(payload?.localPreview);
  const profileTimezone = cleanText(payload?.actorProfileTimezone);
  const warning = cleanText(payload?.warning);

  const lines = [
    `**${code}** · **${title}**`,
    payload?.noChange
      ? `No change — start time is already **${nextAbsolute}**.`
      : `Start time changed by ${actorMention}.`,
    `From: ${previousAbsolute}${previousRelative ? ` (${previousRelative})` : ''}`,
    `To: ${nextAbsolute}${nextRelative ? ` (${nextRelative})` : ''}`,
  ];

  if (localPreview) {
    lines.push(`Entered as local: **${localPreview}**${profileTimezone ? ` (${profileTimezone})` : ''}`);
  }

  if (url) {
    lines.push(url);
  }

  if (warning) {
    lines.push(`Warning: ${warning}`);
  }

  return lines.join('\n');
}

function formatDiscordAbsoluteTimestamp(value) {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  const timestamp = Date.parse(cleaned);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return `<t:${Math.floor(timestamp / 1000)}:F>`;
}

function buildOpsReminderEmbed(op, windowMinutes) {
  const startAbsolute = formatDiscordAbsoluteTimestamp(op?.startTime) || 'Unknown';
  const startRelative = formatDiscordRelativeTimestamp(op?.startTime) || 'soon';
  const goingCount = Number(op?.counts?.going || 0);
  const tentativeCount = Number(op?.counts?.tentative || 0);
  const totalCount = Number(op?.counts?.total || goingCount + tentativeCount);
  const rolesNeeded = Array.isArray(op?.rolesNeeded) && op.rolesNeeded.length
    ? truncateText(op.rolesNeeded.join(', '), 1024)
    : 'None listed';
  const stagingLocation = truncateText(op?.stagingLocation || '', 1024);
  const stagingText = stagingLocation || 'the staging location';
  const prepLine = `You should start preparing and moving to ${stagingLocation ? `**${stagingText}**` : stagingText} about **${opsReminderStagingLeadMinutes} minutes prior** so the op can begin on time.`;

  const embed = new EmbedBuilder()
    .setTitle(truncateText(formatOpDisplayTitle(op?.opCode, op?.title), 256))
    .setURL(cleanText(op?.url) || null)
    .setAuthor({ name: 'Black Hull Ops Reminder' })
    .setDescription(`Starts ${startRelative} (${startAbsolute}).\n\n${prepLine}`)
    .setFooter({ text: `${formatReminderLabel(windowMinutes)} reminder` });

  const parsedDate = op?.startTime ? Date.parse(op.startTime) : NaN;
  if (!Number.isNaN(parsedDate)) {
    embed.setTimestamp(new Date(parsedDate));
  }

  embed.addFields(
    { name: 'Op Code', value: cleanOpCode(op?.opCode) || 'Pending', inline: true },
    { name: 'Type', value: cleanText(op?.opType) || 'Operation', inline: true },
    { name: 'Lead', value: truncateText(op?.leadName || 'Unknown Lead', 1024) || 'Unknown Lead', inline: true },
    { name: 'Stack', value: `${totalCount} total • ${goingCount} going • ${tentativeCount} tentative`, inline: true },
    { name: 'Sanction', value: op?.officialOp ? 'Official op' : 'Member-led op', inline: true },
    { name: 'Region', value: cleanText(op?.serverRegion) || 'North America', inline: true },
    { name: 'Status', value: cleanText(op?.status || 'planned').toUpperCase(), inline: true },
    { name: 'Roles Needed', value: rolesNeeded, inline: false },
  );

  if (stagingLocation) {
    embed.addFields({ name: 'Staging', value: stagingLocation, inline: false });
  }

  if (cleanText(op?.url)) {
    embed.addFields({ name: 'Open in Site', value: cleanText(op.url), inline: false });
  }

  return embed;
}

async function deleteTrackedOpsReminderMessages(channel, entry, keepWindows = []) {
  const keepSet = new Set((Array.isArray(keepWindows) ? keepWindows : []).map((value) => cleanText(value)).filter(Boolean));
  const remaining = [];

  for (const message of Array.isArray(entry?.messages) ? entry.messages : []) {
    const windowKey = cleanText(message?.window);
    const messageId = cleanText(message?.messageId);
    if (!windowKey || !messageId) {
      continue;
    }

    if (keepSet.has(windowKey)) {
      remaining.push({ window: windowKey, messageId });
      continue;
    }

    try {
      await channel.messages.delete(messageId);
    } catch (error) {
      if (error?.code !== 10008) {
        console.error(`Failed to delete ops reminder message ${messageId}:`, error.message || error);
      }
    }
  }

  return remaining;
}

async function trackOpsReminderMessage({ channel, opId, startTime, timingKey, sentMessage, markSent = false }) {
  const cleanedOpId = cleanText(opId);
  const cleanedStartTime = cleanText(startTime);
  const windowKey = cleanText(timingKey);
  const messageId = cleanText(sentMessage?.id);
  if (!channel?.isTextBased?.() || !cleanedOpId || !cleanedStartTime || !windowKey || !messageId) {
    return;
  }

  const state = readOpsReminderState();
  const nextState = normalizeOpsReminderState(state);
  let entry = nextState.reminders[cleanedOpId] || { startTime: cleanedStartTime, sent: [], messages: [] };

  if (cleanText(entry.startTime) !== cleanedStartTime) {
    await deleteTrackedOpsReminderMessages(channel, entry);
    entry = { startTime: cleanedStartTime, sent: [], messages: [] };
  }

  await deleteTrackedOpsReminderMessages(channel, entry);

  const sent = markSent
    ? [...new Set((Array.isArray(entry.sent) ? entry.sent : []).map((value) => cleanText(value)).filter(Boolean).concat(windowKey))].sort((left, right) => Number(right) - Number(left))
    : Array.isArray(entry.sent)
      ? [...new Set(entry.sent.map((value) => cleanText(value)).filter(Boolean))].sort((left, right) => Number(right) - Number(left))
      : [];

  nextState.reminders[cleanedOpId] = {
    startTime: cleanedStartTime,
    sent,
    messages: [{ window: windowKey, messageId }],
  };
  nextState.initialized = true;
  writeOpsReminderState(nextState);
}

let opsReminderPollTimer = null;
let opsReminderPollInFlight = false;
let lastOpsReminderPollAttemptAt = null;
let lastOpsReminderPollSucceededAt = null;
let lastOpsReminderPollError = '';
let internalApiStartedAt = null;
let lastSystemHeartbeatAt = null;
let lastSystemHeartbeatError = '';

async function pollOpsReminders(client, { startup = false, throwOnError = false } = {}) {
  if (!opsReminderChannelId) {
    return { ok: false, skipped: true, reason: 'OPS_REMINDER_CHANNEL_ID is not configured.' };
  }

  if (opsReminderPollInFlight) {
    return { ok: false, skipped: true, reason: 'Ops reminder poll is already in flight.' };
  }

  opsReminderPollInFlight = true;
  lastOpsReminderPollAttemptAt = new Date().toISOString();

  try {
    if (!client?.isReady?.()) {
      throw new Error('Discord client is not ready.');
    }

    const channel = await client.channels.fetch(opsReminderChannelId);
    if (!channel?.isTextBased?.()) {
      throw new Error(`Ops reminder channel is not text-based: ${opsReminderChannelId}`);
    }

    const payload = await fetchOpsReminderFeed();
    const ops = Array.isArray(payload?.ops) ? payload.ops : [];
    const nowMs = Date.now();
    const state = readOpsReminderState();
    const previousCheckMs = Date.parse(state.lastCheckedAt) || nowMs;
    const nextState = normalizeOpsReminderState(state);
    const currentOpIds = new Set();
    const duePosts = [];

    for (const op of ops) {
      const opId = cleanText(op?.id);
      const startTime = cleanText(op?.startTime);
      const startMs = Date.parse(startTime);
      if (!opId || !startTime || Number.isNaN(startMs)) {
        continue;
      }

      currentOpIds.add(opId);
      let entry = nextState.reminders[opId] || { startTime, sent: [], messages: [] };

      if (cleanText(entry.startTime) !== startTime) {
        await deleteTrackedOpsReminderMessages(channel, entry);
        entry = { startTime, sent: [], messages: [] };
      }

      const sentSet = new Set(Array.isArray(entry.sent) ? entry.sent.map((value) => cleanText(value)).filter(Boolean) : []);

      for (const windowMinutes of opsReminderWindowMinutes) {
        const windowKey = String(windowMinutes);
        if (sentSet.has(windowKey)) {
          continue;
        }

        const dueMs = startMs - windowMinutes * 60 * 1000;

        if (!nextState.initialized) {
          if (dueMs <= nowMs) {
            sentSet.add(windowKey);
          }
          continue;
        }

        if (dueMs <= previousCheckMs) {
          sentSet.add(windowKey);
          continue;
        }

        if (dueMs <= nowMs) {
          sentSet.add(windowKey);
          duePosts.push({ op, opId, windowMinutes, dueMs, startMs });
        }
      }

      nextState.reminders[opId] = {
        startTime,
        sent: [...sentSet].sort((left, right) => Number(right) - Number(left)),
        messages: normalizeOpsReminderMessageEntries(entry.messages),
      };
    }

    for (const [opId, entry] of Object.entries(nextState.reminders)) {
      if (currentOpIds.has(opId)) {
        continue;
      }

      await deleteTrackedOpsReminderMessages(channel, entry);
      delete nextState.reminders[opId];
    }

    if (!nextState.initialized) {
      nextState.initialized = true;
      writeOpsReminderState(nextState);
      console.log(`Ops reminder watcher seeded with ${ops.length} upcoming op(s).`);
      lastOpsReminderPollSucceededAt = new Date().toISOString();
      lastOpsReminderPollError = '';
      return { ok: true, seeded: true, startup, postedCount: 0, opCount: ops.length };
    }

    duePosts.sort((left, right) => {
      if (left.dueMs !== right.dueMs) {
        return left.dueMs - right.dueMs;
      }
      return left.startMs - right.startMs;
    });

    for (const post of duePosts) {
      const entry = nextState.reminders[post.opId] || { startTime: cleanText(post.op?.startTime), sent: [], messages: [] };
      const sentMessage = await channel.send({
        content: `@here **Black Hull Ops Reminder — ${formatReminderWindowLabel(post.windowMinutes)} call — ${cleanOpCode(post.op?.opCode) || 'BH-????'}**`,
        allowedMentions: { parse: ['everyone'] },
        embeds: [buildOpsReminderEmbed(post.op, post.windowMinutes)],
      });

      await trackOpsReminderMessage({
        channel,
        opId: post.opId,
        startTime: cleanText(post.op?.startTime),
        timingKey: String(post.windowMinutes),
        sentMessage,
        markSent: true,
      });

      nextState.reminders[post.opId] = normalizeOpsReminderState(readOpsReminderState()).reminders[post.opId] || {
        startTime: cleanText(post.op?.startTime),
        sent: [String(post.windowMinutes)],
        messages: [{ window: String(post.windowMinutes), messageId: sentMessage.id }],
      };
    }

    if (duePosts.length) {
      nextState.lastPostedAt = new Date().toISOString();
      console.log(`Posted ${duePosts.length} ops reminder(s)${startup ? ' during startup check' : ''}.`);
    }

    writeOpsReminderState(nextState);
    lastOpsReminderPollSucceededAt = new Date().toISOString();
    lastOpsReminderPollError = '';
    return { ok: true, seeded: false, startup, postedCount: duePosts.length, opCount: ops.length };
  } catch (error) {
    lastOpsReminderPollError = error?.message || String(error);
    console.error('Ops reminder watcher error:', error.message || error);
    if (throwOnError) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    return { ok: false, error: lastOpsReminderPollError };
  } finally {
    opsReminderPollInFlight = false;
  }
}

async function startOpsReminderWatcher(client) {
  if (!opsReminderChannelId) {
    if (opsReminderPollTimer) {
      clearInterval(opsReminderPollTimer);
      opsReminderPollTimer = null;
    }
    console.log('Ops reminder watcher disabled (OPS_REMINDER_CHANNEL_ID is not configured).');
    return;
  }

  if (opsReminderPollTimer) {
    clearInterval(opsReminderPollTimer);
    opsReminderPollTimer = null;
  }

  await pollOpsReminders(client, { startup: true });
  opsReminderPollTimer = setInterval(() => {
    pollOpsReminders(client).catch((error) => {
      console.error('Ops reminder interval error:', error.message || error);
    });
  }, opsReminderPollMinutes * 60 * 1000);
}

async function runSystemHeartbeatRecoveryAction(client) {
  const heartbeat = await postSystemHeartbeat(client);
  return {
    message: 'System heartbeat refreshed.',
    services: heartbeat.services,
    sentAt: heartbeat.nowIso,
  };
}

async function runOpsReminderPollRecoveryAction(client) {
  const poll = await pollOpsReminders(client, { throwOnError: true });
  const heartbeat = await postSystemHeartbeat(client);

  return {
    message: poll?.seeded
      ? `Ops reminder watcher reseeded against ${poll.opCount || 0} upcoming op(s).`
      : poll?.postedCount > 0
        ? `Ops reminder poll posted ${poll.postedCount} reminder(s).`
        : 'Ops reminder poll completed with no due reminders.',
    poll,
    services: heartbeat.services,
    sentAt: heartbeat.nowIso,
  };
}

function formatDuration(secondsInput) {
  const totalSeconds = Math.max(0, Math.floor(Number(secondsInput) || 0));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatPlayerStatus(status) {
  switch (status) {
    case AudioPlayerStatus.Playing:
      return 'Playing';
    case AudioPlayerStatus.Buffering:
      return 'Buffering';
    case AudioPlayerStatus.Idle:
      return 'Idle';
    case AudioPlayerStatus.AutoPaused:
      return 'Auto-paused';
    case AudioPlayerStatus.Paused:
      return 'Paused';
    default:
      return cleanText(status) || 'Unknown';
  }
}

function formatVoiceStatus() {
  const connectionStatus = connection?.state?.status;
  if (!connection || !connectionStatus) {
    return 'Disconnected';
  }

  if (connectionStatus === VoiceConnectionStatus.Ready) {
    const connectedChannelId = connection.joinConfig?.channelId;
    return connectedChannelId ? `Connected to <#${connectedChannelId}>` : 'Connected';
  }

  return `Connecting (${connectionStatus})`;
}

function formatStatusTimestamp(value) {
  const absolute = formatDiscordAbsoluteTimestamp(value);
  const relative = formatDiscordRelativeTimestamp(value);

  if (!absolute) {
    return 'Never';
  }

  return relative ? `${absolute} (${relative})` : absolute;
}

function formatStatusIndicator(ok) {
  return ok ? 'Healthy' : 'Failing';
}

async function collectWebsiteIntegrationStatus() {
  if (!siteBaseUrl) {
    return {
      configured: false,
      hostLabel: 'Not configured',
      lines: ['Website integration: **Not configured**', 'Set `BHS_SITE_BASE_URL` to enable website checks.'],
    };
  }

  if (!siteSharedSecret) {
    return {
      configured: false,
      hostLabel: siteBaseUrl,
      lines: ['Website integration: **Partially configured**', 'Shared secret missing. Set `BHS_SITE_SHARED_SECRET` or `MEDIA_SYNC_SHARED_SECRET`.'],
    };
  }

  const hostLabel = (() => {
    try {
      return new URL(siteBaseUrl).host || siteBaseUrl;
    } catch {
      return siteBaseUrl;
    }
  })();

  const checks = [
    {
      label: 'Shared ship catalog',
      run: async () => {
        await fetchFleetSummary();
        return 'Reachable';
      },
    },
    {
      label: 'Ops reminder feed',
      run: async () => {
        await fetchSiteJson('/api/internal/ops-reminders', { lookaheadDays: '1' });
        return 'Reachable';
      },
    },
    {
      label: 'Op admin feed',
      run: async () => 'Actor-scoped (not background-tested)',
    },
  ];

  const settled = await Promise.allSettled(checks.map((check) => check.run()));
  const failed = settled.filter((result) => result.status === 'rejected');
  const overallHealthy = failed.length === 0;
  const lines = [
    `Website integration: **${formatStatusIndicator(overallHealthy)}**`,
    `Site: **${hostLabel}**`,
  ];

  settled.forEach((result, index) => {
    const label = checks[index].label;
    if (result.status === 'fulfilled') {
      lines.push(`- ${label}: **${truncateText(result.value || 'Reachable', 120)}**`);
      return;
    }

    lines.push(`- ${label}: **Failing** — ${truncateText(result.reason?.message || String(result.reason), 120)}`);
  });

  lines.push(`Ops reminder watcher: **${lastOpsReminderPollError ? 'Warning' : 'Healthy'}**`);
  lines.push(`- Last attempt: ${formatStatusTimestamp(lastOpsReminderPollAttemptAt)}`);
  lines.push(`- Last success: ${formatStatusTimestamp(lastOpsReminderPollSucceededAt)}`);
  if (lastOpsReminderPollError) {
    lines.push(`- Last error: ${truncateText(lastOpsReminderPollError, 120)}`);
  }

  return {
    configured: true,
    hostLabel,
    lines,
  };
}

async function formatBotStatusMessage(client) {
  const nowPlaying = currentTrack ? `**${displayName(currentTrack)}**` : 'Nothing playing';
  const requester = currentRequestedBy ? `Requested by: **${truncateText(currentRequestedBy, 60)}**` : 'Requested by: **Radio shuffle**';
  const queueCount = requestQueue.length;
  const shuffleRemaining = shuffleQueue.length;
  const libraryCount = (() => {
    try {
      return readLibrary().length;
    } catch {
      return null;
    }
  })();

  const apiState = client?.isReady?.() ? `Healthy (port ${mediaSyncPort})` : 'Not ready';
  const integration = await collectWebsiteIntegrationStatus();

  const lines = [
    '**Black Hull Broadcast status**',
    `Bot: **${client?.isReady?.() ? 'Online' : 'Starting'}**`,
    `Voice: **${formatVoiceStatus()}**`,
    `Player: **${formatPlayerStatus(player.state.status)}**`,
    `Now playing: ${nowPlaying}`,
    requester,
    `Queued requests: **${queueCount}**`,
    `Shuffle remaining: **${shuffleRemaining}**`,
    `Library tracks: **${libraryCount == null ? 'Unavailable' : libraryCount}**`,
    `Internal API: **${apiState}**`,
    `RSI Comm-Link: **<#${rsiNewsChannelId}> every ${rsiNewsPollMinutes}m**`,
    `RSI Status: **<#${rsiStatusChannelId}> every ${rsiStatusPollMinutes}m**`,
    `RSI Patch Notes: **<#${rsiPatchNotesChannelId}> every ${rsiPatchNotesPollMinutes}m**`,
    opsReminderChannelId
      ? `Ops reminders: **<#${opsReminderChannelId}> at ${formatReminderWindowSummary(opsReminderWindowMinutes)} • poll ${opsReminderPollMinutes}m • @here**`
      : 'Ops reminders: **Disabled (set OPS_REMINDER_CHANNEL_ID)**',
    `Uptime: **${formatDuration(process.uptime())}**`,
    '',
    '**Website integration**',
    ...integration.lines,
  ];

  return lines.join('\n');
}

function appendLineWithinLimit(lines, line, maxLength = 1800) {
  const nextLength = `${lines.join('\n')}\n${line}`.trim().length;
  if (nextLength > maxLength) {
    return false;
  }

  lines.push(line);
  return true;
}

function appendLimitedItems(lines, itemLines, overflowBuilder, maxLength = 1800) {
  let hiddenCount = 0;

  for (let index = 0; index < itemLines.length; index += 1) {
    const line = itemLines[index];
    if (!appendLineWithinLimit(lines, line, maxLength)) {
      hiddenCount = itemLines.length - index;
      break;
    }
  }

  if (hiddenCount > 0) {
    const overflowLine = overflowBuilder(hiddenCount);
    if (!appendLineWithinLimit(lines, overflowLine, maxLength) && lines.length > 0) {
      const removed = lines.pop();
      if (removed) {
        appendLineWithinLimit(lines, overflowLine, maxLength);
      }
    }
  }
}

async function getInteractionVoiceChannel(interaction) {
  const fallbackMember = interaction.member;
  const member = fallbackMember?.voice
    ? fallbackMember
    : await interaction.guild.members.fetch(interaction.user.id);

  const voiceChannel = member?.voice?.channel || null;
  return voiceChannel && voiceChannel.isVoiceBased() ? voiceChannel : null;
}

function getMissingVoicePermissions(channel, member) {
  const requiredPermissions = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
  ];

  const permissions = channel?.permissionsFor(member);
  if (!permissions) {
    return requiredPermissions;
  }

  return permissions.missing(requiredPermissions);
}

function formatMemberShipsMessage(member) {
  const display = cleanText(member?.displayName) || 'Unknown Member';
  const rsiName = cleanText(member?.rsiName);
  const ships = Array.isArray(member?.ships) ? member.ships : [];

  const lines = [`**Ships on file — ${display}**`];
  if (rsiName && normalizeText(rsiName) !== normalizeText(display)) {
    lines.push(`RSI: **${rsiName}**`);
  }

  if (!ships.length) {
    lines.push('No ships are on file in My File right now.');
    return lines.join('\n');
  }

  lines.push(`Total hulls on file: **${ships.length}**`);
  lines.push('');

  const shipLines = ships.map((ship, index) => `${index + 1}. ${ship}`);
  appendLimitedItems(lines, shipLines, (hiddenCount) => `…and ${hiddenCount} more hull${hiddenCount === 1 ? '' : 's'}.`);

  return lines.join('\n');
}

function formatFleetSummaryMessage(payload) {
  const ships = Array.isArray(payload?.ships) ? payload.ships : [];
  const totalOwners = Number(payload?.totalOwners || 0);
  const totalHulls = Number(payload?.totalHulls || 0);
  const uniqueShips = Number(payload?.uniqueShips || ships.length || 0);

  const lines = [
    '**Fleet summary**',
    `Active owners on file: **${totalOwners}**`,
    `Total hulls on file: **${totalHulls}**`,
    `Unique ship types: **${uniqueShips}**`,
  ];

  if (!ships.length) {
    lines.push('No ships are on file yet.');
    return lines.join('\n');
  }

  lines.push('Use `/fleet ship` to see owners for one hull.');
  lines.push('');

  const shipLines = ships.map((ship, index) => {
    const count = Number(ship?.count || 0);
    const ownerCount = Number(ship?.ownerCount || 0);
    const ownerText = ownerCount === 1 ? '1 owner' : `${ownerCount} owners`;
    const hullText = count === 1 ? '1 hull' : `${count} hulls`;
    return `${index + 1}. ${ship.name} — ${hullText} • ${ownerText}`;
  });

  appendLimitedItems(lines, shipLines, (hiddenCount) => `…and ${hiddenCount} more ship type${hiddenCount === 1 ? '' : 's'}.`);

  return lines.join('\n');
}

function formatFleetShipDetailMessage(payload, requestedShip) {
  const matchType = cleanText(payload?.matchType);
  const query = cleanText(payload?.query) || cleanText(requestedShip);

  if (matchType === 'none') {
    return `No fleet match found for **${query}**. Start typing in \`/fleet ship\` and pick a suggestion.`;
  }

  if (matchType === 'multiple') {
    const matches = Array.isArray(payload?.matches) ? payload.matches : [];
    if (!matches.length) {
      return `More than one ship matched **${query}**. Try a more specific term.`;
    }

    const lines = [`More than one ship matched **${query}**. Try one of these exact names:`];
    const matchLines = matches.slice(0, 10).map((ship, index) => {
      const count = Number(ship?.count || 0);
      const ownerCount = Number(ship?.ownerCount || 0);
      return `${index + 1}. ${ship.name} — ${count === 1 ? '1 hull' : `${count} hulls`} • ${ownerCount === 1 ? '1 owner' : `${ownerCount} owners`}`;
    });
    appendLimitedItems(lines, matchLines, (hiddenCount) => `…and ${hiddenCount} more possible match${hiddenCount === 1 ? '' : 'es'}.`);
    return lines.join('\n');
  }

  const ship = payload?.ship;
  if (!ship) {
    return `No fleet match found for **${query}**. Start typing in \`/fleet ship\` and pick a suggestion.`;
  }

  const owners = Array.isArray(ship?.owners) ? ship.owners : [];
  const lines = [
    `**Owners — ${ship.name}**`,
    `Total owned: **${Number(ship?.count || 0)}**`,
    `Owners on file: **${owners.length}**`,
    '',
  ];

  if (!owners.length) {
    lines.push('No owners are on file for that hull right now.');
    return lines.join('\n');
  }

  const ownerLines = owners.map((owner, index) => `${index + 1}. ${cleanText(owner?.displayName) || 'Unknown Member'}`);
  appendLimitedItems(lines, ownerLines, (hiddenCount) => `…and ${hiddenCount} more owner${hiddenCount === 1 ? '' : 's'}.`);

  return lines.join('\n');
}

function formatRosterSectionLines(title, members) {
  const lines = [`**${title}**`];

  if (!members.length) {
    lines.push('None on file.');
    return lines;
  }

  const memberLines = members.map((member, index) => {
    const rank = cleanText(member?.rankTitle) || 'Member';
    const name = cleanText(member?.displayName) || 'Unknown Member';
    return `${index + 1}. ${rank} — ${name}`;
  });

  appendLimitedItems(lines, memberLines, (hiddenCount) => `…and ${hiddenCount} more member${hiddenCount === 1 ? '' : 's'}.`);
  return lines;
}

function formatRosterMessage(payload, requestedStatus) {
  const status = cleanText(payload?.status) || cleanText(requestedStatus) || 'all';
  const activeCount = Number(payload?.activeCount || 0);
  const inactiveCount = Number(payload?.inactiveCount || 0);

  if (status === 'active') {
    const members = Array.isArray(payload?.members) ? payload.members : [];
    const lines = [
      '**Roster — Active**',
      `Active on file: **${activeCount}**`,
      `Inactive on file: **${inactiveCount}**`,
      '',
      ...formatRosterSectionLines('Active', members),
    ];
    return lines.join('\n');
  }

  if (status === 'inactive') {
    const members = Array.isArray(payload?.members) ? payload.members : [];
    const lines = [
      '**Roster — Inactive / Reserve**',
      `Active on file: **${activeCount}**`,
      `Inactive on file: **${inactiveCount}**`,
      '',
      ...formatRosterSectionLines('Inactive / Reserve', members),
    ];
    return lines.join('\n');
  }

  const active = Array.isArray(payload?.active) ? payload.active : [];
  const inactive = Array.isArray(payload?.inactive) ? payload.inactive : [];
  const lines = [
    '**Roster**',
    `Active on file: **${activeCount}**`,
    `Inactive on file: **${inactiveCount}**`,
    'Removed members are excluded.',
    'Use `/fleet roster status:active` or `/fleet roster status:inactive` for one side only.',
    '',
    ...formatRosterSectionLines('Active', active),
    '',
    ...formatRosterSectionLines('Inactive / Reserve', inactive),
  ];

  return lines.join('\n');
}


function formatDiscordRelativeTimestamp(value) {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  const timestamp = Date.parse(cleaned);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function formatAdminQueueItemPrefix(index, title) {
  return `${index + 1}. **${truncateText(title, 90) || 'Untitled'}**`;
}

function formatAdminQueueMessage(payload) {
  const totals = payload?.totals || {};
  const pendingMedia = Array.isArray(payload?.pendingMedia) ? payload.pendingMedia : [];
  const mediaSyncErrors = Array.isArray(payload?.mediaSyncErrors) ? payload.mediaSyncErrors : [];
  const removedMembers = Array.isArray(payload?.removedMembers) ? payload.removedMembers : [];
  const pendingRecruitment = Array.isArray(payload?.pendingRecruitment) ? payload.pendingRecruitment : [];
  const recruitingApplications = Array.isArray(payload?.recruitingApplications) ? payload.recruitingApplications : [];

  const pendingCount = Number(totals.pendingMedia || 0);
  const syncErrorCount = Number(totals.mediaSyncErrors || 0);
  const removedCount = Number(totals.removedMembers || 0);
  const pendingRecruitmentCount = Number(totals.pendingRecruitment || 0);
  const recruitingCount = Number(totals.recruitingApplications || 0);
  const attentionItems = Number(
    totals.attentionItems || pendingCount + syncErrorCount + removedCount + pendingRecruitmentCount + recruitingCount
  );
  const removedWindowDays = Number(payload?.windows?.removedMembersDays || 14);
  const adminUrl = siteBaseUrl ? `${siteBaseUrl}/members/admin` : null;
  const recruitmentUrl = siteBaseUrl ? `${siteBaseUrl}/members/recruitment` : null;

  const lines = [
    '**Admin queue**',
    `Items needing eyes: **${attentionItems}**`,
    `Pending media approvals: **${pendingCount}**`,
    `Media sync failures: **${syncErrorCount}**`,
    `Pending applications: **${pendingRecruitmentCount}**`,
    `Recruiting files: **${recruitingCount}**`,
    `Recent removed members (${removedWindowDays}d): **${removedCount}**`,
  ];

  if (attentionItems === 0) {
    lines.push('Nothing is waiting on staff attention right now.');
    if (adminUrl) {
      lines.push(`Website admin deck: ${adminUrl}`);
    }
    return lines.join('\n');
  }

  if (pendingCount > 0) {
    lines.push('');
    lines.push('**Pending media approvals**');

    const itemLines = pendingMedia.map((item, index) => {
      const submittedAt = formatDiscordRelativeTimestamp(item?.createdAt);
      const submittedBy = truncateText(item?.submittedByName || 'Unknown Member', 40);
      return `${formatAdminQueueItemPrefix(index, item?.title)} — ${submittedBy}${submittedAt ? ` • ${submittedAt}` : ''}`;
    });

    appendLimitedItems(lines, itemLines, (hiddenCount) => `…and ${hiddenCount} more pending media item${hiddenCount === 1 ? '' : 's'}.`);
  }

  if (syncErrorCount > 0) {
    lines.push('');
    lines.push('**Media sync failures**');

    const itemLines = mediaSyncErrors.map((item, index) => {
      const timestamp = formatDiscordRelativeTimestamp(item?.reviewedAt || item?.createdAt);
      const errorText = truncateText(item?.error || 'Unknown Discord sync error.', 85);
      return `${formatAdminQueueItemPrefix(index, item?.title)} — ${errorText}${timestamp ? ` • ${timestamp}` : ''}`;
    });

    appendLimitedItems(lines, itemLines, (hiddenCount) => `…and ${hiddenCount} more sync failure${hiddenCount === 1 ? '' : 's'}.`);
    lines.push('Retry failed media syncs from the website command deck, not from Discord.');
  }

  if (pendingRecruitmentCount > 0) {
    lines.push('');
    lines.push('**Pending applications**');

    const itemLines = pendingRecruitment.map((item, index) => {
      const filedAt = formatDiscordRelativeTimestamp(item?.createdAt || item?.updatedAt);
      const rsi = truncateText(item?.rsiHandle || 'Unknown RSI', 32);
      const discordName = truncateText(item?.discordName || 'Unknown Discord', 32);
      const preferredRole = truncateText(item?.preferredRole || '', 32);
      return `${index + 1}. **${rsi}** — ${discordName}${preferredRole ? ` • ${preferredRole}` : ''}${filedAt ? ` • ${filedAt}` : ''}`;
    });

    appendLimitedItems(lines, itemLines, (hiddenCount) => `…and ${hiddenCount} more pending application${hiddenCount === 1 ? '' : 's'}.`);
  }

  if (recruitingCount > 0) {
    lines.push('');
    lines.push('**Recruiting files**');

    const itemLines = recruitingApplications.map((item, index) => {
      const updatedAt = formatDiscordRelativeTimestamp(item?.updatedAt || item?.createdAt);
      const rsi = truncateText(item?.rsiHandle || 'Unknown RSI', 32);
      const discordName = truncateText(item?.discordName || 'Unknown Discord', 32);
      const preferredRole = truncateText(item?.preferredRole || '', 32);
      return `${index + 1}. **${rsi}** — ${discordName}${preferredRole ? ` • ${preferredRole}` : ''}${updatedAt ? ` • ${updatedAt}` : ''}`;
    });

    appendLimitedItems(lines, itemLines, (hiddenCount) => `…and ${hiddenCount} more recruiting file${hiddenCount === 1 ? '' : 's'}.`);
  }

  if (removedCount > 0) {
    lines.push('');
    lines.push(`**Recent removed members (${removedWindowDays}d)**`);

    const itemLines = removedMembers.map((item, index) => {
      const removedAt = formatDiscordRelativeTimestamp(item?.removedAt);
      const rank = truncateText(item?.rankTitle || 'Member', 30);
      const name = truncateText(item?.displayName || 'Unknown Member', 40);
      const note = truncateText(item?.note || '', 70);
      return `${index + 1}. ${rank} — ${name}${note ? ` • Note: ${note}` : ''}${removedAt ? ` • ${removedAt}` : ''}`;
    });

    appendLimitedItems(lines, itemLines, (hiddenCount) => `…and ${hiddenCount} more recent removed member${hiddenCount === 1 ? '' : 's'}.`);
  }

  lines.push('');
  if (adminUrl) {
    lines.push(`Website admin deck: ${adminUrl}`);
  }
  if (recruitmentUrl) {
    lines.push(`Recruitment files: ${recruitmentUrl}`);
  }

  return lines.join('\n');
}

function formatYesNo(value) {
  return value ? '**Yes**' : '**No**';
}

function formatRoleNamesFromIds(guild, roleIds) {
  const ids = Array.isArray(roleIds) ? roleIds.map((roleId) => cleanText(roleId)).filter(Boolean) : [];
  if (!ids.length) {
    return 'None';
  }

  const names = ids.map((roleId) => cleanText(guild?.roles?.cache?.get(roleId)?.name) || `Unknown Role (${roleId})`);
  return names.join(', ');
}

function getAuthCheckReason(error, accessStatus) {
  if (accessStatus === 'authorized') {
    return 'Has an approved BHS access role.';
  }

  switch (cleanText(error)) {
    case 'removed_from_roster':
      return 'This Discord account is on the removed roster list. Website access stays blocked until staff clear that removal.';
    case 'removed_roster_check_failed':
      return 'The website could not verify the removed roster deny list right now.';
    case 'not_in_server':
      return 'This Discord account is not currently in the Black Hull server.';
    case 'not_authorized':
      return 'This Discord account is in the server but does not have an approved BHS access role.';
    case 'member_gate_not_configured':
      return 'The website member gate is not fully configured.';
    case 'member_gate_check_failed':
      return 'The website could not verify Discord membership right now.';
    default:
      return 'The website access check did not return a normal authorized result.';
  }
}


function formatRosterSectionLabel(section) {
  return cleanText(section) === 'inactive' ? 'Inactive / Reserve' : 'Active';
}

function summarizeSettledError(error, fallback) {
  const message = error instanceof Error ? error.message : cleanText(error) || fallback;
  return truncateText(message, 160) || fallback;
}

function formatMemberLookupMessage(statusPayload, targetUser, guild) {
  const authPayload = statusPayload?.authPayload || {};
  const memberPayload = statusPayload?.memberPayload || {};
  const removedPayload = statusPayload?.removedPayload || {};
  const authError = cleanText(statusPayload?.authError);
  const memberError = cleanText(statusPayload?.memberError);
  const removedError = cleanText(statusPayload?.removedError);
  const member = memberPayload?.member || {};
  const removedMember = removedPayload?.member || {};
  const authTarget = authPayload?.target || {};
  const found = !memberError && Boolean(memberPayload?.found);
  const discordId = cleanText(targetUser?.id) || cleanText(member.discordUserId) || cleanText(authTarget.discordUserId) || 'unknown';
  const targetName = cleanText(targetUser?.globalName) || cleanText(targetUser?.username) || cleanText(member.displayName) || cleanText(authTarget.globalName) || cleanText(authTarget.username) || 'Unknown Member';
  const accessStatus = authError ? 'unavailable' : cleanText(authPayload?.accessStatus) || 'unauthorized';
  const verdict = accessStatus === 'authorized'
    ? '**PASS**'
    : accessStatus === 'misconfigured'
      ? '**MISCONFIGURED**'
      : accessStatus === 'unavailable'
        ? '**UNAVAILABLE**'
        : '**BLOCKED**';
  const inServer = authError ? null : Boolean(authPayload?.inServer);
  const permissions = authPayload?.permissions || {};
  const matchedRoleIds = authPayload?.matchedRoleIds || {};
  const removedFromRoster = Boolean(member.removedFromRoster || authPayload?.removedFromRoster || removedMember.removed);
  const removedAt = formatDiscordRelativeTimestamp(member.removedAt || authPayload?.removedAt || removedMember.removedAt);
  const removedNote = truncateText(member.removedNote || authPayload?.removedNote || removedMember.note || '', 120);

  const lines = [
    `**Member lookup — ${targetName}**`,
    `User: <@${discordId}>`,
    `Discord ID: \`${discordId}\``,
    `In server: ${inServer === null ? 'Unavailable' : formatYesNo(inServer)}`,
    `Website access: ${verdict}`,
    `Reason: ${authError ? authError : getAuthCheckReason(authPayload?.error, accessStatus)}`,
    `Website file: ${memberError ? '**Unavailable**' : found ? '**Found**' : '**Not found**'}`,
    `Removed roster override: ${removedError ? 'Unavailable' : formatYesNo(removedFromRoster)}`,
    `Role flags: ${authError ? 'Unavailable' : `Admin ${formatYesNo(Boolean(permissions.isAdmin))} • Officer ${formatYesNo(Boolean(permissions.isOfficer))}`}`,
    `Matched access roles: ${authError ? 'Unavailable' : formatRoleNamesFromIds(guild, matchedRoleIds.allowed)}`,
  ];

  if (removedFromRoster) {
    lines.push(`Removed at: ${removedAt || 'Recorded on site'}`);
    if (removedNote) {
      lines.push(`Removal note: ${removedNote}`);
    }
  }

  const warnings = [];
  if (authError) warnings.push(`Auth check unavailable: ${authError}`);
  if (memberError) warnings.push(`Website file lookup unavailable: ${memberError}`);
  if (removedError) warnings.push(`Removed-roster lookup unavailable: ${removedError}`);
  if (warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (memberError) {
    return lines.join('\n');
  }

  if (!found) {
    lines.push('No website profile is on file for this Discord account yet.');
    return lines.join('\n');
  }

  const displayName = cleanText(member.displayName) || targetName;
  const rsiName = cleanText(member.rsiName);
  const discordName = cleanText(member.discordName);
  const rankTitle = cleanText(member.rankTitle) || 'Member';
  const rosterSection = formatRosterSectionLabel(member.rosterSection);
  const membershipStatus = cleanText(member.membershipStatus) || 'Not set';
  const timezone = cleanText(member.timezone) || 'Not set';
  const serverRegion = cleanText(member.serverRegion) || 'Not set';
  const primaryRole = cleanText(member.primaryRole) || 'Not set';
  const roles = Array.isArray(member.roles) ? member.roles.filter(Boolean) : [];
  const ships = Array.isArray(member.ships) ? member.ships.filter(Boolean) : [];
  const availability = truncateText(member.availability || '', 120) || 'Not set';
  const bio = truncateText(member.bio || '', 140) || 'Not set';

  lines.push(`Display name: **${displayName}**`);
  if (rsiName && normalizeText(rsiName) !== normalizeText(displayName)) {
    lines.push(`RSI: **${rsiName}**`);
  }
  if (discordName && normalizeText(discordName) !== normalizeText(displayName)) {
    lines.push(`Discord name: **${discordName}**`);
  }
  lines.push(`Roster: **${rankTitle} — ${rosterSection}**`);
  lines.push(`Membership status: **${membershipStatus}**`);
  lines.push(`Primary role: **${primaryRole}**`);
  lines.push(`Timezone: **${timezone}**`);
  lines.push(`Region: **${serverRegion}**`);
  lines.push(`Crew status: **${member.willingToCrew ? 'Open to crew' : 'Own hull preferred'}**`);
  lines.push(`Roles on file: ${roles.length ? roles.join(', ') : 'None posted'}`);
  lines.push(`Ships on file: ${ships.length ? ships.join(', ') : 'None posted'}`);
  lines.push(`Availability: ${availability}`);
  lines.push(`Bio: ${bio}`);

  return lines.join('\n');
}

function formatRemovedMessage(payload, targetUser) {
  const mode = cleanText(payload?.mode) || 'list';

  if (mode === 'member') {
    const member = payload?.member || {};
    const discordId = cleanText(targetUser?.id) || cleanText(member.discordUserId) || 'unknown';
    const targetName = cleanText(targetUser?.globalName) || cleanText(targetUser?.username) || 'Unknown Member';
    const removed = Boolean(member.removed);
    const removedAt = formatDiscordRelativeTimestamp(member.removedAt);
    const note = truncateText(member.note || '', 140);
    const lines = [
      `**Removed roster check — ${targetName}**`,
      `User: <@${discordId}>`,
      `Discord ID: \`${discordId}\``,
      `Removed from roster: ${formatYesNo(removed)}`,
    ];

    if (!removed) {
      lines.push('No removed-roster record is on file for this Discord account.');
      return lines.join('\n');
    }

    const displayName = cleanText(member.displayName) || targetName;
    const rankTitle = cleanText(member.rankTitle) || 'Member';
    lines.push(`Website file: **${rankTitle} — ${displayName}**`);
    lines.push(`Removed at: ${removedAt || 'Recorded on site'}`);
    if (note) {
      lines.push(`Removal note: ${note}`);
    }

    return lines.join('\n');
  }

  const removedMembers = Array.isArray(payload?.removedMembers) ? payload.removedMembers : [];
  const totalRemoved = Number(payload?.totalRemoved || removedMembers.length || 0);
  const lines = [
    '**Removed roster pool**',
    `Total on file: **${totalRemoved}**`,
    'Use `/memberadmin removed member:@user` to inspect one current Discord member directly.',
  ];

  if (!removedMembers.length) {
    lines.push('No removed members are on file right now.');
    return lines.join('\n');
  }

  lines.push('');
  const itemLines = removedMembers.map((item, index) => {
    const rank = truncateText(item?.rankTitle || 'Member', 30);
    const name = truncateText(item?.displayName || 'Unknown Member', 40);
    const removedAt = formatDiscordRelativeTimestamp(item?.removedAt);
    const note = truncateText(item?.note || '', 70);
    return `${index + 1}. ${rank} — ${name}${note ? ` • Note: ${note}` : ''}${removedAt ? ` • ${removedAt}` : ''}`;
  });

  appendLimitedItems(lines, itemLines, (hiddenCount) => `…and ${hiddenCount} more removed member${hiddenCount === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

function formatAuthCheckMessage(payload, targetUser, guild) {
  const accessStatus = cleanText(payload?.accessStatus) || 'unauthorized';
  const inServer = Boolean(payload?.inServer);
  const permissions = payload?.permissions || {};
  const matchedRoleIds = payload?.matchedRoleIds || {};
  const target = payload?.target || {};
  const display = cleanText(targetUser?.globalName) || cleanText(targetUser?.username) || cleanText(target?.globalName) || cleanText(target?.username) || 'Unknown Member';
  const verdict = accessStatus === 'authorized' ? '**PASS**' : accessStatus === 'misconfigured' ? '**MISCONFIGURED**' : '**BLOCKED**';
  const removedFromRoster = Boolean(payload?.removedFromRoster);
  const removedAt = formatDiscordRelativeTimestamp(payload?.removedAt);
  const removedNote = truncateText(payload?.removedNote || '', 90);

  const lines = [
    `**Auth check — ${display}**`,
    `User: <@${cleanText(targetUser?.id) || cleanText(target?.discordUserId) || 'unknown'}>`,
    `Discord ID: \`${cleanText(targetUser?.id) || cleanText(target?.discordUserId) || 'unknown'}\``,
    `In server: ${formatYesNo(inServer)}`,
    `Website access: ${verdict}`,
    `Reason: ${getAuthCheckReason(payload?.error, accessStatus)}`,
    `Removed roster override: ${formatYesNo(removedFromRoster)}`,
    `Role flags: Admin ${formatYesNo(Boolean(permissions.isAdmin))} • Officer ${formatYesNo(Boolean(permissions.isOfficer))}`,
    `Matched access roles: ${formatRoleNamesFromIds(guild, matchedRoleIds.allowed)}`,
    `Matched officer roles: ${formatRoleNamesFromIds(guild, matchedRoleIds.officer)}`,
    `Matched admin roles: ${formatRoleNamesFromIds(guild, matchedRoleIds.admin)}`,
  ];

  if (removedFromRoster) {
    lines.push(`Removed at: ${removedAt || 'Recorded on site'}`);
    if (removedNote) {
      lines.push(`Removal note: ${removedNote}`);
    }
  }

  return lines.join('\n');
}

async function connectToVoiceChannel(channel) {
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('The selected channel is not a valid voice channel.');
  }

  if (connection) {
    try {
      connection.destroy();
    } catch {}
    connection = null;
  }

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      try {
        connection.destroy();
      } catch {}
      connection = null;
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  connection.subscribe(player);

  return channel;
}

player.on(AudioPlayerStatus.Idle, () => {
  try {
    if (!isVoiceConnectionReady()) {
      return;
    }
    playNext();
  } catch (error) {
    console.error('Playlist error:', error.message);
  }
});

player.on('error', (error) => {
  console.error('Player error:', error);
});

const commandBuilders = [
  new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Control radio playback in your current voice channel.')
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Join your voice channel and start radio shuffle.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('stop')
        .setDescription('Stop playback and disconnect from voice.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('nowplaying')
        .setDescription('Show the current track.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('skip')
        .setDescription('Skip the current track.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('queue')
        .setDescription('Show the next 5 tracks.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('library')
        .setDescription('Browse the radio library.')
        .addIntegerOption((option) =>
          option.setName('page').setDescription('Library page number').setMinValue(1)
        )
        .addStringOption((option) =>
          option.setName('search').setDescription('Search by track name')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('request')
        .setDescription('Queue a track from the local library to play next.')
        .addStringOption((option) =>
          option
            .setName('track')
            .setDescription('Track name to request')
            .setRequired(true)
        )
    ),
  buildRollCommand(),
  new SlashCommandBuilder()
    .setName('ops')
    .setDescription('Staff: operation management commands.')
    .addSubcommand((sub) =>
      sub
        .setName('state')
        .setDescription('Change an operation state by BH code.')
        .addStringOption((option) =>
          option
            .setName('code')
            .setDescription('BH op code, like BH-0123')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName('state')
            .setDescription('New operation state')
            .setRequired(true)
            .addChoices(
              { name: 'Planned', value: 'planned' },
              { name: 'Active', value: 'active' },
              { name: 'Completed', value: 'completed' },
              { name: 'Cancelled', value: 'cancelled' },
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('time')
        .setDescription('Change an operation start time by BH code using your profile timezone.')
        .addStringOption((option) =>
          option
            .setName('code')
            .setDescription('BH op code, like BH-0123')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption((option) =>
          option
            .setName('year')
            .setDescription('Local calendar year')
            .setRequired(true)
            .setMinValue(2024)
            .setMaxValue(2100)
        )
        .addIntegerOption((option) =>
          option
            .setName('month')
            .setDescription('Local calendar month')
            .setRequired(true)
            .addChoices(
              { name: 'January', value: 1 },
              { name: 'February', value: 2 },
              { name: 'March', value: 3 },
              { name: 'April', value: 4 },
              { name: 'May', value: 5 },
              { name: 'June', value: 6 },
              { name: 'July', value: 7 },
              { name: 'August', value: 8 },
              { name: 'September', value: 9 },
              { name: 'October', value: 10 },
              { name: 'November', value: 11 },
              { name: 'December', value: 12 },
            )
        )
        .addIntegerOption((option) =>
          option
            .setName('day')
            .setDescription('Local calendar day')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(31)
        )
        .addIntegerOption((option) =>
          option
            .setName('hour')
            .setDescription('Local hour in 24-hour time')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(23)
        )
        .addIntegerOption((option) =>
          option
            .setName('minute')
            .setDescription('Local minute')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(59)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remind')
        .setDescription('Post a manual ops reminder to Operations by BH code.')
        .addStringOption((option) =>
          option
            .setName('code')
            .setDescription('BH op code, like BH-0123')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option) =>
          option
            .setName('timing')
            .setDescription('Reminder style to post')
            .setRequired(true)
            .addChoices(
              { name: '24-hour reminder', value: '24h' },
              { name: '1-hour reminder', value: '1h' },
              { name: '15-minute reminder', value: '15m' },
              { name: 'Manual push', value: 'now' },
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('repost')
        .setDescription('Replace the tracked Discord op post with a fresh post by BH code.')
        .addStringOption((option) =>
          option
            .setName('code')
            .setDescription('BH op code, like BH-0123')
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),
  new SlashCommandBuilder()
    .setName('memberadmin')
    .setDescription('Staff/Admin member administration commands.')
    .addSubcommand((sub) =>
      sub
        .setName('setrank')
        .setDescription('Change a member website rank and sync non-Chief Discord roles, including Inactive.')
        .addUserOption((option) =>
          option
            .setName('member')
            .setDescription('Member to update')
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('rank')
            .setDescription('New org rank')
            .setRequired(true)
            .addChoices(
              { name: 'Captain', value: 'Captain' },
              { name: 'Enforcer', value: 'Enforcer' },
              { name: 'Patched', value: 'Patched' },
              { name: 'Soldier', value: 'Soldier' },
              { name: 'Thug', value: 'Thug' },
              { name: 'Inactive', value: 'Inactive' },
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('authcheck')
        .setDescription('Check whether a member should pass website access.')
        .addUserOption((option) =>
          option
            .setName('member')
            .setDescription('Member to inspect')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('lookup')
        .setDescription('Show the full staff member lookup for one member.')
        .addUserOption((option) =>
          option
            .setName('member')
            .setDescription('Member to inspect')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('removed')
        .setDescription('Show the removed roster pool or inspect one member.')
        .addUserOption((option) =>
          option
            .setName('member')
            .setDescription('Optional current Discord member to inspect')
            .setRequired(false)
        )
    ),
  new SlashCommandBuilder()
    .setName('fleet')
    .setDescription('Fleet and roster views.')
    .addSubcommand((sub) =>
      sub
        .setName('ships')
        .setDescription("Show a member's ships from My File.")
        .addUserOption((option) =>
          option
            .setName('member')
            .setDescription('Member to inspect')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('summary')
        .setDescription('Show the org fleet summary.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('ship')
        .setDescription('Show owners for a specific hull.')
        .addStringOption((option) =>
          option
            .setName('ship')
            .setDescription('Specific ship to inspect')
            .setAutocomplete(true)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('roster')
        .setDescription('Show the active and inactive roster from the website.')
        .addStringOption((option) =>
          option
            .setName('status')
            .setDescription('Optional roster section to show')
            .addChoices(
              { name: 'Active', value: 'active' },
              { name: 'Inactive / Reserve', value: 'inactive' }
            )
        )
    ),
  new SlashCommandBuilder()
    .setName('system')
    .setDescription('Staff/Admin system operations.')
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show the current health of Black Hull Broadcast.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('queue')
        .setDescription('Show the website attention queue for media, recruitment, and roster.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('restart')
        .setDescription('Restart Black Hull Broadcast through pm2.')
        .addStringOption((option) =>
          option
            .setName('confirm')
            .setDescription('Required confirmation value')
            .setRequired(true)
            .addChoices({ name: 'restart', value: 'restart' })
        )
    ),
  new SlashCommandBuilder()
    .setName('partykey')
    .setDescription('Admin: manage SnareHound party API keys.')
    .addSubcommand((sub) =>
      sub
        .setName('generate')
        .setDescription('Generate or replace a party API key for a member.')
        .addUserOption((option) =>
          option.setName('member').setDescription('Member to generate a key for').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke')
        .setDescription('Revoke a member\'s party API key.')
        .addUserOption((option) =>
          option.setName('member').setDescription('Member whose key to revoke').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('revokeall')
        .setDescription('Revoke all party API keys immediately.')
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the BHS activity leaderboard.')
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('Time period to show (default: this month)')
        .setRequired(false)
        .addChoices(
          { name: 'This month', value: 'month' },
          { name: 'All time',   value: 'alltime' },
        )
    ),
];

for (const command of commandBuilders) {
  command.setDMPermission(false);

  if (adminOnlyCommands.has(command.name)) {
    command.setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);
    continue;
  }

  if (staffOnlyCommands.has(command.name)) {
    command.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild);
  }
}

const commands = commandBuilders.map((command) => command.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(
      Routes.applicationGuildCommands(readyClient.user.id, guildId),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }

  try {
    await refreshBotRuntimeConfig();

    await startRsiCommLinkWatcher(readyClient);
    console.log('RSI Comm-Link watcher ready.');
    await startRsiStatusWatcher(readyClient);
    console.log('RSI Status watcher ready.');
    await startRsiPatchNotesWatcher(readyClient);
    console.log('RSI Patch Notes watcher ready.');
    await startOpsReminderWatcher(readyClient);
    if (opsReminderChannelId) {
      console.log('Ops reminder watcher ready.');
    }

    if (siteBaseUrl && siteSharedSecret) {
      await sendSystemHeartbeatSafe(readyClient);
      setInterval(() => {
        void sendSystemHeartbeatSafe(readyClient);
      }, systemHeartbeatMinutes * 60 * 1000);
      console.log(`System heartbeat reporter ready (${systemHeartbeatMinutes} minute interval).`);
    }

    // Resume voice and game sessions for members already active before this restart
    const guild = readyClient.guilds.cache.get(guildId);
    await activityTracker.resumeVoiceSessions(guild);
    await activityTracker.resumeGameSessions(guild);
  } catch (error) {
    console.error('Startup error:', error.message);
    process.exit(1);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const subcommand = (() => {
      try {
        return interaction.options.getSubcommand();
      } catch {
        return '';
      }
    })();

    const fleetAutocompleteAllowed =
      interaction.inGuild() &&
      interaction.guildId === guildId &&
      interaction.channelId === commandChannelId &&
      interaction.commandName === 'fleet' &&
      subcommand === 'ship';
    const opStateAutocompleteAllowed =
      interaction.inGuild() &&
      interaction.guildId === guildId &&
      interaction.channelId === adminCommandChannelId &&
      interaction.commandName === 'ops' &&
      (subcommand === 'state' || subcommand === 'time' || subcommand === 'remind' || subcommand === 'repost') &&
      canUseStaffCommand(interaction);

    if (!fleetAutocompleteAllowed && !opStateAutocompleteAllowed) {
      await interaction.respond([]);
      return;
    }

    try {
      const focused = interaction.options.getFocused(true);

      if (interaction.commandName === 'fleet' && subcommand === 'ship') {
        if (focused.name !== 'ship') {
          await interaction.respond([]);
          return;
        }

        const payload = await fetchFleetAutocomplete(focused.value);
        const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];

        await interaction.respond(
          suggestions.slice(0, 25).map((ship) => ({
            name: `${ship.name} (${Number(ship.count || 0)})`,
            value: ship.name,
          }))
        );
        return;
      }

      if (interaction.commandName === 'ops' && (subcommand === 'state' || subcommand === 'time' || subcommand === 'remind' || subcommand === 'repost')) {
        if (focused.name !== 'code') {
          await interaction.respond([]);
          return;
        }

        const payload = await fetchOpAdminAutocomplete(focused.value, interaction.user.id);
        const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
        const filteredSuggestions =
          subcommand === 'remind' || subcommand === 'repost'
            ? suggestions.filter((op) => {
                const status = cleanText(op?.status).toLowerCase();
                return status === 'planned' || status === 'active';
              })
            : suggestions;

        await interaction.respond(
          filteredSuggestions.slice(0, 25).map((op) => ({
            name: truncateText(cleanText(op.label) || formatOpDisplayTitle(op.code, op.title), 100),
            value: cleanOpCode(op.code),
          }))
        );
        return;
      }

      await interaction.respond([]);
    } catch (error) {
      console.error('Autocomplete error:', error);
      await interaction.respond([]);
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const ephemeralCommands = new Set(['radio', 'memberadmin', 'fleet', 'system', 'partykey']);

  if (!interaction.inGuild() || interaction.guildId !== guildId) {
    await interaction.reply({
      content: 'This bot only works inside the configured server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requiredChannelId = adminChannelCommands.has(interaction.commandName)
    ? adminCommandChannelId
    : memberChannelCommands.has(interaction.commandName)
      ? commandChannelId
      : commandChannelId;

  if (interaction.channelId !== requiredChannelId) {
    const channelLabel = requiredChannelId === adminCommandChannelId ? 'admin commands' : 'bot commands';
    await interaction.reply({
      content: `Use ${channelLabel} in <#${requiredChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    if (staffOnlyCommands.has(interaction.commandName) && !canUseStaffCommand(interaction)) {
      await interaction.reply({
        content: 'This command is staff-only.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (adminOnlyCommands.has(interaction.commandName) && !canUseAdminCommand(interaction)) {
      await interaction.reply({
        content: 'This command is admin-only.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'radio') {
      const action = interaction.options.getSubcommand();

      if (action === 'play') {
        const memberVoiceChannel = await getInteractionVoiceChannel(interaction);

        if (!memberVoiceChannel) {
          await interaction.reply({
            content: 'Join a voice channel first, then run /radio play.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
        const missingPermissions = getMissingVoicePermissions(memberVoiceChannel, botMember);

        if (missingPermissions.length > 0) {
          await interaction.reply({
            content: `I cannot join <#${memberVoiceChannel.id}>. Missing permissions: ${missingPermissions.join(', ')}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!isVoiceConnectionReady() && (
          player.state.status === AudioPlayerStatus.Playing
          || player.state.status === AudioPlayerStatus.Buffering
          || player.state.status === AudioPlayerStatus.Paused
        )) {
          disconnectFromVoice(interaction.guildId);
        }

        try {
          await connectToVoiceChannel(memberVoiceChannel);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || 'Unknown voice error.');
          await interaction.reply({
            content: `I could not join <#${memberVoiceChannel.id}>. ${truncateText(message, 140)}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (shuffleQueue.length === 0) {
          refillShuffleQueue();
        }

        const alreadyPlaying =
          player.state.status === AudioPlayerStatus.Playing ||
          player.state.status === AudioPlayerStatus.Buffering;

        if (!alreadyPlaying) {
          playNext();
        }

        const nowPlayingText = currentTrack
          ? `Now playing: **${displayName(currentTrack)}**`
          : 'Playback is ready.';

        await interaction.reply({
          content: `Joined <#${memberVoiceChannel.id}>. ${nowPlayingText}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'stop') {
        const activeConnection = getVoiceConnection(interaction.guildId) || connection;
        if (!activeConnection) {
          await interaction.reply({
            content: 'Already disconnected.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        disconnectFromVoice(interaction.guildId);

        await interaction.reply({
          content: 'Stopped playback and disconnected from voice.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === 'nowplaying') {
        const text = currentTrack
          ? currentRequestedBy
            ? `Now playing: **${displayName(currentTrack)}** (requested by ${currentRequestedBy})`
            : `Now playing: **${displayName(currentTrack)}**`
          : 'Nothing is playing right now.';

        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === 'skip') {
        if (!currentTrack) {
          await interaction.reply({ content: 'Nothing is playing right now.', flags: MessageFlags.Ephemeral });
          return;
        }

        playNext();
        await interaction.reply({
          content: `Skipped. Now playing: **${displayName(currentTrack)}**`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'queue') {
        const upcoming = buildPreviewQueue(5);
        const text = upcoming.length
          ? upcoming.map((track, index) => `${index + 1}. ${displayName(track)}`).join('\n')
          : 'No upcoming tracks found.';

        await interaction.reply({
          content: `**Next 5 tracks**\n${text}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'library') {
        const pageSize = 10;
        const page = interaction.options.getInteger('page') || 1;
        const search = (interaction.options.getString('search') || '').trim().toLowerCase();

        let library = readLibrary();
        if (search) {
          library = library.filter((track) => displayName(track).toLowerCase().includes(search));
        }

        if (library.length === 0) {
          await interaction.reply({
            content: search ? `No tracks found for **${search}**.` : 'The library is empty.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const totalPages = Math.max(1, Math.ceil(library.length / pageSize));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * pageSize;
        const pageItems = library.slice(start, start + pageSize);

        const body = pageItems
          .map((track, index) => `${start + index + 1}. ${displayName(track)}`)
          .join('\n');

        const heading = search
          ? `**Library search: ${search} — Page ${safePage} of ${totalPages}**`
          : `**Library — Page ${safePage} of ${totalPages}**`;

        await interaction.reply({
          content: `${heading}\n${body}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'request') {
        const query = interaction.options.getString('track', true);
        const result = matchTrack(query);

        if (!result.match) {
          if (result.suggestions.length > 0) {
            const suggestions = result.suggestions
              .map((track, index) => `${index + 1}. ${displayName(track)}`)
              .join('\n');

            await interaction.reply({
              content: `More than one track matched **${query}**. Try one of these:\n${suggestions}`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await interaction.reply({
            content: `No track matched **${query}**.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        requestQueue.unshift(result.match);

        await interaction.reply({
          content: `Queued next: **${displayName(result.match)}**`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: 'Unknown radio action.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === 'roll') {
      const { entrants, duplicates } = collectRollEntrants(interaction);

      if (duplicates.length > 0) {
        await interaction.reply({
          content: `Duplicate entrants are not allowed. Remove the repeats and try again. Duplicates: ${duplicates.map((user) => user.toString()).join(', ')}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (entrants.length < 2) {
        await interaction.reply({
          content: 'Select at least 2 entrants.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const { rounds, winner, resolved } = runRandomRoll(entrants);
      const message = formatRandomRollMessage(
        entrants,
        rounds,
        interaction.user.toString(),
        winner,
        resolved
      );

      await interaction.reply({
        content: message,
      });
      return;
    }

    if (interaction.commandName === 'ops') {
      const action = interaction.options.getSubcommand();
      await interaction.deferReply();

      if (action === 'state') {
        const code = cleanOpCode(interaction.options.getString('code', true));
        const newState = cleanText(interaction.options.getString('state', true)).toLowerCase();
        const payload = await submitSetOpState(code, newState, interaction.user.id);
        await interaction.editReply({ content: formatSetOpStateMessage(payload, interaction.user.toString()) });
        return;
      }

      if (action === 'time') {
        const code = cleanOpCode(interaction.options.getString('code', true));
        const year = interaction.options.getInteger('year', true);
        const month = interaction.options.getInteger('month', true);
        const day = interaction.options.getInteger('day', true);
        const hour = interaction.options.getInteger('hour', true);
        const minute = interaction.options.getInteger('minute', true);
        const payload = await submitSetOpTime(code, year, month, day, hour, minute, interaction.user.id);
        await interaction.editReply({ content: formatSetOpTimeMessage(payload, interaction.user.toString()) });
        return;
      }

      if (action === 'remind') {
        const code = cleanOpCode(interaction.options.getString('code', true));
        const timing = cleanText(interaction.options.getString('timing', true)).toLowerCase();
        const payload = await submitForceOpReminder(code, timing, interaction.user.id);

        const channel = await interaction.client.channels.fetch(opsReminderChannelId);
        if (!channel?.isTextBased?.()) {
          throw new Error(`Ops reminder channel is not text-based: ${opsReminderChannelId}`);
        }

        const sentMessage = await channel.send({
          content: `@here **Black Hull Ops Reminder — ${formatReminderLabel(timing)} call — ${cleanOpCode(payload?.op?.opCode) || code || 'BH-????'}**`,
          allowedMentions: { parse: ['everyone'] },
          embeds: [buildOpsReminderEmbed(payload?.op || {}, timing)],
        });

        await trackOpsReminderMessage({
          channel,
          opId: payload?.op?.id,
          startTime: payload?.op?.startTime,
          timingKey: reminderTimingToWindowKey(timing),
          sentMessage,
          markSent: timing !== 'now',
        });

        await interaction.editReply({
          content: formatForceOpReminderMessage(payload, interaction.user.toString(), `<#${opsReminderChannelId}>`, sentMessage?.url),
        });
        return;
      }

      if (action === 'repost') {
        const code = cleanOpCode(interaction.options.getString('code', true));
        const payload = await submitRepostOp(code, interaction.user.id);
        await interaction.editReply({
          content: formatRepostOpMessage(payload, interaction.user.toString(), `<#${opsReminderChannelId}>`),
        });
        return;
      }
    }

    if (interaction.commandName === 'memberadmin') {
      const action = interaction.options.getSubcommand();
      const adminOnlyActions = new Set(['authcheck', 'lookup', 'removed']);
      if (adminOnlyActions.has(action) && !canUseAdminCommand(interaction)) {
        await interaction.reply({
          content: 'This subcommand is admin-only.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (action === 'setrank') {
        const member = interaction.options.getUser('member', true);
        const rankTitle = cleanText(interaction.options.getString('rank', true));
        const payload = await submitSetRank(member.id, rankTitle, interaction.user.id);
        await interaction.editReply({
          content: formatSetRankMessage(payload, interaction.user.toString(), member.toString()),
        });
        return;
      }

      if (action === 'authcheck') {
        const member = interaction.options.getUser('member', true);
        const payload = await fetchAuthCheck(member.id, interaction.user.id);
        await interaction.editReply(formatAuthCheckMessage(payload, member, interaction.guild));
        return;
      }

      if (action === 'lookup') {
        const member = interaction.options.getUser('member', true);
        const [authResult, memberResult, removedResult] = await Promise.allSettled([
          fetchAuthCheck(member.id, interaction.user.id),
          fetchMemberLookup(member.id, interaction.user.id),
          fetchRemoved(member.id, interaction.user.id),
        ]);

        const authPayload = authResult.status === 'fulfilled' ? authResult.value : {};
        const memberPayload = memberResult.status === 'fulfilled' ? memberResult.value : {};
        const removedPayload = removedResult.status === 'fulfilled' ? removedResult.value : {};

        await interaction.editReply(
          formatMemberLookupMessage(
            {
              authPayload,
              memberPayload,
              removedPayload,
              authError: authResult.status === 'rejected'
                ? summarizeSettledError(authResult.reason, 'Auth check failed.')
                : '',
              memberError: memberResult.status === 'rejected'
                ? summarizeSettledError(memberResult.reason, 'Website file lookup failed.')
                : '',
              removedError: removedResult.status === 'rejected'
                ? summarizeSettledError(removedResult.reason, 'Removed-roster lookup failed.')
                : '',
            },
            member,
            interaction.guild,
          ),
        );
        return;
      }

      if (action === 'removed') {
        const member = interaction.options.getUser('member');
        const payload = await fetchRemoved(member?.id || '', interaction.user.id);
        await interaction.editReply(formatRemovedMessage(payload, member));
        return;
      }
    }

    if (interaction.commandName === 'fleet') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const action = interaction.options.getSubcommand();

      if (action === 'ships') {
        const member = interaction.options.getUser('member', true);
        const payload = await fetchMemberShips(member.id);
        await interaction.editReply(formatMemberShipsMessage(payload.member));
        return;
      }

      if (action === 'summary') {
        const payload = await fetchFleetSummary();
        await interaction.editReply(formatFleetSummaryMessage(payload));
        return;
      }

      if (action === 'ship') {
        const shipQuery = cleanText(interaction.options.getString('ship', true));
        const payload = await fetchFleetShipDetail(shipQuery);
        await interaction.editReply(formatFleetShipDetailMessage(payload, shipQuery));
        return;
      }

      if (action === 'roster') {
        const status = cleanText(interaction.options.getString('status'));
        const payload = await fetchRoster(status);
        await interaction.editReply(formatRosterMessage(payload, status));
        return;
      }
    }

    if (interaction.commandName === 'system') {
      const action = interaction.options.getSubcommand();
      const adminOnlyActions = new Set(['queue', 'restart']);
      if (adminOnlyActions.has(action) && !canUseAdminCommand(interaction)) {
        await interaction.reply({
          content: 'This subcommand is admin-only.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === 'status') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({
          content: await formatBotStatusMessage(client),
        });
        return;
      }

      if (action === 'queue') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const payload = await fetchAdminQueue(interaction.user.id);
        await interaction.editReply(formatAdminQueueMessage(payload));
        return;
      }

      if (action === 'restart') {
        const confirm = cleanText(interaction.options.getString('confirm', true));
        if (confirm !== 'restart') {
          await interaction.reply({
            content: 'Confirmation failed. Use `/system restart confirm:restart`.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: 'Restarting **Black Hull Broadcast** now. pm2 should bring me back in a few seconds.',
          flags: MessageFlags.Ephemeral,
        });

        setTimeout(() => {
          console.log(`Bot restart requested by ${interaction.user.tag}`);
          process.exit(0);
        }, 1500);
        return;
      }
    }

    if (interaction.commandName === 'partykey') {
      const ownerId = partyKeyOwnerUserId || interaction.guild?.ownerId;
      if (!ownerId || interaction.user.id !== ownerId) {
        await interaction.reply({
          content: 'Only the designated party key owner can run this command.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sub    = interaction.options.getSubcommand();
      if (sub === 'generate') {
        const target = interaction.options.getUser('member', true);
        const key = generateKeyForUser(target.id);
        try {
          await target.send(
            `**Black Hull SnareHound — Party API Key**\n` +
            `Your personal key has been generated (or replaced).\n\n` +
            `\`\`\`\n${key}\n\`\`\`\n` +
            `Enter this in the SnareHound Party System settings along with the bot URL.\n` +
            `Keep this private — do not share it.`
          );
          await interaction.reply({
            content: `Party key generated for ${target.toString()} and sent via DM.`,
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          await interaction.reply({
            content: `Key generated but DM failed (${target.toString()} may have DMs disabled).\n\nKey (share privately):\n\`${key}\``,
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      if (sub === 'revoke') {
        const target = interaction.options.getUser('member', true);
        const revoked = revokeKeyForUser(target.id);
        await interaction.reply({
          content: revoked
            ? `Party key revoked for ${target.toString()}. Their SnareHound will stop syncing.`
            : `${target.toString()} did not have an active party key.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === 'revokeall') {
        const revokedCount = revokeAllKeys();
        await interaction.reply({
          content: `Revoked **${revokedCount}** party key${revokedCount === 1 ? '' : 's'}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.commandName === 'leaderboard') {
      const allowedChannelId = '1487965611685314700'; // #bot-commands-here
      if (interaction.channelId !== allowedChannelId) {
        await interaction.reply({
          content: `The leaderboard can only be used in <#${allowedChannelId}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      const period = interaction.options.getString('period') ?? 'month';
      const isAllTime = period === 'alltime';

      let rows = [];
      try {
        const data = await fetchSiteJson('/api/internal/leaderboard', { period });
        rows = data?.entries ?? [];
      } catch (err) {
        console.error('[leaderboard] fetch error:', err);
        await interaction.editReply('Failed to fetch leaderboard data. Try again shortly.');
        return;
      }

      if (!rows.length) {
        await interaction.editReply('No activity data recorded yet.');
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = rows.slice(0, 10).map((entry, i) => {
        const prefix  = medals[i] ?? `**${i + 1}.**`;
        const name    = entry.rsiName || entry.discordName || entry.discordUserId;
        const hours   = entry.totalHours != null   ? `${entry.totalHours}h` : null;
        const msgs    = entry.totalMessages != null ? `${entry.totalMessages} msgs` : null;
        const stats   = [hours, msgs].filter(Boolean).join(' · ');
        return `${prefix} **${name}** — ${stats}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`BHS Activity Leaderboard — ${isAllTime ? 'All Time' : 'This Month'}`)
        .setDescription(lines.join('\n'))
        .setColor(0x8b0000)
        .setFooter({ text: 'Black Hull Syndicate' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    await interaction.reply({
      content: 'Unknown command.',
      flags: ephemeralCommands.has(interaction.commandName) ? MessageFlags.Ephemeral : undefined,
    });
  } catch (error) {
    console.error(error);

    const fallbackEphemeral = ephemeralCommands.has(interaction.commandName);
    const message = error instanceof Error ? error.message : 'Something went wrong.';

    try {
      if (interaction.replied) {
        await interaction.followUp({
          content: message,
          flags: fallbackEphemeral ? MessageFlags.Ephemeral : undefined,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({ content: message });
      } else {
        await interaction.reply({
          content: message,
          flags: fallbackEphemeral ? MessageFlags.Ephemeral : undefined,
        });
      }
    } catch {
      // Interaction may have expired (Discord error 10062) — nothing to do.
    }
  }
});

startInternalApi({
  port: mediaSyncPort,
  client,
  handlers: {
    runSystemHeartbeat: () => runSystemHeartbeatRecoveryAction(client),
    runOpsReminderPoll: () => runOpsReminderPollRecoveryAction(client),
    listPartyKeys: () => listKeys({ mask: false }),
    generatePartyKey: (userId, options = {}) => generateKeyForUser(userId, { assignedBy: options.actorUserId }),
    revokePartyKey: (userId) => revokeKeyForUser(userId),
    revokeAllPartyKeys: ({ actorUserId } = {}) => {
      const ownerId = partyKeyOwnerUserId || guildId;
      if (partyKeyOwnerUserId && actorUserId !== partyKeyOwnerUserId) {
        throw new Error('Only the designated owner can revoke all keys');
      }
      const revokedCount = revokeAllKeys();
      return { revokedCount, actorUserId: actorUserId || ownerId || null };
    },
  },
});
internalApiStartedAt = new Date().toISOString();

startPartyApi(partyApiPort);

// ── Activity tracking events ──────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  activityTracker.onVoiceStateUpdate(oldState, newState).catch((err) => {
    console.error('[activity-tracker] voiceStateUpdate error:', err);
  });
});

client.on(Events.PresenceUpdate, (oldPresence, newPresence) => {
  activityTracker.onPresenceUpdate(oldPresence, newPresence).catch((err) => {
    console.error('[activity-tracker] presenceUpdate error:', err);
  });
});

client.on(Events.MessageCreate, (message) => {
  activityTracker.onMessageCreate(message).catch((err) => {
    console.error('[activity-tracker] messageCreate error:', err);
  });
});

client.on(Events.GuildMemberAdd, (member) => {
  activityTracker.onGuildMemberAdd(member).catch((err) => {
    console.error('[activity-tracker] guildMemberAdd error:', err);
  });
});

client.on(Events.GuildMemberRemove, (member) => {
  activityTracker.onGuildMemberRemove(member).catch((err) => {
    console.error('[activity-tracker] guildMemberRemove error:', err);
  });
});

process.once('SIGTERM', async () => {
  await activityTracker.closeAllSessions();
  process.exit(0);
});

process.once('SIGINT', async () => {
  await activityTracker.closeAllSessions();
  process.exit(0);
});

client.login(token);
